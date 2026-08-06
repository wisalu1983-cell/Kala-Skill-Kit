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
import { execFileSync } from 'child_process';

const KIT_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(KIT_DIR, 'skills');
const SKILLS = ['kala-handoff', 'kala-resume', 'kala-feishu', 'kala-gog', 'kala-meeting-minutes'];
const TOOLS_ALL = ['claude', 'codex', 'cursor', 'openclaw'];
const HOME = process.env.KALA_SKILL_HOME || homedir();

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
  console.log('默认行为:    不带参数 = 全部 skill → 所有探测到的工具(kala-feishu / kala-gog 不装到 OpenClaw)');
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

/** skip: { <skill 名>: '跳过原因' } —— 命中的 skill 不装,并清掉该位置的历史遗留副本。 */
function installAsSkills(label, base, skip = {}) {
  const dest = join(base, 'skills');
  summary.push(`  ${label}  →  ${dest}`);
  let any = false;
  const installed = [];
  for (const s of EFF_SKILLS) {
    any = true;
    const target = join(dest, s);
    if (skip[s]) {
      summary.push(`      - ${s} : 跳过(${skip[s]})`);
      if (!dryRun) rmSync(target, { recursive: true, force: true }); // 清掉历史遗留
      continue;
    }
    installed.push(s);
    summary.push(`      - ${s} : ${existsSync(target) ? '覆盖(已存在)' : '新建'}`);
    if (!dryRun) {
      mkdirSync(dest, { recursive: true });
      rmSync(target, { recursive: true, force: true });
      cpSync(join(SRC, s), target, { recursive: true });
    }
  }
  if (!any) summary.push('      (本次没有要装到这里的 skill)');
  if (installed.length) {
    const mf = updateSkillManifest(dest, installed);
    if (mf) summary.push(`      · _manifest.json: ${mf}`);
    const idx = regenerateSkillIndex(dest);
    if (idx) summary.push(`      · ${idx}`);
  }
}

/** 这个 skill 带可执行脚本吗?带脚本的必须装成真正的 skill 目录,转不成单文件 command。 */
function hasScripts(s) { return existsSync(join(SRC, s, 'scripts')); }

