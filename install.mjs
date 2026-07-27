#!/usr/bin/env node
/**
 * Kala-Skill-Kit installer(跨平台:macOS / Linux / Windows)——
 * 逐工具探测,装到实际存在的工具里,缺的跳过。
 *
 * 用法(三个平台都一样):
 *   node install.mjs                       全部 skill → 所有探测到的工具(默认)
 *   node install.mjs kala-handoff          只装指定的 skill(可多个)
 *   node install.mjs --tools codex,claude  只装到指定工具(claude/codex/cursor/openclaw)
 *   node install.mjs --dry-run [...]       只预览会装/覆盖/跳过什么,不改动任何文件
 *   node install.mjs --list                列出可选 skill / 工具后退出
 *   node install.mjs --help                显示帮助
 *
 * macOS/Linux 上 `./install.sh` 是本文件的薄封装,行为完全一致。
 * 幂等:重复运行 = 用当前 repo 内容覆盖更新。改完 skill 后重跑一次即可。
 */
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(KIT_DIR, 'skills');
const SKILLS = ['kala-handoff', 'kala-resume', 'kala-feishu'];
const TOOLS_ALL = ['claude', 'codex', 'cursor', 'openclaw'];
const HOME = homedir();

// ── 参数解析 ─────────────────────────────────────────────────────────────────
let dryRun = false, doList = false, reqTools = '';
const reqSkills = [];
const argv = process.argv.slice(2);

function usage() {
  console.log(`用法: node install.mjs [选项] [skill 名...]

不带参数 = 全部 skill 装到所有探测到的工具(默认行为)。

选项:
  --tools a,b     只装到这些工具(可选: ${TOOLS_ALL.join(' ')})
  --dry-run       只预览会装/覆盖/跳过什么,不真正改动任何文件
  --list          列出可选 skill 和工具,然后退出
  -h, --help      显示本帮助

示例:
  node install.mjs --dry-run                     预览默认的全量安装
  node install.mjs kala-handoff kala-resume      只装这两个
  node install.mjs --tools codex kala-feishu     只把 kala-feishu 装到 Codex
  node install.mjs --dry-run --tools claude      预览:只装到 Claude Code`);
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--dry-run') dryRun = true;
  else if (a === '--list') doList = true;
  else if (a === '--tools') {
    if (++i >= argv.length) { console.error('错误: --tools 后面要跟工具名'); process.exit(1); }
    reqTools = argv[i];
  } else if (a.startsWith('--tools=')) reqTools = a.slice('--tools='.length);
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('-')) { console.error(`错误: 未知选项 ${a}\n`); usage(); process.exit(1); }
  else reqSkills.push(a);
}

for (const s of reqSkills) {
  if (!SKILLS.includes(s)) { console.error(`错误: 未知 skill '${s}'。可选: ${SKILLS.join(' ')}`); process.exit(1); }
}
if (reqTools) {
  for (const t of reqTools.split(',')) {
    if (!TOOLS_ALL.includes(t)) { console.error(`错误: 未知工具 '${t}'。可选: ${TOOLS_ALL.join(' ')}`); process.exit(1); }
  }
}

const EFF_SKILLS = reqSkills.length ? reqSkills : SKILLS;
const wantTool = (t) => !reqTools || reqTools.split(',').includes(t);

if (doList) {
  console.log(`可选 skill:  ${SKILLS.join(' ')}`);
  console.log(`可选工具:    ${TOOLS_ALL.join(' ')}`);
  console.log('默认行为:    不带参数 = 全部 skill → 所有探测到的工具(kala-feishu 不装到 OpenClaw)');
  process.exit(0);
}

// 去掉 md 开头的 YAML frontmatter,给不吃 frontmatter 的工具(Cursor)用
function stripFm(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let seen = 0, out = [];
  for (const line of lines) {
    if (seen < 2) { if (line.trim() === '---') seen++; continue; }
    out.push(line);
  }
  return out.join('\n');
}

const summary = [];

