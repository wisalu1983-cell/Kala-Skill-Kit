import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const validator = resolve(here, '../skills/kala-meeting-minutes/scripts/validate-package.mjs');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function makeValidPackage() {
  const root = mkdtempSync(join(tmpdir(), 'kala-meeting-minutes-'));
  mkdirSync(join(root, 'visuals'));
  writeFileSync(join(root, 'meeting-minutes.md'), `# 示例项目评审会

## 总结

团队确认先验证核心流程，再扩大内容范围。

## 关键结论

- 首版只覆盖核心流程。

## 待办

- 项目负责人于周五前提交验证清单。

## 智能章节

### 00:00 核心范围

讨论首版交付边界。

## 金句时刻

> 先跑通核心流程，再扩大范围。

## 完整转录

00:00 说话人甲：首版先把核心流程跑通。
`, 'utf8');
  writeJson(join(root, 'source-map.json'), {
    version: 1,
    items: [
      {
        id: 'decision-1',
        kind: 'decision',
        summary: '首版只覆盖核心流程。',
        status: 'confirmed',
        evidence: [{ timestamp: '00:00', speaker: '说话人甲', quote: '首版先把核心流程跑通。' }],
      },
      {
        id: 'todo-1',
        kind: 'action_item',
        summary: '周五前提交验证清单。',
        status: 'confirmed',
        evidence: [{ timestamp: '02:10', speaker: '说话人乙', quote: '周五前给出清单。' }],
      },
    ],
  });
  writeFileSync(join(root, 'preview.html'), '<!doctype html><title>示例项目评审会</title><main data-meeting-minutes-preview>纪要预览</main>\n', 'utf8');
  writeJson(join(root, 'publish-plan.json'), {
    version: 1,
    target: { mode: 'feishu', document_url: 'https://example.feishu.cn/docx/example' },
    operations: [
      {
        id: 'replace-summary-visual',
        action: 'replace',
        anchor: { strategy: 'block-id', value: 'example-block' },
        content: { kind: 'image', source: 'visuals/summary.svg' },
      },
    ],
  });
  writeFileSync(join(root, 'qa-report.md'), '# QA 报告\n\n- 内容检查：通过\n- 视觉检查：待飞书发布后复核\n', 'utf8');
  writeFileSync(join(root, 'visuals', 'summary.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><text x="20" y="40">核心流程</text></svg>\n', 'utf8');
  return root;
}

function runValidator(root) {
  return spawnSync(process.execPath, [validator, root], { encoding: 'utf8' });
}

function readResult(run) {
  const raw = (run.stdout || run.stderr || '').trim();
  assert.notEqual(raw, '', '验证器应输出 JSON 结果');
  return JSON.parse(raw);
}

test('完整待发布纪要包通过验证', () => {
  const root = makeValidPackage();
  try {
    const run = runValidator(root);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readResult(run).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('缺少必需文件时失败并指出文件名', () => {
  const root = makeValidPackage();
  try {
    rmSync(join(root, 'qa-report.md'));
    const run = runValidator(root);
    assert.equal(run.status, 1);
    const result = readResult(run);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.code === 'missing-required' && e.path === 'qa-report.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('正文缺少必需章节时失败', () => {
  const root = makeValidPackage();
  try {
    const path = join(root, 'meeting-minutes.md');
    writeFileSync(path, '# 示例项目评审会\n\n## 总结\n\n只有总结。\n', 'utf8');
    const run = runValidator(root);
    assert.equal(run.status, 1);
    const result = readResult(run);
    assert.ok(result.errors.some((e) => e.code === 'missing-section' && e.section === '待办'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('已确认结论缺少原文证据时失败', () => {
  const root = makeValidPackage();
  try {
    const mapPath = join(root, 'source-map.json');
    writeJson(mapPath, {
      version: 1,
      items: [{ id: 'decision-1', kind: 'decision', summary: '首版只覆盖核心流程。', status: 'confirmed', evidence: [] }],
    });
    const run = runValidator(root);
    assert.equal(run.status, 1);
    const result = readResult(run);
    assert.ok(result.errors.some((e) => e.code === 'missing-evidence' && e.item_id === 'decision-1'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('发布计划引用绝对资产路径时失败', () => {
  const root = makeValidPackage();
  try {
    const planPath = join(root, 'publish-plan.json');
    writeJson(planPath, {
      version: 1,
      target: { mode: 'feishu', document_url: 'https://example.feishu.cn/docx/example' },
      operations: [{
        id: 'replace-summary-visual',
        action: 'replace',
        anchor: { strategy: 'block-id', value: 'example-block' },
        content: { kind: 'image', source: 'C:/temp/summary.svg' },
      }],
    });
    const run = runValidator(root);
    assert.equal(run.status, 1);
    const result = readResult(run);
    assert.ok(result.errors.some((e) => e.code === 'asset-path-outside'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