/** 从 SKILL.md 的 frontmatter 里取 description(登记进 Cursor 的 _manifest.json 用)。 */
function readDescription(s) {
  const lines = readFileSync(join(SRC, s, 'SKILL.md'), 'utf8').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = lines[i].match(/^description:\s*(.*)$/);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * skills 根目录若带 `_manifest.json`(用户自建的目录管理体系),把新装的 skill 登记进去。
 * 别的机器没有这套东西就跳过 —— 那边它只是个普通目录。
 */
function updateSkillManifest(skillsRoot, names) {
  const mf = join(skillsRoot, '_manifest.json');
  if (!existsSync(mf)) return null;
  const raw = readFileSync(mf, 'utf8');
  const bom = raw.startsWith('﻿') ? '﻿' : '';
  let j;
  try { j = JSON.parse(raw.replace(/^﻿/, '')); } catch { return '（_manifest.json 解析失败,跳过登记）'; }
  j.skills ||= {};
  const today = new Date().toISOString().slice(0, 10);
  const added = [];
  for (const s of names) {
    const prev = j.skills[s];
    j.skills[s] = {
      source: 'local',
      update_policy: 'manual',
      created: prev?.created || today,
      description: readDescription(s),
    };
    added.push(prev ? `${s}(更新)` : `${s}(新登记)`);
  }
  if (!dryRun) writeFileSync(mf, bom + JSON.stringify(j, null, 4), 'utf8');
  return added.join('、');
}

/** 索引由该目录自带的 generate-index.ps1 生成(_index.md 头部写明「请勿手动编辑」),这里只负责触发它。 */
function regenerateSkillIndex(skillsRoot) {
  const ps = join(skillsRoot, 'scripts', 'generate-index.ps1');
  if (!existsSync(ps)) return null;
  if (dryRun) return '将重新生成 _index.md';
  for (const exe of ['pwsh', 'powershell']) {
    try {
      execFileSync(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { stdio: 'ignore' });
      return `已用 ${exe} 重新生成 _index.md`;
    } catch { /* 换下一个 */ }
  }
  return '⚠️ 没跑成 generate-index.ps1,请手动执行一次以刷新 _index.md';
}

/**
 * Cursor 双轨:
 *   带 scripts/ 的 skill → ~/.cursor/skills/<名>/(flat layout,按该目录的 _manifest/_index 约定登记)
 *   纯文档的 skill       → ~/.cursor/commands/<名>.md(自包含,供 / 斜杠命令主动调用)
 */
function installAsCursor(base) {
  const cmdDest = join(base, 'commands');
  const skillDest = join(base, 'skills');
  const withScripts = EFF_SKILLS.filter(hasScripts);
  const docOnly = EFF_SKILLS.filter(s => !hasScripts(s));
  let did = false;

  if (withScripts.length) {
    summary.push(`  Cursor(skills)  →  ${skillDest}`);
    for (const s of withScripts) {
      did = true;
      const target = join(skillDest, s);
      summary.push(`      - ${s}/ : ${existsSync(target) ? '覆盖(已存在)' : '新建'}(带脚本)`);
      if (!dryRun) {
        mkdirSync(skillDest, { recursive: true });
        rmSync(target, { recursive: true, force: true });
        cpSync(join(SRC, s), target, { recursive: true });
      }
    }
    const mf = updateSkillManifest(skillDest, withScripts);
    if (mf) summary.push(`      · _manifest.json: ${mf}`);
    const idx = regenerateSkillIndex(skillDest);
    if (idx) summary.push(`      · ${idx}`);
  }

  if (docOnly.length) {
    summary.push(`  Cursor(commands)  →  ${cmdDest}`);
    for (const s of docOnly) {
      did = true;
      const f = join(cmdDest, `${s}.md`);
      summary.push(`      - ${s}.md : ${existsSync(f) ? '覆盖' : '新建'}`);
      if (dryRun) continue;
      mkdirSync(cmdDest, { recursive: true });
      let body = stripFm(join(SRC, s, 'SKILL.md'));
      // handoff 的模板是正文引用的,command 是单文件,必须内联进来
      const tpl = join(SRC, s, 'TEMPLATE.md');
      if (existsSync(tpl)) {
        body += '\n\n---\n# 附:交接文档模板(上文步骤 4/5 引用的 TEMPLATE)\n\n' + readFileSync(tpl, 'utf8');
      }
      writeFileSync(f, body, 'utf8');
    }
  }

  if (!did) summary.push('  Cursor  →  (本次没有可装到 Cursor 的 skill)');
}

// ── 逐工具探测 + 安装 ─────────────────────────────────────────────────────────
// Claude Code(尊重 CLAUDE_CONFIG_DIR;Compass/企业版会把配置目录改到别处)
if (wantTool('claude')) {
  const base = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
  if (existsSync(base)) installAsSkills('Claude Code', base);
  else summary.push(`–  Claude Code 未发现 ${base},跳过`);
}

// Codex 的可复用个人 skill 统一由 ~/.agents/skills 管理；~/.codex 只用于探测 Codex 是否已安装。
if (wantTool('codex')) {
  if (existsSync(join(HOME, '.codex')) || existsSync(join(HOME, '.agents'))) installAsSkills('Codex', join(HOME, '.agents'));
  else summary.push('–  Codex 未发现 ~/.codex 或 ~/.agents,跳过');
}

if (wantTool('cursor')) {
  if (existsSync(join(HOME, '.cursor'))) installAsCursor(join(HOME, '.cursor'));
  else summary.push('–  Cursor 未发现 ~/.cursor,跳过');
}

// OpenClaw 侧已有同源能力的 skill,重复安装会造成触发歧义,故明确跳过(见 AGENTS.md 硬规则)
const OPENCLAW_SKIP = {
  'kala-feishu': 'OpenClaw 自带飞书工具 feishu_doc/drive/wiki/perm',
  'kala-gog': 'OpenClaw 已有同源的 gog skill',
  'kala-meeting-minutes': '依赖 kala-feishu,当前只部署到 Claude Code / Codex / Cursor',
};
if (wantTool('openclaw')) {
  const oc = [join(HOME, '.openclaw'), join(HOME, '.config', 'openclaw'), join(HOME, '.open-claw')].find(existsSync);
  if (oc) installAsSkills('OpenClaw', oc, OPENCLAW_SKIP);
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
