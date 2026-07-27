/**
 * setup-keepalive.mjs —— 一条命令注册 token 自动保活(跨平台)。
 *
 * 做什么:把 keepalive.mjs 挂进系统定时器,每 7 天跑一次,遍历刷新
 * ~/.kala/feishu/ 下所有账号的 refresh_token(不保活则闲置约 30 天过期,需重新浏览器授权)。
 *
 *   - macOS   → launchd(~/Library/LaunchAgents/ai.kala.feishu.token-refresh.plist,注册即跑一次)
 *   - Windows → 任务计划程序(schtasks,任务名 KalaFeishuTokenRefresh,每周一 09:00,注册后立即跑一次)
 *   - Linux   → 不自动写 crontab,打印建议的 cron 行
 *
 * 用法:
 *   node setup-keepalive.mjs              # 注册(重复运行 = 用当前 node/脚本路径重写,幂等)
 *   node setup-keepalive.mjs --status     # 看注册状态
 *   node setup-keepalive.mjs --uninstall  # 取消注册
 *
 * 注册的是「本脚本所在目录」的 keepalive.mjs——从仓库副本运行就指向仓库,
 * 从已装副本($SKILL_DIR)运行就指向已装副本,两者皆可,别删注册时用的那份即可。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEEPALIVE = join(HERE, 'keepalive.mjs');
const NODE = process.execPath;
const LOG = join(homedir(), '.kala', 'feishu', 'keepalive.log');
const LABEL = 'ai.kala.feishu.token-refresh';
const WIN_TASK = 'KalaFeishuTokenRefresh';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const mode = process.argv.includes('--uninstall') ? 'uninstall'
  : process.argv.includes('--status') ? 'status' : 'install';

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const tryRun = (cmd, args) => { try { return run(cmd, args); } catch { return null; } };

if (!existsSync(KEEPALIVE)) {
  console.error(`找不到 ${KEEPALIVE},请从 kala-feishu 的 scripts/ 目录运行本脚本`);
  process.exit(1);
}

// ── macOS:launchd ────────────────────────────────────────────────────────────
if (process.platform === 'darwin') {
  if (mode === 'status') {
    const loaded = tryRun('launchctl', ['list', LABEL]);
    console.log(existsSync(PLIST) ? `plist: ${PLIST}` : 'plist: 未安装');
    console.log(loaded ? `launchd: 已加载\n${loaded.trim()}` : 'launchd: 未加载');
    process.exit(0);
  }
  if (mode === 'uninstall') {
    tryRun('launchctl', ['unload', PLIST]);
    rmSync(PLIST, { force: true });
    console.log(`✅ 已取消注册并删除 ${PLIST}`);
    process.exit(0);
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${KEEPALIVE}</string>
  </array>
  <key>StartInterval</key>
  <integer>604800</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(LOG), { recursive: true });
  tryRun('launchctl', ['unload', PLIST]); // 已加载则先卸,保证重读新配置
  writeFileSync(PLIST, plist, 'utf8');
  run('launchctl', ['load', PLIST]);      // RunAtLoad=true → 加载即跑一次,可当验证
  console.log(`✅ 已注册 launchd 保活(每 7 天):${PLIST}`);
  console.log(`   node:   ${NODE}`);
  console.log(`   script: ${KEEPALIVE}`);
  console.log(`   刚触发了一次,几秒后可看日志:tail -5 "${LOG}"`);
  process.exit(0);
}

// ── Windows:任务计划程序 ─────────────────────────────────────────────────────
if (process.platform === 'win32') {
  if (mode === 'status') {
    const q = tryRun('schtasks.exe', ['/Query', '/TN', WIN_TASK, '/FO', 'LIST']);
    console.log(q ? q.trim() : `任务 ${WIN_TASK}: 未注册`);
    process.exit(0);
  }
  if (mode === 'uninstall') {
    const ok = tryRun('schtasks.exe', ['/Delete', '/TN', WIN_TASK, '/F']);
    console.log(ok !== null ? `✅ 已删除计划任务 ${WIN_TASK}` : `任务 ${WIN_TASK} 不存在,无需删除`);
    process.exit(0);
  }
  mkdirSync(dirname(LOG), { recursive: true });
  // cmd /c ""node" "script" >> "log" 2>&1" —— 外层引号会被 cmd 剥掉,内层保住带空格路径
  const tr = `cmd /c ""${NODE}" "${KEEPALIVE}" >> "${LOG}" 2>&1"`;
  try {
    run('schtasks.exe', ['/Create', '/TN', WIN_TASK, '/SC', 'WEEKLY', '/D', 'MON',
      '/ST', '09:00', '/F', '/TR', tr]);
    tryRun('schtasks.exe', ['/Run', '/TN', WIN_TASK]); // 立即跑一次当验证
    console.log(`✅ 已注册计划任务 ${WIN_TASK}(每周一 09:00),并已触发一次`);
    console.log(`   验证:Get-Content "${LOG}" -Tail 5`);
  } catch (e) {
    console.error(`❌ schtasks 注册失败: ${(e.stderr || e.message || '').toString().trim()}`);
    console.error('请改用手动方式(references/windows-setup.md 步骤 6 的 PowerShell 命令)。');
    process.exit(1);
  }
  process.exit(0);
}

// ── 其他(Linux 等):给 cron 建议 ────────────────────────────────────────────
console.log('本平台不自动注册,请手动加 crontab(crontab -e):');
console.log(`0 9 * * 1 "${NODE}" "${KEEPALIVE}" >> "${LOG}" 2>&1`);
