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
  const home = mkdtempSync(join(tmpdir(), 'kala-design-doc-home-'));
  for (const tool of ['.agents', '.codex', '.claude', '.cursor', '.openclaw']) {
    mkdirSync(join(home, tool), { recursive: true });
  }
  return home;
}

test('--list 列出 kala-design-doc', () => {
  const home = makeHome();
  try {
    const run = runInstaller(home, ['--list']);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /kala-design-doc/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('纯文档 skill 安装到 Claude、Codex、OpenClaw，并转为 Cursor command', () => {
  const home = makeHome();
  try {
    const run = runInstaller(home, ['kala-design-doc']);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

    for (const base of ['.agents', '.claude', '.openclaw']) {
      assert.equal(
        existsSync(join(home, base, 'skills', 'kala-design-doc', 'SKILL.md')),
        true,
        `${base} 缺少 kala-design-doc/SKILL.md`,
      );
    }

    const cursorCommand = join(home, '.cursor', 'commands', 'kala-design-doc.md');
    assert.equal(existsSync(cursorCommand), true, 'Cursor 缺少 kala-design-doc command');
    assert.doesNotMatch(readFileSync(cursorCommand, 'utf8'), /^---/);
    assert.equal(existsSync(join(home, '.cursor', 'skills', 'kala-design-doc')), false);
    assert.equal(existsSync(join(home, '.codex', 'skills', 'kala-design-doc')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--dialogue-style 只预览时不写文件', () => {
  const home = makeHome();
  try {
    const run = runInstaller(home, ['--dry-run', '--dialogue-style']);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /Codex 全局指令/);
    assert.match(run.stdout, /Claude Code 全局指令/);
    assert.doesNotMatch(run.stdout, /kala-design-doc\s+:/);
    assert.equal(existsSync(join(home, '.codex', 'AGENTS.md')), false);
    assert.equal(existsSync(join(home, '.claude', 'CLAUDE.md')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--dialogue-style 遇到未受管的现有内容时暂停且不修改', () => {
  const home = makeHome();
  try {
    const codexFile = join(home, '.codex', 'AGENTS.md');
    const claudeFile = join(home, '.claude', 'CLAUDE.md');
    writeFileSync(codexFile, '# 我原来的 Codex 规则\n', 'utf8');
    writeFileSync(claudeFile, '# 我原来的 Claude 规则\n', 'utf8');

    const run = runInstaller(home, ['--dialogue-style']);
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /暂停，未修改/);
    assert.match(run.stdout, /现有规则:/);
    assert.match(run.stdout, /新规则:/);
    assert.equal(readFileSync(codexFile, 'utf8'), '# 我原来的 Codex 规则\n');
    assert.equal(readFileSync(claudeFile, 'utf8'), '# 我原来的 Claude 规则\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--dialogue-style 幂等更新受管区块并保留区块外内容', () => {
  const home = makeHome();
  try {
    const first = runInstaller(home, ['--dialogue-style']);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

    for (const file of [join(home, '.codex', 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md')]) {
      const managed = readFileSync(file, 'utf8').trim();
      writeFileSync(file, `# 我原来的规则\n\n${managed}\n\n# 其他规则\n`, 'utf8');
    }

    const second = runInstaller(home, ['--dialogue-style']);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

    for (const file of [join(home, '.codex', 'AGENTS.md'), join(home, '.claude', 'CLAUDE.md')]) {
      const body = readFileSync(file, 'utf8');
      assert.match(body, /我原来的规则/);
      assert.match(body, /其他规则/);
      assert.match(body, /# 全局对话表达/);
      assert.equal((body.match(/kala-skill-kit:dialogue-style:start/g) || []).length, 1);
      assert.equal((body.match(/kala-skill-kit:dialogue-style:end/g) || []).length, 1);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('--dialogue-style 遇到损坏的受管标记时暂停', () => {
  const home = makeHome();
  try {
    const codexFile = join(home, '.codex', 'AGENTS.md');
    writeFileSync(codexFile, '<!-- kala-skill-kit:dialogue-style:start -->\n旧内容\n', 'utf8');

    const run = runInstaller(home, ['--tools', 'codex', '--dialogue-style']);
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /标记不完整或重复/);
    assert.equal(readFileSync(codexFile, 'utf8'), '<!-- kala-skill-kit:dialogue-style:start -->\n旧内容\n');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