function installAsSkills(label, base, skip = []) {
  const dest = join(base, 'skills');
  summary.push(`  ${label}  →  ${dest}`);
  let any = false;
  for (const s of EFF_SKILLS) {
    any = true;
    const target = join(dest, s);
    if (skip.includes(s)) {
      summary.push(`      - ${s} : 跳过(OpenClaw 自带飞书工具)`);
      if (!dryRun) rmSync(target, { recursive: true, force: true }); // 清掉历史遗留
      continue;
    }
    summary.push(`      - ${s} : ${existsSync(target) ? '覆盖(已存在)' : '新建'}`);
    if (!dryRun) {
      mkdirSync(dest, { recursive: true });
      rmSync(target, { recursive: true, force: true });
      cpSync(join(SRC, s), target, { recursive: true });
    }
  }
  if (!any) summary.push('      (本次没有要装到这里的 skill)');
}

// Cursor 不吃 SKILL 目录:只把 handoff/resume 转成自包含 command md(feishu 带脚本,跳过)
function installAsCursor(base) {
  const dest = join(base, 'commands');
  summary.push(`  Cursor  →  ${dest}`);
  let did = false;
  for (const s of EFF_SKILLS) {
    if (s === 'kala-handoff') {
      did = true;
      const f = join(dest, 'kala-handoff.md');
      summary.push(`      - kala-handoff.md : ${existsSync(f) ? '覆盖' : '新建'}`);
      if (!dryRun) {
        mkdirSync(dest, { recursive: true });
        const body = stripFm(join(SRC, 'kala-handoff', 'SKILL.md'))
          + '\n\n---\n# 附:交接文档模板(上文步骤 4/5 引用的 TEMPLATE)\n\n'
          + readFileSync(join(SRC, 'kala-handoff', 'TEMPLATE.md'), 'utf8');
        writeFileSync(f, body, 'utf8');
      }
    } else if (s === 'kala-resume') {
      did = true;
      const f = join(dest, 'kala-resume.md');
      summary.push(`      - kala-resume.md : ${existsSync(f) ? '覆盖' : '新建'}`);
      if (!dryRun) {
        mkdirSync(dest, { recursive: true });
        writeFileSync(f, stripFm(join(SRC, 'kala-resume', 'SKILL.md')), 'utf8');
      }
    } else {
      summary.push(`      - ${s} : 跳过(Cursor 不装带脚本的 skill)`);
    }
  }
  if (!did) summary.push('      (本次没有可装到 Cursor 的 skill)');
}

// ── 逐工具探测 + 安装 ─────────────────────────────────────────────────────────
// Claude Code(尊重 CLAUDE_CONFIG_DIR;Compass/企业版会把配置目录改到别处)
if (wantTool('claude')) {
  const base = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
  if (existsSync(base)) installAsSkills('Claude Code', base);
  else summary.push(`–  Claude Code 未发现 ${base},跳过`);
}

// Codex(默认 ~/.codex/skills 自动发现)
if (wantTool('codex')) {
  if (existsSync(join(HOME, '.codex'))) installAsSkills('Codex', process.env.CODEX_HOME || join(HOME, '.codex'));
  else summary.push('–  Codex 未发现 ~/.codex,跳过');
}

if (wantTool('cursor')) {
  if (existsSync(join(HOME, '.cursor'))) installAsCursor(join(HOME, '.cursor'));
  else summary.push('–  Cursor 未发现 ~/.cursor,跳过');
}

// OpenClaw 自带飞书工具(feishu_doc/drive/wiki/perm),kala-feishu 对它冗余且会造成触发歧义,故明确跳过
if (wantTool('openclaw')) {
  const oc = [join(HOME, '.openclaw'), join(HOME, '.config', 'openclaw'), join(HOME, '.open-claw')].find(existsSync);
  if (oc) installAsSkills('OpenClaw', oc, ['kala-feishu']);
  else summary.push('–  OpenClaw 未发现其配置目录,跳过(装好后重跑本脚本)');
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
console.log();
console.log(dryRun
  ? 'Kala-Skill-Kit 安装预览 —— --dry-run,不会真正改动任何文件:'
  : 'Kala-Skill-Kit 安装结果:');
for (const line of summary) console.log(line);
console.log();
if (dryRun) {
  console.log('以上仅预览。确认无误后,去掉 --dry-run 再运行,才会真正安装。');
} else {
  console.log('装好新工具后,重跑安装器即可增量补齐。');
  console.log('提示:支持 --list 看选项 · --dry-run 只预览不落地 · 按 skill 名 / --tools 选择性安装(详见 --help 或 AGENTS.md)。');
}
