/**
 * feishu-config.mjs —— kala-feishu 的唯一凭证 / 路径解析处。
 *
 * 其余脚本一律通过本模块拿 App 凭证、token 文件路径、目标位置文件路径,
 * 从而与具体 agent 运行时(openclaw / Claude Code / Codex …)彻底解耦。
 *
 * App 凭证解析优先级:
 *   1. <KALA_FEISHU_HOME>/<account>.config.json   → {"appId":"cli_xxx","appSecret":"xxx"}
 *   2. 环境变量 KALA_FEISHU_APP_ID / KALA_FEISHU_APP_SECRET
 *   3. 向后兼容:~/.openclaw/openclaw.json 的 channels.feishu.accounts.<legacy>
 *      (legacy = OPENCLAW_FEISHU_ACCOUNT_ID || 'personal';便于本机从 openclaw 平滑迁移)
 *
 * 运行期数据默认落在 ~/.kala/feishu/(0700),与代码仓库、与 openclaw 都无关:
 *   <account>.config.json   App 凭证(用户提供,600)
 *   <account>.token.json    OAuth user token(feishu-oauth.mjs 管理)
 *   <account>.targets.json  记住的目标位置(云盘 folder_token / 知识库 space_id 等)
 *
 * ⚠️ token 不做旧路径回落:refresh_token 一次性,若新旧两处共用同一 token 家族并各自 refresh
 *    会互相作废。每台设备/每次部署走一次 `feishu-oauth.mjs auth` 拿独立 token 家族即可。
 */
import { readFileSync, existsSync, mkdirSync, chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function feishuHome() {
  return process.env.KALA_FEISHU_HOME || join(homedir(), '.kala', 'feishu');
}

export function account() {
  return process.env.KALA_FEISHU_ACCOUNT || 'personal';
}

/** 确保 home 目录存在且为 0700,返回其路径 */
export function ensureHome() {
  const home = feishuHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  try { chmodSync(home, 0o700); } catch { /* 非致命 */ }
  return home;
}

export function configFile()  { return join(feishuHome(), `${account()}.config.json`); }
export function tokenFile()   { return join(feishuHome(), `${account()}.token.json`); }
export function targetsFile() { return join(feishuHome(), `${account()}.targets.json`); }

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

function legacyOpenclawCreds() {
  const p = join(homedir(), '.openclaw', 'openclaw.json');
  if (!existsSync(p)) return null;
  try {
    const cfg = readJson(p);
    const id = process.env.OPENCLAW_FEISHU_ACCOUNT_ID || 'personal';
    const acc = cfg.channels?.feishu?.accounts?.[id];
    if (acc?.appId && acc?.appSecret) {
      return { appId: acc.appId, appSecret: acc.appSecret, _source: `openclaw.json:${id}` };
    }
  } catch { /* 忽略,继续兜底链 */ }
  return null;
}

/** 返回 { appId, appSecret, _source }。找不到则抛出带指引的错误。 */
export function loadAppCredentials() {
  const cf = configFile();
  if (existsSync(cf)) {
    const c = readJson(cf);
    if (c.appId && c.appSecret) return { appId: c.appId, appSecret: c.appSecret, _source: cf };
  }
  if (process.env.KALA_FEISHU_APP_ID && process.env.KALA_FEISHU_APP_SECRET) {
    return {
      appId: process.env.KALA_FEISHU_APP_ID,
      appSecret: process.env.KALA_FEISHU_APP_SECRET,
      _source: 'env',
    };
  }
  const legacy = legacyOpenclawCreds();
  if (legacy) return legacy;

  throw new Error(
    `找不到飞书 App 凭证。请任选其一:\n` +
    `  1) 写入 ${cf}\n` +
    `     {"appId": "cli_xxxx", "appSecret": "xxxx"}\n` +
    `  2) 设置环境变量 KALA_FEISHU_APP_ID / KALA_FEISHU_APP_SECRET\n` +
    `参见 references/setup-guide.md。`
  );
}

/** 写 App 凭证到 <account>.config.json(0600)。供部署脚本/SKILL.md 引导时调用。 */
export function saveAppCredentials(appId, appSecret) {
  ensureHome();
  const cf = configFile();
  writeFileSync(cf, JSON.stringify({ appId, appSecret }, null, 2), 'utf8');
  try { chmodSync(cf, 0o600); } catch { /* 非致命 */ }
  return cf;
}

/** 读记住的目标位置(不存在返回 {})。 */
export function loadTargets() {
  const f = targetsFile();
  if (!existsSync(f)) return {};
  try { return readJson(f); } catch { return {}; }
}

/** 合并写入目标位置。 */
export function saveTargets(patch) {
  ensureHome();
  const f = targetsFile();
  const merged = { ...loadTargets(), ...patch };
  writeFileSync(f, JSON.stringify(merged, null, 2), 'utf8');
  try { chmodSync(f, 0o600); } catch { /* 非致命 */ }
  return merged;
}

export const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
export const OAUTH_CALLBACK_PORT = 9876;
export const OAUTH_CALLBACK_PATH = '/callback';

// CLI:`node feishu-config.mjs` 打印当前解析结果(不回显 secret),便于部署自检。
const isMain = process.argv[1] && /feishu-config\.mjs$/.test(process.argv[1]);
if (isMain) {
  const out = {
    KALA_FEISHU_HOME: feishuHome(),
    account: account(),
    configFile: configFile(),
    tokenFile: tokenFile(),
    targetsFile: targetsFile(),
  };
  try {
    const c = loadAppCredentials();
    out.appId = c.appId;
    out.appSecret = c.appSecret ? `***(${c.appSecret.length} chars)` : '(缺失)';
    out.credSource = c._source;
  } catch (e) {
    out.credError = e.message;
  }
  console.log(JSON.stringify(out, null, 2));
}
