/**
 * feishu-route.mjs —— 按飞书 URL 的租户自动选对账号。
 *
 * 多账号(多租户)时,给一个飞书 URL / token,自动挑出**能访问它**的账号,
 * 并写进 process.env.KALA_FEISHU_ACCOUNT 供后续脚本使用。选择顺序:
 *   1. 显式设了 KALA_FEISHU_ACCOUNT → 用它(显式优先)
 *   2. routing.json(域名→账号)命中 → 用它
 *   3. 挨个已授权账号探测,谁能访问就用谁,并把「域名→账号」记进 routing.json(下次直接命中)
 *   4. 都不行 → 回落 default,让后续调用报清楚的权限错
 *
 * CLI:
 *   node feishu-route.mjs <url|token>   打印会选哪个账号(调试用,不改动)
 *   node feishu-route.mjs --list        列出账号 + 已学习的域名路由
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { feishuHome, ensureHome, FEISHU_BASE } from './feishu-config.mjs';

const OAUTH = fileURLToPath(new URL('./feishu-oauth.mjs', import.meta.url));

export function domainOf(url) {
  const m = String(url || '').match(/https?:\/\/([^/]+)/);
  return m ? m[1].toLowerCase() : null;
}

export function listAccounts() {
  try {
    return readdirSync(feishuHome())
      .filter(f => f.endsWith('.token.json'))
      .map(f => f.replace(/\.token\.json$/, '')).sort();
  } catch { return []; }
}

function routingFile() { return join(feishuHome(), 'routing.json'); }
export function loadRouting() { try { return JSON.parse(readFileSync(routingFile(), 'utf8')); } catch { return {}; } }
function saveRouting(map) {
  ensureHome();
  writeFileSync(routingFile(), JSON.stringify(map, null, 2), 'utf8');
  try { chmodSync(routingFile(), 0o600); } catch { /* 非致命 */ }
}

function tokenFor(acct) {
  try {
    return execFileSync(process.execPath, [OAUTH, 'get'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, KALA_FEISHU_ACCOUNT: acct },
    }).trim();
  } catch { return ''; }
}

// 该账号能否访问这个 wiki 节点 / docx 文档?(只读探测)
async function canAccess(acct, { wikiToken, docToken }) {
  const t = tokenFor(acct);
  if (!t) return false;
  const path = wikiToken
    ? `/wiki/v2/spaces/get_node?token=${encodeURIComponent(wikiToken)}`
    : `/docx/v1/documents/${docToken}`;
  try {
    const r = await fetch(`${FEISHU_BASE}${path}`, { headers: { Authorization: `Bearer ${t}` } });
    const d = await r.json();
    return d.code === 0;
  } catch { return false; }
}

/**
 * 选账号并写入 process.env.KALA_FEISHU_ACCOUNT。返回 { account, source }。
 * @param {object} o  { url?, wikiToken?, docToken?, quiet? }
 */
export async function autoSelectAccount(o = {}) {
  const { url, wikiToken, docToken, quiet } = o;
  const note = (a, src) => { if (!quiet && src !== 'env') process.stderr.write(`· 自动账号: ${a} (${src})\n`); };

  const explicit = process.env.KALA_FEISHU_ACCOUNT;
  if (explicit) return { account: explicit, source: 'env' };

  const accts = listAccounts();
  if (accts.length <= 1) {
    const a = accts[0] || 'default';
    process.env.KALA_FEISHU_ACCOUNT = a;
    return { account: a, source: accts.length ? 'only' : 'default' };
  }

  const domain = url ? domainOf(url) : null;
  const routing = loadRouting();
  if (domain && routing[domain] && accts.includes(routing[domain])) {
    process.env.KALA_FEISHU_ACCOUNT = routing[domain];
    note(routing[domain], 'routing'); return { account: routing[domain], source: 'routing' };
  }

  if (wikiToken || docToken) {
    for (const acct of accts) {
      if (await canAccess(acct, { wikiToken, docToken })) {
        if (domain) { routing[domain] = acct; saveRouting(routing); }
        process.env.KALA_FEISHU_ACCOUNT = acct;
        note(acct, 'probe'); return { account: acct, source: 'probe' };
      }
    }
  }

  process.env.KALA_FEISHU_ACCOUNT = accts[0];
  note(accts[0], 'fallback-none'); return { account: accts[0], source: 'fallback-none' };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && /feishu-route\.mjs$/.test(process.argv[1]);
if (isMain) {
  const arg = process.argv[2];
  if (!arg || arg === '--list') {
    console.log('账号:', listAccounts().join(', ') || '(无)');
    console.log('已学习的域名路由 (routing.json):');
    const r = loadRouting();
    const keys = Object.keys(r);
    if (!keys.length) console.log('  (空)');
    else for (const k of keys) console.log(`  ${k}  →  ${r[k]}`);
  } else {
    // 探测某 URL 会选哪个账号(不写 env 到别处,仅打印)
    const wikiToken = /\/wiki\//.test(arg) ? arg.match(/\/wiki\/([A-Za-z0-9]+)/)?.[1] : null;
    const docToken = !wikiToken && /\/docx\//.test(arg) ? arg.match(/\/docx\/([A-Za-z0-9]+)/)?.[1] : (wikiToken ? null : arg.split(/[?#]/)[0]);
    const r = await autoSelectAccount({ url: arg, wikiToken, docToken: wikiToken ? null : docToken, quiet: true });
    console.log(JSON.stringify(r, null, 2));
  }
}
