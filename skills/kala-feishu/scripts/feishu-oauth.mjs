/**
 * feishu-oauth.mjs —— 飞书 OAuth 用户 Token 管家(唯一的 token 管理入口)
 *
 * ⚠️ 规则:所有需要 user_access_token 的地方,必须通过本脚本获取。
 *    禁止任何代码直接调用飞书 refresh API。
 *    refresh_token 是一次性的,绕过管家会导致 token 链断裂(旧 token 作废但新 token 没写回文件)。
 *
 * 用法:
 *   node feishu-oauth.mjs get       # 获取可用的 access_token(自动 refresh)← 消费者用这个
 *   node feishu-oauth.mjs refresh   # 强制刷新 token
 *   node feishu-oauth.mjs auth      # 重新 OAuth 授权(首次 / refresh_token 失效时用)
 *   node feishu-oauth.mjs status    # 查看 token 状态
 *
 * 凭证与 token 路径均由 feishu-config.mjs 统一解析(与 openclaw 解耦)。
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { createServer } from 'http';
import {
  loadAppCredentials, tokenFile, account, ensureHome,
  FEISHU_BASE, OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH,
} from './feishu-config.mjs';

const PASSPORT = 'https://passport.feishu.cn/suite/passport/oauth';
const TOKEN_FILE = tokenFile();
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;

function loadTokens() {
  if (!existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

function saveTokens(data) {
  ensureHome();
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf8');
  try { chmodSync(TOKEN_FILE, 0o600); } catch { /* 非致命 */ }
}

async function exchangeCode(code, appId, appSecret) {
  const r = await fetch(`${PASSPORT}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Exchange failed: ${JSON.stringify(d)}`);
  return d;
}

async function refreshToken(refreshTk, appId, appSecret) {
  const r = await fetch(`${PASSPORT}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshTk,
      client_id: appId,
      client_secret: appSecret,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(`Refresh failed: ${JSON.stringify(d)}`);
  return d;
}

async function getUserInfo(accessToken) {
  const r = await fetch(`${PASSPORT}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return await r.json();
}

function pack(tokenData, base = {}) {
  const now = Date.now();
  return {
    ...base,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    refresh_expires_in: tokenData.refresh_expires_in,
    obtained_at: now,
    access_expires_at: now + tokenData.expires_in * 1000,
    refresh_expires_at: now + tokenData.refresh_expires_in * 1000,
  };
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdAuth() {
  const { appId, appSecret } = loadAppCredentials();
  const redirectUri = encodeURIComponent(REDIRECT_URI);
  // 本地 loopback 单次授权,state 仅作标识(回调不校验),固定值即可
  const state = `kala-${account()}`;
  const authUrl = `${PASSPORT}/authorize?client_id=${appId}&redirect_uri=${redirectUri}&response_type=code&state=${state}`;

  console.log('\n=== 飞书 OAuth 授权 ===');
  console.log('\n请在浏览器中打开以下链接并授权:\n');
  console.log(authUrl);
  console.log(`\n(回调地址 ${REDIRECT_URI} 必须已在开发者后台「安全设置」里登记)`);
  console.log('\n等待回调中...\n');

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${OAUTH_CALLBACK_PORT}`);
      if (url.pathname !== OAUTH_CALLBACK_PATH) { res.writeHead(404); res.end('Not found'); return; }

      const code = url.searchParams.get('code');
      if (!code) { res.writeHead(400); res.end('Missing code'); return; }

      try {
        console.log('收到授权码,正在换取 token...');
        const tokenData = await exchangeCode(code, appId, appSecret);
        const saved = pack(tokenData);
        try {
          const userInfo = await getUserInfo(tokenData.access_token);
          saved.user_name = userInfo.name;
          saved.user_open_id = userInfo.open_id;
          console.log(`用户: ${userInfo.name} (${userInfo.open_id})`);
        } catch (e) {
          console.log('获取用户信息失败(不影响 token):', e.message);
        }
        saveTokens(saved);
        console.log('✅ Token 已保存到:', TOKEN_FILE);
        console.log(`   access_token 有效期: ${tokenData.expires_in}s`);
        console.log(`   refresh_token 有效期: ${(tokenData.refresh_expires_in / 86400).toFixed(1)} 天`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>✅ 授权成功!</h1><p>可以关闭这个页面了。</p></body></html>');
      } catch (e) {
        console.error('❌ 换取 token 失败:', e.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h1>❌ 授权失败</h1><p>${e.message}</p></body></html>`);
      }
      server.close();
      resolve();
    });
    server.listen(OAUTH_CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`回调服务已启动: ${REDIRECT_URI}`);
    });
  });
}

