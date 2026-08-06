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

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'kala-skill-kit-home-'));
  for (const tool of ['.agents', '.codex', '.claude', '.cursor']) mkdirSync(join(home, tool), { recursive: true });
  for (const base of ['.agents', '.claude', '.cursor']) {
    const skills = join(home, base, 'skills');
    const scripts = join(skills, 'scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(skills, '_manifest.json'), `${JSON.stringify({ version: 2, skills: {} }, null, 2)}\n`, 'utf8');
    writeFileSync(join(skills, '_index.md'), '# Skills\n', 'utf8');
    const indexScript = [
      '$root = Split-Path -Parent $PSScriptRoot',
      'Set-Content -LiteralPath (Join-Path $root \'_index.md\') -Value "# Skills`n`n- kala-meeting-minutes`n" -Encoding utf8',
      '',
    ].join('\n');
    writeFileSync(join(scripts, 'generate-index.ps1'), indexScript, 'utf8');
  }
  return home;
}

function readManifest(home, base) {
  return JSON.parse(readFileSync(join(home, base, 'skills', '_manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
}

test('--list 列出 kala-meeting-minutes', () => {
  const home = makeHome();
  try {
    const run = runInstaller(home, ['--list']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /kala-meeting-minutes/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('三端 dry-run 使用临时主目录且 Codex 指向 .agents/skills', () => {
  const home = makeHome();
  try {
    const run = runInstaller(home, ['--dry-run', '--tools', 'codex,claude,cursor', 'kala-meeting-minutes']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, new RegExp(join(home, '.agents', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(run.stdout, new RegExp(join(home, '.claude', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(run.stdout, new RegExp(join(home, '.cursor', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(run.stdout, new RegExp(join(home, '.codex', 'skills').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(existsSync(join(home, '.agents', 'skills', 'kala-meeting-minutes')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('选择性安装复制到三端并更新 manifest 和 index', () => {
  const home = makeHome();
  try {
    const run = runInstaller(home, ['--tools', 'codex,claude,cursor', 'kala-meeting-minutes']);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    for (const base of ['.agents', '.claude', '.cursor']) {
      const skill = join(home, base, 'skills', 'kala-meeting-minutes');
      assert.equal(existsSync(join(skill, 'SKILL.md')), true, `${base} 缺少 SKILL.md`);
      assert.equal(existsSync(join(skill, 'scripts', 'validate-package.mjs')), true, `${base} 缺少验证脚本`);
      const manifest = readManifest(home, base);
      assert.equal(manifest.skills['kala-meeting-minutes']?.source, 'local', `${base} manifest 未登记`);
      assert.match(readFileSync(join(home, base, 'skills', '_index.md'), 'utf8'), /kala-meeting-minutes/, `${base} index 未更新`);
    }
    assert.equal(existsSync(join(home, '.codex', 'skills', 'kala-meeting-minutes')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
