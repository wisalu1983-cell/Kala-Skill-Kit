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

/**
 * 带鉴权的请求。默认用 user token。
 * @param {string} method  GET/POST/DELETE/PATCH/PUT
 * @param {string} path    以 / 开头,拼在 FEISHU_BASE 之后
 * @param {object} opts    { query, body, token }
 * @returns 飞书响应的 data 字段
 */
export async function api(method, path, opts = {}) {
  const { query, body } = opts;
  const token = opts.token || userToken();
  const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${FEISHU_BASE}${path}${qs}`, init);
  const d = await r.json();
  if (d.code !== 0) throw new Error(`Feishu ${d.code}: ${d.msg} [${method} ${path}]`);
  return d.data;
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