async function cmdRefresh() {
  const { appId, appSecret } = loadAppCredentials();
  const tokens = loadTokens();
  if (!tokens?.refresh_token) {
    console.error('❌ 没有找到 refresh_token,请先运行: node feishu-oauth.mjs auth');
    process.exit(1);
  }
  if (tokens.refresh_expires_at && Date.now() > tokens.refresh_expires_at) {
    console.error('❌ refresh_token 已过期,请重新授权: node feishu-oauth.mjs auth');
    process.exit(1);
  }
  console.log('正在刷新 token...');
  const newData = await refreshToken(tokens.refresh_token, appId, appSecret);
  const saved = pack(newData, tokens);
  saveTokens(saved);
  console.log('✅ Token 刷新成功');
  console.log(`   access_token 有效至: ${new Date(saved.access_expires_at).toLocaleString()}`);
  console.log(`   refresh_token 有效至: ${new Date(saved.refresh_expires_at).toLocaleString()}`);
}

async function cmdGet() {
  const tokens = loadTokens();
  if (!tokens?.access_token) {
    console.error('❌ 没有 token,请先运行: node feishu-oauth.mjs auth');
    process.exit(1);
  }
  const now = Date.now();
  const BUFFER_MS = 5 * 60 * 1000; // 提前 5 分钟刷新

  if (tokens.access_expires_at && (tokens.access_expires_at - now) > BUFFER_MS) {
    console.log(tokens.access_token);
    return;
  }
  if (!tokens.refresh_token) {
    console.error('❌ access_token 已过期且没有 refresh_token,请运行: node feishu-oauth.mjs auth');
    process.exit(1);
  }
  if (tokens.refresh_expires_at && now > tokens.refresh_expires_at) {
    console.error('❌ refresh_token 已过期,请重新授权: node feishu-oauth.mjs auth');
    process.exit(1);
  }
  const { appId, appSecret } = loadAppCredentials();
  try {
    const newData = await refreshToken(tokens.refresh_token, appId, appSecret);
    const saved = pack(newData, tokens);
    saveTokens(saved);
    console.log(saved.access_token);
  } catch (e) {
    console.error(`❌ 自动 refresh 失败: ${e.message}`);
    console.error('请运行: node feishu-oauth.mjs auth');
    process.exit(1);
  }
}

async function cmdStatus() {
  const tokens = loadTokens();
  if (!tokens) {
    console.log(`❌ 没有找到 token 文件(${TOKEN_FILE}),请先运行: node feishu-oauth.mjs auth`);
    return;
  }
  const now = Date.now();
  const accessOk = tokens.access_expires_at > now;
  const refreshOk = tokens.refresh_expires_at > now;
  const accessLeft = Math.max(0, Math.round((tokens.access_expires_at - now) / 1000));
  const refreshLeft = Math.max(0, Math.round((tokens.refresh_expires_at - now) / 86400000 * 10) / 10);

  console.log(`=== Token 状态(account=${account()})===`);
  if (tokens.user_name) console.log(`用户: ${tokens.user_name} (${tokens.user_open_id})`);
  console.log(`access_token:  ${accessOk ? '✅ 有效' : '❌ 已过期'} (剩余 ${accessLeft}s)`);
  console.log(`refresh_token: ${refreshOk ? '✅ 有效' : '❌ 已过期'} (剩余 ${refreshLeft} 天)`);
  console.log(`token 文件: ${TOKEN_FILE}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
const [,, cmd] = process.argv;
switch (cmd) {
  case 'get': await cmdGet(); break;
  case 'auth': await cmdAuth(); break;
  case 'refresh': await cmdRefresh(); break;
  case 'status': await cmdStatus(); break;
  default:
    console.log('用法: node feishu-oauth.mjs <get|auth|refresh|status>');
    console.log('  get      获取可用的 access_token(自动 refresh,消费者用这个)');
    console.log('  auth     重新 OAuth 授权(首次 / refresh_token 失效时)');
    console.log('  refresh  强制刷新 token');
    console.log('  status   查看 token 状态');
    process.exit(1);
}
