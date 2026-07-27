/**
 * feishu-scope-plan.mjs —— 多组织权限对齐规划器。
 *
 * 用飞书 `/application/v6/scopes` **精确读出**每个应用已授权的权限清单(比功能探针准),
 * 与「云文档标准集」比对,为每个应用生成一份**目标终态** JSON,供你在开发者后台
 * 「权限管理 → 导入」直接粘贴。
 *
 * 为什么生成「终态」而不是「差量」:飞书导入究竟是**追加**还是**覆盖**不确定。
 * 终态 = 该应用现有权限 ∪ 云文档标准 −(通讯录),所以**无论导入是追加还是覆盖,
 * 结果都正确、都不会弄丢该应用原有的能力**(例如 bot 的 IM 权限)。
 *
 * ⚠️ 本脚本只**读取**权限并生成文件。飞书开放 API 不提供"给应用声明新权限"的接口
 *    (那等于让应用自我提权),所以**勾选 + 发布版本 + 管理员审核只能在开发者后台手动做**。
 *
 * 用法:
 *   node feishu-scope-plan.mjs                 # 打印差异 + 生成终态文件
 *   node feishu-scope-plan.mjs --out <目录>    # 指定输出目录(默认 <KALA_FEISHU_HOME>/scope-targets)
 *   node feishu-scope-plan.mjs --print         # 只打印差异,不写文件
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { feishuHome, FEISHU_BASE } from './feishu-config.mjs';

// 云文档能力标准集(权限名取自真实已授权清单,非杜撰)。offline_access 仅用户身份。
const DOC_SCOPES = [
  'docx:document', 'docx:document:readonly', 'docs:doc', 'docs:document:export',
  'drive:drive', 'drive:drive:readonly', 'drive:drive.metadata:readonly', 'drive:export:readonly', 'drive:file',
  'wiki:wiki', 'wiki:wiki:readonly', 'wiki:node:read', 'wiki:space:retrieve',
  'sheets:spreadsheet', 'sheets:spreadsheet:readonly',
  'bitable:app', 'bitable:app:readonly', 'base:record:retrieve',
  'slides:presentation:read',
];
// 明确不纳入的(2026-07 决定:通讯录暂不开,真需要时去掉这条规则即可)
const EXCLUDE = /:contact:/;

const args = process.argv.slice(2);
const printOnly = args.includes('--print');
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(feishuHome(), 'scope-targets');

function accounts() {
  try {
    return readdirSync(feishuHome()).filter(f => f.endsWith('.config.json'))
      .map(f => f.replace(/\.config\.json$/, '')).sort();
  } catch { return []; }
}

async function grantedScopes(appId, appSecret) {
  const r = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const td = await r.json();
  if (td.code !== 0) throw new Error(`tenant token 失败 ${td.code}: ${td.msg}`);
  const d = await (await fetch(`${FEISHU_BASE}/application/v6/scopes`, {
    headers: { Authorization: 'Bearer ' + td.tenant_access_token },
  })).json();
  if (d.code !== 0) throw new Error(`读权限失败 ${d.code}: ${d.msg}`);
  return new Set((d.data.scopes || []).map(s => `${s.scope_type}:${s.scope_name}`));
}

const list = accounts();
if (!list.length) { console.log('没有已配置的账号'); process.exit(0); }

const cur = {};
for (const a of list) {
  try {
    const c = JSON.parse(readFileSync(join(feishuHome(), `${a}.config.json`), 'utf8'));
    cur[a] = { appId: c.appId, scopes: await grantedScopes(c.appId, c.appSecret) };
  } catch (e) { console.log(`  ⚠️ [${a}] ${e.message}`); }
}

const ok = list.filter(a => cur[a]);
if (!ok.length) { console.log('没有可读取的应用'); process.exit(1); }

if (!printOnly) mkdirSync(OUT, { recursive: true });

console.log('\n════ 各应用现状与差距 ════');
for (const a of ok) {
  const c = cur[a];
  const target = new Set([...c.scopes]);
  for (const k of DOC_SCOPES) { target.add('tenant:' + k); target.add('user:' + k); }
  target.add('user:offline_access');
  const keep = [...target].filter(k => !EXCLUDE.test(k));

  const added = keep.filter(k => !c.scopes.has(k)).sort();
  const droppedContact = [...c.scopes].filter(k => EXCLUDE.test(k));

  console.log(`\n  【${a}】 app=${c.appId}  现有 ${c.scopes.size} 条`);
  if (added.length) {
    console.log(`     需新增 ${added.length} 条:`);
    for (const k of added) console.log('       + ' + k);
  } else console.log('     ✅ 已达标,无需新增');
  if (droppedContact.length) console.log(`     (终态已剔除通讯录 ${droppedContact.length} 条:${droppedContact.join(', ')})`);

  if (!printOnly) {
    const tenant = keep.filter(k => k.startsWith('tenant:')).map(k => k.slice(7)).sort();
    const user = keep.filter(k => k.startsWith('user:')).map(k => k.slice(5)).sort();
    const f = join(OUT, `${a}.json`);
    writeFileSync(f, JSON.stringify({ scopes: { tenant, user } }, null, 2) + '\n', 'utf8');
    console.log(`     → 终态文件: ${f}`);
  }
}

console.log(`\n用法:把每个应用对应的 JSON 粘进它自己的「开发者后台 → 权限管理 → 导入」,`);
console.log(`然后各自「创建版本 → 发布 → 管理员审核」。`);
console.log(`只补应用身份权限**不需要**重新 OAuth;若新增了用户身份权限,需重跑 feishu-oauth.mjs auth。`);
