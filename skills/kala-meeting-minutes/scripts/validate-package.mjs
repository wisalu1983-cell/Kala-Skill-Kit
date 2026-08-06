#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const packageArg = process.argv[2];
const errors = [];

function addError(code, message, extra = {}) {
  errors.push({ code, message, ...extra });
}

function readText(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    addError('read-failed', `无法读取 ${label}: ${error.message}`, { path: label });
    return '';
  }
}

function readJson(path, label) {
  const text = readText(path, label);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    addError('invalid-json', `${label} 不是有效 JSON: ${error.message}`, { path: label });
    return null;
  }
}

function isOutside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel);
}

function validateAssetSource(root, source, operationId) {
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\');
  if (isAbsolute(source) || windowsAbsolute) {
    addError('asset-path-outside', '资产路径必须相对于纪要包目录', { operation_id: operationId, source });
    return;
  }
  const candidate = resolve(root, source);
  if (isOutside(root, candidate)) {
    addError('asset-path-outside', '资产路径不能逃出纪要包目录', { operation_id: operationId, source });
    return;
  }
  if (!existsSync(candidate)) {
    addError('asset-missing', '发布计划引用的资产不存在', { operation_id: operationId, source });
  }
}

if (!packageArg) {
  addError('usage', '用法: node validate-package.mjs <待发布纪要包目录>');
} else {
  const root = resolve(packageArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    addError('package-not-found', '待发布纪要包目录不存在', { path: packageArg });
  } else {
    const requiredFiles = [
      'meeting-minutes.md',
      'source-map.json',
      'preview.html',
      'publish-plan.json',
      'qa-report.md',
    ];
    for (const path of requiredFiles) {
      if (!existsSync(resolve(root, path))) {
        addError('missing-required', `缺少必需文件: ${path}`, { path });
      }
    }
    const visuals = resolve(root, 'visuals');
    if (!existsSync(visuals) || !statSync(visuals).isDirectory()) {
      addError('missing-required', '缺少必需目录: visuals/', { path: 'visuals/' });
    }

    const minutesPath = resolve(root, 'meeting-minutes.md');
    if (existsSync(minutesPath)) {
      const minutes = readText(minutesPath, 'meeting-minutes.md');
      const requiredSections = ['总结', '关键结论', '待办', '智能章节', '金句时刻', '完整转录'];
      for (const section of requiredSections) {
        const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`^#{2,6}\\s+${escaped}\\s*$`, 'm').test(minutes)) {
          addError('missing-section', `正文缺少必需章节: ${section}`, { section });
        }
      }
    }

    const sourceMapPath = resolve(root, 'source-map.json');
    if (existsSync(sourceMapPath)) {
      const sourceMap = readJson(sourceMapPath, 'source-map.json');
      if (sourceMap && !Array.isArray(sourceMap.items)) {
        addError('invalid-source-map', 'source-map.json 的 items 必须是数组');
      }
      for (const item of sourceMap?.items || []) {
        const isCritical = ['decision', 'key_conclusion', 'action_item'].includes(item.kind);
        if (!item.id || !item.kind || !item.summary || !item.status) {
          addError('invalid-source-item', '证据项缺少 id、kind、summary 或 status', { item_id: item.id || null });
          continue;
        }
        if (isCritical && item.status === 'confirmed' && (!Array.isArray(item.evidence) || item.evidence.length === 0)) {
          addError('missing-evidence', '已确认的关键结论或待办必须有原文证据', { item_id: item.id });
        }
        for (const evidence of item.evidence || []) {
          if (!evidence.timestamp || !evidence.speaker || !evidence.quote) {
            addError('invalid-evidence', '证据必须包含 timestamp、speaker 和 quote', { item_id: item.id });
          }
        }
        if (isCritical && item.status === 'unconfirmed' && !item.unresolved_reason) {
          addError('missing-unresolved-reason', '未确认的关键项必须说明缺失或歧义原因', { item_id: item.id });
        }
      }
    }

    const planPath = resolve(root, 'publish-plan.json');
    if (existsSync(planPath)) {
      const plan = readJson(planPath, 'publish-plan.json');
      if (plan && (!plan.target || typeof plan.target !== 'object')) {
        addError('invalid-publish-plan', 'publish-plan.json 缺少 target');
      }
      if (plan && (!Array.isArray(plan.operations) || plan.operations.length === 0)) {
        addError('invalid-publish-plan', 'publish-plan.json 的 operations 必须是非空数组');
      }
      for (const operation of plan?.operations || []) {
        if (!operation.id || !['replace', 'insert', 'append', 'preserve', 'delete'].includes(operation.action)) {
          addError('invalid-operation', '发布操作缺少 id 或 action 不受支持', { operation_id: operation.id || null });
        }
        if (['replace', 'insert', 'delete'].includes(operation.action) && !operation.anchor) {
          addError('missing-anchor', '替换、插入或删除操作必须声明目标位置', { operation_id: operation.id || null });
        }
        const source = operation.content?.source;
        if (typeof source === 'string' && source) validateAssetSource(root, source, operation.id || null);
      }
    }

    const previewPath = resolve(root, 'preview.html');
    if (existsSync(previewPath)) {
      const preview = readText(previewPath, 'preview.html');
      if (!/<main\b[^>]*data-meeting-minutes-preview/i.test(preview)) {
        addError('invalid-preview', 'preview.html 缺少 data-meeting-minutes-preview 主容器');
      }
      if (!/<title>[^<]+<\/title>/i.test(preview)) {
        addError('invalid-preview', 'preview.html 缺少非空 title');
      }
    }
  }
}

const result = {
  ok: errors.length === 0,
  package: packageArg ? resolve(packageArg) : null,
  errors,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
