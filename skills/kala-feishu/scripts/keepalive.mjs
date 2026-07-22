/**
 * keepalive.mjs —— 保活 ~/.kala/feishu/ 下**所有**账号的 OAuth token。
 *
 * 遍历每个 <account>.token.json,逐个跑 feishu-oauth.mjs refresh(带上对应
 * KALA_FEISHU_ACCOUNT),把 refresh_token 链往前续,避免闲置 30 天过期。
 * 新增账号自动纳入,无需改 launchd。
 *
 * launchd/cron 指向本脚本即可(而不是直接 `feishu-oauth.mjs refresh`——那只刷 default)。
 * 用法: node keepalive.mjs
 */
import { readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { feishuHome } from './feishu-config.mjs';

const OAUTH = fileURLToPath(new URL('./feishu-oauth.mjs', import.meta.url));
const home = feishuHome();
const stamp = () => new Date().toISOString();

let accounts = [];
try {
  accounts = readdirSync(home)
    .filter(f => f.endsWith('.token.json'))
    .map(f => f.replace(/\.token\.json$/, ''))
    .sort();
} catch (e) {
  console.log(`${stamp()} 读取 ${home} 失败: ${e.message}`);
  process.exit(0);
}

if (!accounts.length) {
  console.log(`${stamp()} 没有已授权账号,跳过`);
  process.exit(0);
}

console.log(`${stamp()} 保活 ${accounts.length} 个账号: ${accounts.join(', ')}`);
let failed = 0;
for (const acct of accounts) {
  try {
    const out = execFileSync(process.execPath, [OAUTH, 'refresh'], {
      encoding: 'utf8',
      env: { ...process.env, KALA_FEISHU_ACCOUNT: acct },
    });
    const ok = /刷新成功/.test(out);
    console.log(`${stamp()} [${acct}] ${ok ? '✅ 刷新成功' : out.trim().replace(/\s+/g, ' ')}`);
    if (!ok) failed++;
  } catch (e) {
    failed++;
    const msg = ((e.stderr || '') + (e.message || '')).toString().trim().replace(/\s+/g, ' ');
    console.log(`${stamp()} [${acct}] ❌ 刷新失败(可能 refresh_token 已过期,需重新 auth): ${msg}`);
  }
}
process.exit(failed ? 1 : 0);
