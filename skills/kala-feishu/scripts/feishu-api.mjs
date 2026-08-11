/**
 * feishu-api.mjs —— 供 feishu-drive.mjs / feishu-wiki.mjs 复用的最小 API 客户端。
 *
 * - userToken():   通过 feishu-oauth.mjs 管家拿 user_access_token(进程内缓存)
 * - tenantToken(): 用 App 凭证换 tenant_access_token(部分权限接口需要)
 * - api():         带鉴权的 fetch 封装,飞书 code!=0 时抛出可读错误
 */
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { FEISHU_BASE, loadAppCredentials } from './feishu-config.mjs';

const OAUTH = fileURLToPath(new URL('./feishu-oauth.mjs', import.meta.url));

let _userToken = null;
/** 拿可用的 user_access_token(自动 refresh,进程内缓存)。 */
export function userToken() {
  if (_userToken) return _userToken;
  let t;
  try {
    t = execFileSync(process.execPath, [OAUTH, 'get'], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'], // 吞掉子进程 stderr,只给一条干净提示
    }).trim();
  } catch {
    t = '';
  }
  if (!t) throw new Error('拿不到 user token,请先运行: node feishu-oauth.mjs auth(或 status 查看状态)');
  _userToken = t;
  return t;
}

/** 清掉进程内缓存的 user token(强制 refresh 之后必须调,否则缓存的旧 token 已失效)。 */
export function resetUserToken() { _userToken = null; }

let _tenantToken = null;
/** 拿 tenant_access_token(机器人身份;设公开权限等接口需要)。 */
export async function tenantToken() {
  if (_tenantToken) return _tenantToken;
  const { appId, appSecret } = loadAppCredentials();
  const r = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`tenant token error ${d.code}: ${d.msg}`);
  _tenantToken = d.tenant_access_token;
  return _tenantToken;
}

// ── 网络瞬时失败的重试 ───────────────────────────────────────────
//
// 只重试**网络层**错误(连接被重置/超时/DNS 抖动)。飞书返回的业务错误码
// (权限不足、参数错、找不到对象)重试多少次都是同样结果,直接抛。

const RETRY_ATTEMPTS = 2;   // 首次之外再试 2 次
const RETRY_BASE_MS = 400;  // 退避:第 1 次等 400ms,第 2 次 800ms

const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

function isTransientNetworkError(e) {
  if (!e) return false;
  if (TRANSIENT_CODES.has(e.cause?.code) || TRANSIENT_CODES.has(e.code)) return true;
  return /fetch failed|socket hang up|network|timeout/i.test(e.message || '');
}

/**
 * 飞书业务错误码里,少数是「资源还没就绪 / 稍后再试」——它们表示请求**压根没被执行**,
 * 所以**无条件重试都安全**,连非幂等的 POST 也不会写出两份。
 *
 * 2890007: 刚插入的画板后端还在异步初始化,立刻读写节点会撞上;
 *          「插入画板 → 马上写节点」正是最自然的用法,不重试就会间歇性失败。
 */
const RETRYABLE_FEISHU_CODES = new Set([2890007]);

/** 这个错误值得再试一次吗? */
function shouldRetry(e) {
  if (e?.feishuCode !== undefined) return RETRYABLE_FEISHU_CODES.has(e.feishuCode);
  return isTransientNetworkError(e);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 这个请求重复执行一遍,结果是否相同?
 *   GET    读,天然幂等
 *   PUT    写固定值到固定位置,写两遍结果一样
 *   DELETE 删两遍等于删一遍
 *   POST   默认**不**幂等 —— 建表格/追加行/新增记录重试就会多出一份。
 *          只读的 POST(如多维表格的 records/search)由调用方显式 retryable: true。
 */
function defaultRetryable(method) {
  return method === 'GET' || method === 'PUT' || method === 'DELETE';
}

/**
 * 带鉴权的请求。默认用 user token。
 * @param {string} method  GET/POST/DELETE/PATCH/PUT
 * @param {string} path    以 / 开头,拼在 FEISHU_BASE 之后
 * @param {object} opts    { query, body, token, retryable }
 *                         retryable 显式声明本请求重复执行是否安全(不传按 method 推断)
 * @returns 飞书响应的 data 字段
 */
export async function api(method, path, opts = {}) {
  const { query, body } = opts;
  const token = opts.token || userToken();
  const retryable = opts.retryable ?? defaultRetryable(method);
  const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  // 上限按最宽的算;非幂等请求遇到网络错会在下面提前退出,遇到「未就绪」类业务码则继续重试
  const maxAttempts = RETRY_ATTEMPTS + 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(RETRY_BASE_MS * (attempt - 1));
    try {
      const r = await fetch(`${FEISHU_BASE}${path}${qs}`, init);
      const d = await r.json();
      if (d.code !== 0) {
        const err = new Error(`Feishu ${d.code}: ${d.msg} [${method} ${path}]`);
        err.feishuCode = d.code; // 供 shouldRetry 判断是否属「稍后再试」类
        throw err;
      }
      return d.data;
    } catch (e) {
      if (!shouldRetry(e)) throw e; // 普通业务错误(权限/参数):重试无意义
      lastErr = e;
      // 网络中断且请求非幂等 → 不能重发(可能已执行、只是响应丢了)。
      // 「未就绪」类业务码不受此限:它表示压根没执行,重发安全。
      if (e.feishuCode === undefined && !retryable) {
        throw new Error(
          `网络中断: ${e.message} [${method} ${path}] —— 这是非幂等请求,**可能已生效**,` +
          '故不自动重试。请先核对现状(读一次看数据在不在)再决定是否重发。'
        );
      }
    }
  }
  const why = lastErr.feishuCode !== undefined ? lastErr.message : `网络中断: ${lastErr.message}`;
  throw new Error(`${why} [${method} ${path}] —— 已重试 ${RETRY_ATTEMPTS} 次仍失败。`);
}

/** multipart/form-data 上传(飞书上传接口用)。fields: [[name, value, {filename, contentType}?], ...] */
export async function uploadMultipart(path, fields, token) {
  const t = token || userToken();
  const boundary = '----KalaFeishuBoundary' + process.pid.toString(36) + fields.length;
  const parts = [];
  for (const [name, value, o] of fields) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
    if (o?.filename) header += `; filename="${o.filename}"`;
    header += '\r\n';
    if (o?.contentType) header += `Content-Type: ${o.contentType}\r\n`;
    header += '\r\n';
    parts.push(Buffer.from(header, 'utf8'));
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const r = await fetch(`${FEISHU_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`Feishu ${d.code}: ${d.msg} [UPLOAD ${path}]`);
  return d.data;
}

/** 统一的 CLI 输出:成功打印 JSON,失败打印错误并退出 1。 */
export function printResult(data) {
  console.log(JSON.stringify(data, null, 2));
}
export function fail(e) {
  console.error('❌', e?.message || e);
  process.exit(1);
}
