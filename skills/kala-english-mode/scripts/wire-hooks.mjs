#!/usr/bin/env node
// 一次性、手动运行的部署脚本：把 scripts/hook.mjs 注册进 Claude Code 的
// ~/.claude/settings.json 和 Codex 的 ~/.codex/hooks.json（或 CODEX_HOME 指向的路径）。
// 默认 dry-run，只打印将要做的改动；加 --yes 才真正写入。
// 每台新设备第一次部署都要跑一遍，见 AGENTS.md 里 kala-english-mode 的"每台设备部署流程"。
//
// 用法:
//   node wire-hooks.mjs                          # 预览
//   node wire-hooks.mjs --yes                     # 真正写入 hook 注册
//   node wire-hooks.mjs --yes --default-on        # 同时把本机个人偏好设为"新 session 默认开启基础档"
//   node wire-hooks.mjs --yes --default-on --tier challenge
//   node wire-hooks.mjs --yes --default-off       # 关闭本机默认开启
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePreferences } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = join(__dirname, 'hook.mjs');

const args = process.argv.slice(2);
const commit = args.includes('--yes');
const setDefaultOn = args.includes('--default-on');
const setDefaultOff = args.includes('--default-off');
const tierIdx = args.indexOf('--tier');
const tier = tierIdx >= 0 && args[tierIdx + 1] === 'challenge' ? 'challenge' : 'basic';

function detectPlatformLabel() {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  return process.platform;
}

// 只用普通双引号包住路径；整个 config 对象最终统一交给外层 JSON.stringify 转义一次，
// 这里不能再手动 JSON.stringify(path) ——那样会被转义两次，写回磁盘后读出来的 command 是错的。
function quoteCommand(scriptPath) {
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
  return `${nodeCmd} "${scriptPath}"`;
}

function loadJsonIfExists(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} 不是合法 JSON,已停止,不会碰这个文件:${err.message}`);
  }
}

function alreadyRegistered(entries, scriptPath) {
  if (!Array.isArray(entries)) return false;
  return entries.some(
    (entry) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(scriptPath))
  );
}

// 读-改-写合并:已有的 hooks 配置原样保留,只在对应事件数组里追加一条,且检查是否已注册过(幂等)。
function mergeHookEntry(config, eventName, scriptPath) {
  const hooks = config.hooks || (config.hooks = {});
  const list = hooks[eventName] || (hooks[eventName] = []);
  if (alreadyRegistered(list, scriptPath)) return false;
  list.push({ hooks: [{ type: 'command', command: quoteCommand(scriptPath) }] });
  return true;
}

function planTarget(label, configPath, events) {
  const before = loadJsonIfExists(configPath);
  const config = before ? JSON.parse(JSON.stringify(before)) : {};
  const changedEvents = events.filter((eventName) => mergeHookEntry(config, eventName, HOOK_SCRIPT));
  return { label, configPath, before, config, changedEvents };
}

function backupPath(configPath) {
  return `${configPath}.kala-english-mode.bak`;
}

function applyTarget(target) {
  if (target.changedEvents.length === 0) return;
  mkdirSync(dirname(target.configPath), { recursive: true });
  if (target.before) {
    writeFileSync(backupPath(target.configPath), JSON.stringify(target.before, null, 2) + '\n', 'utf8');
  }
  writeFileSync(target.configPath, JSON.stringify(target.config, null, 2) + '\n', 'utf8');
}

function main() {
  console.log(`检测到系统:${detectPlatformLabel()}`);

  const claudeSettings = join(homedir(), '.claude', 'settings.json');
  const codexHooksHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const codexHooks = join(codexHooksHome, 'hooks.json');

  const targets = [
    planTarget('Claude Code', claudeSettings, ['UserPromptSubmit', 'SessionStart']),
    planTarget('Codex', codexHooks, ['UserPromptSubmit']),
  ];

  for (const t of targets) {
    console.log(`\n[${t.label}] ${t.configPath}`);
    if (!t.before) console.log('  (文件不存在,将新建)');
    if (t.changedEvents.length === 0) {
      console.log('  已注册,无需改动。');
    } else {
      console.log(`  将追加 hook 到:${t.changedEvents.join(', ')}`);
      console.log(`  command: ${quoteCommand(HOOK_SCRIPT)}`);
    }
  }

  if (setDefaultOn) {
    console.log(`\n[个人偏好] ~/.kala/english-mode/config.json -> defaultEnabled=true, defaultTier=${tier}`);
  } else if (setDefaultOff) {
    console.log('\n[个人偏好] ~/.kala/english-mode/config.json -> defaultEnabled=false');
  }

  if (!commit) {
    console.log('\n(dry-run,未写入任何文件。确认无误后加 --yes 真正写入。)');
    return;
  }

  for (const t of targets) applyTarget(t);
  if (setDefaultOn) writePreferences({ defaultEnabled: true, defaultTier: tier });
  if (setDefaultOff) writePreferences({ defaultEnabled: false, defaultTier: tier });

  console.log('\n已写入。改动前若文件已存在,原内容已备份到同目录下的 *.kala-english-mode.bak,可直接覆盖回去撤销。');
}

main();
