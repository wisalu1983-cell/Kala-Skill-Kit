import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const kit = resolve(here, '..');
const installer = join(kit, 'install.mjs');

function runInstaller(home, args) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: kit,
    encoding: 'utf8',
    env: {
      ...process.env,
      KALA_SKILL_HOME: home,
      CLAUDE_CONFIG_DIR: '',
      CODEX_HOME: '',
    },
  });
}

// 四端俱全的临时主目录(含 .openclaw,以验证 OpenClaw 跳过分支)
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'kala-skill-kit-home-'));
  for (const tool of ['.agents', '.codex', '.claude', '.cursor', '.openclaw']) mkdirSync(join(home, tool), { recursive: true });
  for (const base of ['.agents', '.claude']) {
    const skills = join(home, base, 'skills');
    const scripts = join(skills, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(skills, '_manifest.json'), `${JSON.stringify({ version: 2, skills: {} }, null, 2)}\n`, 'utf8');
    writeFileSync(join(skills, '_index.md'), '# Skills\n', 'utf8');
    const indexScript = [
      '$root = Split-Path -Parent $PSScriptRoot',
      'Set-Content -LiteralPath (Join-Path $root \'_index.md\') -Value "# Skills`n`n- kala-english-mode`n" -Encoding utf8',
      '',
    ].join('\n');
    writeFileSync(join(scripts, 'generate-index.ps1'), indexScript, 'utf8');
  }
  return home;
}

function readManifest(home, base) {
  return JSON.parse(readFileSync(join(home, base, 'skills', '_manifest.json'), 'utf8').replace(/^﻿/, ''));
}

test('--list 列出 kala-english-mode', () => {
  const home = makeHome();
  try {
    const run = runInstaller(home, ['--list']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /kala-english-mode/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('装入 Claude Code 与 Codex,跳过并清理 Cursor / OpenClaw 的历史副本', () => {
  const home = makeHome();
  try {
    // 预埋三处历史遗留副本,验证跳过时会被清理
    const staleCursorCmd = join(home, '.cursor', 'commands', 'kala-english-mode.md');
    const staleCursorSkill = join(home, '.cursor', 'skills', 'kala-english-mode');
    const staleOpenclaw = join(home, '.openclaw', 'skills', 'kala-english-mode');
    mkdirSync(dirname(staleCursorCmd), { recursive: true });
    writeFileSync(staleCursorCmd, 'stale', 'utf8');
    for (const dir of [staleCursorSkill, staleOpenclaw]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), 'stale', 'utf8');
    }

    const run = runInstaller(home, ['kala-english-mode']);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    // Claude Code + Codex(.agents):装入并登记
    for (const base of ['.claude', '.agents']) {
      const skill = join(home, base, 'skills', 'kala-english-mode');
      assert.equal(existsSync(join(skill, 'SKILL.md')), true, `${base} 缺少 SKILL.md`);
      const manifest = readManifest(home, base);
      assert.equal(manifest.skills['kala-english-mode']?.source, 'local', `${base} manifest 未登记`);
      assert.match(readFileSync(join(home, base, 'skills', '_index.md'), 'utf8'), /kala-english-mode/, `${base} index 未更新`);
    }
    assert.equal(existsSync(join(home, '.codex', 'skills', 'kala-english-mode')), false, 'Codex 不得落到 ~/.codex/skills');

    // Cursor / OpenClaw:跳过 + 历史副本被清理
    assert.match(run.stdout, /kala-english-mode[^\n]*跳过/);
    assert.equal(existsSync(staleCursorCmd), false, 'Cursor 历史 command 未清理');
    assert.equal(existsSync(staleCursorSkill), false, 'Cursor 历史 skill 目录未清理');
    assert.equal(existsSync(staleOpenclaw), false, 'OpenClaw 历史副本未清理');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dry-run 不落地也不清理,但报告跳过', () => {
  const home = makeHome();
  try {
    const stale = join(home, '.cursor', 'commands', 'kala-english-mode.md');
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, 'stale', 'utf8');

    const run = runInstaller(home, ['--dry-run', 'kala-english-mode']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /跳过/);
    assert.equal(existsSync(join(home, '.claude', 'skills', 'kala-english-mode')), false);
    assert.equal(existsSync(stale), true, 'dry-run 不应清理任何文件');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
