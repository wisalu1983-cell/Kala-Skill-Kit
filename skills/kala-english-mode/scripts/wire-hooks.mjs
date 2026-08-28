#!/usr/bin/env node
// 一次性、手动运行的部署脚本：把 hook.mjs 注册进 Claude Code 的
// ~/.claude/settings.json 和 Codex 的 ~/.codex/hooks.json（或 CODEX_HOME 指向的路径）。
// 默认 dry-run，只打印将要做的改动；加 --yes 才真正写入。
// 每台新设备第一次部署都要跑一遍，见 AGENTS.md 里 kala-english-mode 的"每台设备部署流程"。
//
// ⚠️ 硬性原则：仓库(工程文件夹)里的代码只是"安装源"，agent 工具永远只应该运行"已安装"到
// ~/.claude/skills/kala-english-mode 或 ~/.agents/skills/kala-english-mode 的那份副本，
// 不能让 Claude Code / Codex 直接跑仓库路径下的 hook.mjs。所以本脚本注册的 command 路径
// 一律指向这两个"已安装"目录，从不使用 import.meta.url 所在的仓库路径——不管你是从仓库
// 目录还是从别的地方运行这个脚本本身，注册出来的路径都一样。
// 运行前必须先 `node install.mjs kala-english-mode`（或 `install.sh`）把当前代码部署到
// 这两个已安装目录，本脚本会检查目标文件是否存在，不存在就报错并跳过，不会写入一条指向
// 不存在文件的坏 hook。
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
import { writePreferences } from './lib.mjs';

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

// 已安装目录路径，跟 install.mjs 里的目标解析规则保持一致：
// Claude Code 固定 ${CLAUDE_CONFIG_DIR:-~/.claude}/skills；Codex 固定 ~/.agents/skills。
function claudeInstalledHook() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'skills', 'kala-english-mode', 'scripts', 'hook.mjs');
}

function codexInstalledHook() {
  return join(homedir(), '.agents', 'skills', 'kala-english-mode', 'scripts', 'hook.mjs');
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

// 识别"这是不是 kala-english-mode 的 hook"，按路径的固定后缀匹配，不看绝对路径前缀——
// 这样不管旧注册指向的是仓库路径、旧安装路径还是别的机器路径，都能认出来并在原地替换，
// 不会因为前缀不同就被当成两条不同的 hook 而重复注册。
const IDENTITY_SUFFIX = join('kala-english-mode', 'scripts', 'hook.mjs');

function findEntryIndex(entries) {
  if (!Array.isArray(entries)) return -1;
  return entries.findIndex(
    (entry) =>
      Array.isArray(entry.hooks) &&
      entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(IDENTITY_SUFFIX))
  );
}

// 读-改-写合并：已有的 hooks 配置原样保留；同一个 skill 的旧条目(不管指向哪个绝对路径)
// 原地替换成新 command；没有就新增。返回 'added' | 'replaced' | null(未变)。
function mergeHookEntry(config, eventName, scriptPath) {
  const hooks = config.hooks || (config.hooks = {});
  const list = hooks[eventName] || (hooks[eventName] = []);
  const command = quoteCommand(scriptPath);
  const idx = findEntryIndex(list);
  if (idx === -1) {
    list.push({ hooks: [{ type: 'command', command }] });
    return 'added';
  }
  const existingCommand = list[idx].hooks[0]?.command;
  if (existingCommand === command) return null;
  list[idx] = { hooks: [{ type: 'command', command }] };
  return 'replaced';
}

function planTarget(label, configPath, hookPath, events) {
  if (!existsSync(hookPath)) {
    return {
      label,
      configPath,
      hookPath,
      missing: true,
      changes: {},
    };
  }
  const before = loadJsonIfExists(configPath);
  const config = before ? JSON.parse(JSON.stringify(before)) : {};
  const changes = {};
  for (const eventName of events) {
    const result = mergeHookEntry(config, eventName, hookPath);
    if (result) changes[eventName] = result;
  }
  return { label, configPath, hookPath, missing: false, before, config, changes };
}

function backupPath(configPath) {
  return `${configPath}.kala-english-mode.bak`;
}

function applyTarget(target) {
  if (target.missing || Object.keys(target.changes).length === 0) return;
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
    planTarget('Claude Code', claudeSettings, claudeInstalledHook(), ['UserPromptSubmit', 'SessionStart']),
    planTarget('Codex', codexHooks, codexInstalledHook(), ['UserPromptSubmit']),
  ];

  let anyMissing = false;
  for (const t of targets) {
    console.log(`\n[${t.label}] ${t.configPath}`);
    if (t.missing) {
      anyMissing = true;
      console.log(`  ⛔ 已安装的 hook.mjs 不存在(${t.hookPath})——请先跑 \`node install.mjs kala-english-mode\` 部署,再重跑本脚本。已跳过,不会写入坏路径。`);
      continue;
    }
    if (!t.before) console.log('  (配置文件不存在,将新建)');
    const events = Object.keys(t.changes);
    if (events.length === 0) {
      console.log('  已正确注册,无需改动。');
    } else {
      for (const eventName of events) {
        console.log(`  ${t.changes[eventName] === 'replaced' ? '替换' : '追加'} ${eventName} -> ${t.hookPath}`);
      }
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
  if (anyMissing) {
    console.log('提醒:上面有目标因为找不到已安装的 hook.mjs 被跳过,补装后请重跑本脚本。');
  }
}

main();
