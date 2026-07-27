/**
 * feishu-scope-audit.mjs —— 多组织权限体检:一条命令看出哪个飞书应用的权限跑偏了。
 *
 * 对 ~/.kala/feishu/ 下每个账号,用**应用身份(tenant)**和**用户身份(user)**分别
 * 实测一组能力,打出对照表。用来保证多个组织的应用权限配置一致,不用登多个后台翻。
 *
 * 探测方式是「真调 API」,不是读配置——所以结论就是实际能不能干这件事。
 * 会在被测账号下建一篇临时文档(名字带 __kala_scope_audit__)并在测完立即删除。
 *
 * 用法:
 *   node feishu-scope-audit.mjs              # 体检所有账号
 *   node feishu-scope-audit.mjs default      # 只体检指定账号(可多个)
 *   node feishu-scope-audit.mjs --no-write   # 只做只读探测(不建临时文档,跳过写/评论/权限项)
 */
import { readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { join } from 'path';
import { feishuHome, FEISHU_BASE } from './feishu-config.mjs';

const OAUTH = fileURLToPath(new URL('./feishu-oauth.mjs', import.meta.url));
const HOME = feishuHome();

const args = process.argv.slice(2);
const noWrite = args.includes('--no-write');
const only = args.filter(a => !a.startsWith('--'));

function accounts() {
  try {
    return readdirSync(HOME).filter(f => f.endsWith('.config.json'))
      .map(f => f.replace(/\.config\.json$/, '')).sort();
  } catch { return []; }
}

function appCreds(acct) {
  try { return JSON.parse(readFileSync(join(HOME, `${acct}.config.json`), 'utf8')); } catch { return null; }
}

async function tenantToken(acct) {
  const c = appCreds(acct);
  if (!c?.appId) return null;
  try {
    const r = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
    });
    const d = await r.json();
    return d.code === 0 ? d.tenant_access_token : null;
  } catch { return null; }
}

function userToken(acct) {
  try {
    return execFileSync(process.execPath, [OAUTH, 'get'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, KALA_FEISHU_ACCOUNT: acct },
    }).trim() || null;
  } catch { return null; }
}

async function call(token, method, path, body) {
  if (!token) return { mark: '–', note: '无token' };
  try {
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const d = await (await fetch(FEISHU_BASE + path, init)).json();
    if (d.code === 0) return { mark: '✅', data: d.data };
    if (d.code === 99991668 && /not support/i.test(d.msg || '')) return { mark: '—', note: '该API不支持此身份' };
    if (d.code === 99991672) return { mark: '❌', note: '缺权限' };
    return { mark: '❌', note: `${d.code}` };
  } catch (e) { return { mark: '❌', note: 'ERR' }; }
}

// 能力矩阵:[名称, method, path, body?, 是否需要写]
const READS = [
  ['云盘 drive',   'GET', '/drive/v1/files?page_size=1'],
  ['知识库 wiki',  'GET', '/wiki/v2/spaces?page_size=1'],
  ['IM 群列表',    'GET', '/im/v1/chats?page_size=1'],
  ['通讯录 contact','GET', '/contact/v3/users/me' ],
];

async function auditIdentity(label, token, rows) {
  const out = {};
  for (const [name, m, p] of READS) out[name] = (await call(token, m, p)).mark;

  if (noWrite || !token) {
    for (const n of ['文档写 docx', '评论 comment', '公开权限 perm']) out[n] = noWrite ? '·' : '–';
    return out;
  }
  // 写类:建一篇临时文档 → 评论 → 设公开 → 删除
  const cr = await call(token, 'POST', '/docx/v1/documents', { title: '__kala_scope_audit__(即删)' });
  out['文档写 docx'] = cr.mark;
  if (cr.mark === '✅') {
    const id = cr.data.document.document_id;
    out['评论 comment'] = (await call(token, 'POST', `/drive/v1/files/${id}/comments?file_type=docx`,
      { is_whole: true, reply_list: { replies: [{ content: { elements: [{ type: 'text_run', text_run: { text: 'audit' } }] } }] } })).mark;
    out['公开权限 perm'] = (await call(token, 'PATCH', `/drive/v1/permissions/${id}/public?type=docx`,
      { external_access_entity: 'open', security_entity: 'anyone_can_view', link_share_entity: 'anyone_readable' })).mark;
    const del = await call(token, 'DELETE', `/drive/v1/files/${id}?type=docx`);
    if (del.mark !== '✅') console.log(`    ⚠️ 临时文档未能删除: ${id}(请手动到回收站检查)`);
  } else {
    out['评论 comment'] = '–'; out['公开权限 perm'] = '–';
  }
  return out;
}

const CAPS = ['云盘 drive', '知识库 wiki', 'IM 群列表', '通讯录 contact', '文档写 docx', '评论 comment', '公开权限 perm'];

const list = only.length ? only : accounts();
if (!list.length) { console.log('没有已配置的账号(~/.kala/feishu/*.config.json)'); process.exit(0); }

const results = {};
for (const acct of list) {
  const c = appCreds(acct);
  process.stdout.write(`\n体检 [${acct}] app=${c?.appId || '?'} …\n`);
  const tt = await tenantToken(acct);
  const ut = userToken(acct);
  if (!tt) console.log('    ⚠️ 应用凭证无效或缺失');
  if (!ut) console.log('    ⚠️ 无可用用户 token(未授权或已过期,用户身份那列会是 –)');
  results[acct] = {
    应用身份: await auditIdentity('tenant', tt, CAPS),
    用户身份: await auditIdentity('user', ut, CAPS),
  };
}

// 输出对照表
const pad = (s, n) => { let w = 0; for (const ch of String(s)) w += ch.charCodeAt(0) > 255 ? 2 : 1; return String(s) + ' '.repeat(Math.max(0, n - w)); };
console.log('\n══════════ 权限体检结果 ══════════');
console.log('  ✅=能用  ❌=缺权限  —=该API不支持此身份  –=无token  ·=已跳过\n');
for (const identity of ['应用身份', '用户身份']) {
  console.log(`【${identity}】`);
  console.log('  ' + pad('能力', 16) + list.map(a => pad(a, 20)).join(''));
  for (const cap of CAPS) {
    console.log('  ' + pad(cap, 16) + list.map(a => pad(results[a][identity][cap] || '?', 20)).join(''));
  }
  console.log('');
}
// 差异告警
const drift = [];
for (const identity of ['应用身份', '用户身份']) {
  for (const cap of CAPS) {
    const vals = list.map(a => results[a][identity][cap]);
    const real = vals.filter(v => v === '✅' || v === '❌');
    if (real.includes('✅') && real.includes('❌')) drift.push(`${identity} · ${cap}`);
  }
}
if (drift.length) {
  console.log('⚠️ 各组织之间不一致的项(建议按 references/permission-scopes.json 统一):');
  for (const d of drift) console.log('   - ' + d);
} else {
  console.log('✅ 各组织权限一致(在可测项范围内)');
}
