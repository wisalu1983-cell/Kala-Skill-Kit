/**
 * feishu-doc-writer.mjs
 *
 * 本地化飞书文档写入工具，替代 feishu_doc 工具的 write/append/create/read 能力
 * 支持所有 Markdown 元素（标题/段落/列表/嵌套列表/引用/代码块/分割线/行内样式/表格/图片）
 * 不依赖飞书 /docx/v1/documents/convert API（该接口对本 bot 返回 404）
 *
 * 表格写入通过 Descendant API 实现，支持大表格自动分块（>499 cells）
 *
 * 用法（作为模块引入）：
 *   import { FeishuDocWriter } from './feishu-doc-writer.mjs';
 *   const w = new FeishuDocWriter();
 *   await w.init();
 *   await w.write('DOC_TOKEN', '# 标题\n\n| A | B |\n|---|---|\n| 1 | 2 |');
 *
 * 用法（CLI 测试）：
 *   node feishu-doc-writer.mjs test [doc_token]
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { loadAppCredentials, tokenFile, FEISHU_BASE } from './feishu-config.mjs';

// ─── Block Type 常量 ─────────────────────────────────────────────────────────
const BT = {
  Page: 1,
  Text: 2,
  Heading1: 3,
  Heading2: 4,
  Heading3: 5,
  Heading4: 6,
  Heading5: 7,
  Heading6: 8,
  BulletItem: 12,
  OrderedItem: 13,
  Code: 14,
  Quote: 15,
  Divider: 22,
  Image: 27,
  Table: 31,
  TableCell: 32,
  QuoteContainer: 34,
};

// ─── 表格常量 ────────────────────────────────────────────────────────────────
const DEFAULT_TABLE_WIDTH = 880; // 飞书文档内容区约 900px，留 20px 余量（原为 600，导致每张表浪费约三分之一宽度、短列被压到 MIN）
const MIN_COLUMN_WIDTH = 60;
// 图片显示尺寸上限（px）。replace_image 接受 width/height；不传则飞书按原始像素显示，
// 2x 渲染的图会占满甚至超出一屏。按比例缩到框内，保持长宽比。
const MAX_IMAGE_WIDTH = 880;
const MAX_IMAGE_HEIGHT = 720;
const MAX_COLUMN_WIDTH = 480;
const MAX_CELLS = 499; // Descendant API 上限 1000 blocks，cells*2+1 ≤ 999 → cells ≤ 499

// block_type → 字段名映射
const BT_KEY = {
  [BT.Text]: 'text',
  [BT.Heading1]: 'heading1',
  [BT.Heading2]: 'heading2',
  [BT.Heading3]: 'heading3',
  [BT.Heading4]: 'heading4',
  [BT.Heading5]: 'heading5',
  [BT.Heading6]: 'heading6',
  [BT.BulletItem]: 'bullet',
  [BT.OrderedItem]: 'ordered',
  [BT.Quote]: 'quote',
};

// 代码语言枚举（飞书官方整数枚举）
const LANG_ENUM = {
  plaintext: 1, text: 1, plain: 1, '': 1,
  abap: 2, ada: 3, apache: 4, apex: 5,
  asm: 6, assembly: 6,
  bash: 7, sh: 7, shell: 58,
  cs: 8, csharp: 8, 'c#': 8,
  cpp: 9, 'c++': 9,
  c: 10,
  cobol: 11,
  css: 12,
  coffeescript: 13,
  dart: 15,
  dockerfile: 18, docker: 18,
  erlang: 19,
  go: 22, golang: 22,
  groovy: 23,
  html: 24,
  http: 26,
  haskell: 27,
  json: 28,
  java: 29,
  js: 30, javascript: 30,
  julia: 31,
  kotlin: 32, kt: 32,
  latex: 33, tex: 33,
  lisp: 34,
  lua: 36,
  matlab: 37,
  makefile: 38, make: 38,
  markdown: 39, md: 39,
  nginx: 40,
  objc: 41, 'objective-c': 41,
  php: 43,
  perl: 44,
  powershell: 46, ps1: 46,
  protobuf: 48, proto: 48,
  py: 49, python: 49,
  r: 50,
  ruby: 52, rb: 52,
  rust: 53, rs: 53,
  scss: 55,
  sql: 56,
  scala: 57,
  swift: 59,
  ts: 61, typescript: 61,
  xml: 64,
  yaml: 65, yml: 65,
  cmake: 66,
  diff: 67,
  graphql: 69, gql: 69,
  toml: 73,
};

// ─── Block 构造函数 ──────────────────────────────────────────────────────────

function textRun(content, style = {}) {
  return {
    text_run: {
      content,
      text_element_style: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        inline_code: false,
        ...style,
      },
    },
  };
}

/**
 * 解析行内 markdown 样式，返回 elements 数组
 * 支持：**bold** *italic* ~~strike~~ `code` [text](url)
 */
function parseInline(text) {
  const elements = [];
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;

  for (const m of text.matchAll(re)) {
    if (m.index > last) elements.push(textRun(text.slice(last, m.index)));
    const [full,, bold, italic, strike, code, linkText, linkUrl] = m;
    if (full.startsWith('**'))      elements.push(textRun(bold,     { bold: true }));
    else if (full.startsWith('*'))  elements.push(textRun(italic,   { italic: true }));
    else if (full.startsWith('~~')) elements.push(textRun(strike,   { strikethrough: true }));
    else if (full.startsWith('`'))  elements.push(textRun(code,     { inline_code: true }));
    else {
      // 链接
      const el = textRun(linkText);
      el.text_run.text_element_style.link = { url: linkUrl };
      elements.push(el);
    }
    last = m.index + full.length;
  }

  if (last < text.length) elements.push(textRun(text.slice(last)));
  return elements.length ? elements : [textRun(text)];
}

function makeTextBlock(type, text) {
  return {
    block_type: type,
    [BT_KEY[type]]: {
      elements: parseInline(text),
      style: {},
    },
  };
}

function makeCodeBlock(code, lang = '') {
  const langEnum = LANG_ENUM[lang.toLowerCase()] ?? 1;
  return {
    block_type: BT.Code,
    code: {
      elements: [textRun(code)],
      style: { language: langEnum, wrap: false },
    },
  };
}

// ─── 表格解析 ────────────────────────────────────────────────────────────────

/**
 * 解析一行表格，返回单元格文本数组
 * "| A | B | C |" → ["A", "B", "C"]
 */
function parseTableRow(line) {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const end = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  return end.split('|').map(cell => cell.trim());
}

/**
 * 判断是否为分隔行（|---|---|）
 */
function isSeparatorRow(line) {
  return /^\|?\s*[-:]+[-:\s|]*\|?\s*$/.test(line.trim());
}

/**
 * 检测一行是否为表格起始行
 */
export function isTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return false;
  if (isSeparatorRow(trimmed)) return false;
  return (trimmed.match(/\|/g) || []).length >= 2;
}

/**
 * 从 Markdown 行数组中提取表格
 * 返回 { rows: string[][], endLine }
 * rows[0] 是表头，rows[1..] 是数据行（分隔行被跳过）
 */
export function parseMarkdownTable(lines, startIndex) {
  const rows = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line.startsWith('|') && !line.includes('|')) break;
    if (line === '') break;

    if (isSeparatorRow(line)) {
      i++;
      continue;
    }

    rows.push(parseTableRow(line));
    i++;
  }

  return { rows, endLine: i };
}

// ─── 表格 Block 树构造 ──────────────────────────────────────────────────────

/**
 * 计算自适应列宽
 */
/** 读取 PNG / JPEG 的像素尺寸（失败返回 null，调用方退回飞书自动检测） */
export function readImageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** 按比例缩到 MAX_IMAGE_WIDTH x MAX_IMAGE_HEIGHT 内；本来就小于上限则原样返回 */
export function fitImageSize(size) {
  if (!size) return null;
  const r = Math.min(1, MAX_IMAGE_WIDTH / size.w, MAX_IMAGE_HEIGHT / size.h);
  return { width: Math.round(size.w * r), height: Math.round(size.h * r) };
}

function calculateColumnWidths(rows, colCount) {
  const totalWidth = DEFAULT_TABLE_WIDTH;

  const maxLengths = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const text = row[c] || '';
      const len = [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 2 : 1), 0);
      maxLengths[c] = Math.max(maxLengths[c], len);
    }
  }

  const totalLength = maxLengths.reduce((a, b) => a + b, 0);
  if (totalLength === 0) {
    const equalWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.floor(totalWidth / colCount)));
    return new Array(colCount).fill(equalWidth);
  }

  let widths = maxLengths.map(len => {
    const proportion = len / totalLength;
    return Math.round(proportion * totalWidth);
  });

  widths = widths.map(w => Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, w)));

  let remaining = totalWidth - widths.reduce((a, b) => a + b, 0);
  while (remaining > 0) {
    const growable = widths.map((w, i) => w < MAX_COLUMN_WIDTH ? i : -1).filter(i => i >= 0);
    if (growable.length === 0) break;
    const perColumn = Math.floor(remaining / growable.length);
    if (perColumn === 0) break;
    for (const i of growable) {
      const add = Math.min(perColumn, MAX_COLUMN_WIDTH - widths[i]);
      widths[i] += add;
      remaining -= add;
    }
  }

  return widths;
}

/**
 * 构造 Descendant API 所需的 block 树
 * 返回 { children_id: string[], descendants: object[] }
 */
export function buildTableBlocks(rows) {
  if (rows.length === 0) return null;

  const rowCount = rows.length;
  const colCount = Math.max(...rows.map(r => r.length));

  const normalizedRows = rows.map(row => {
    const padded = [...row];
    while (padded.length < colCount) padded.push('');
    return padded;
  });

  const columnWidths = calculateColumnWidths(normalizedRows, colCount);

  const tableId = 't_table';
  const cellIds = [];
  const descendants = [];

  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const cellId = `t_r${r}c${c}`;
      const textId = `t_r${r}c${c}_text`;
      cellIds.push(cellId);

      const cellContent = normalizedRows[r][c] || '';

      descendants.push({
        block_id: textId,
        block_type: BT.Text,
        text: {
          elements: parseInline(cellContent),
          style: {},
        },
      });

      descendants.push({
        block_id: cellId,
        block_type: BT.TableCell,
        table_cell: {},
        children: [textId],
      });
    }
  }

  descendants.push({
    block_id: tableId,
    block_type: BT.Table,
    table: {
      property: {
        row_size: rowCount,
        column_size: colCount,
        column_width: columnWidths,
      },
    },
    children: cellIds,
  });

  return {
    children_id: [tableId],
    descendants,
  };
}

// ─── 嵌套列表解析与构造 ─────────────────────────────────────────────────────

/**
 * 解析一组连续的列表项（支持缩进嵌套）
 * 返回 { items: [{type, text, children: [...]}], endLine }
 */
function parseListGroup(lines, startIndex) {
  const stack = []; // [{indent, item}]
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];
    // 匹配列表行（允许前导空格）
    const m = line.match(/^(\s*)([\-\*\+]|\d+\.)\s+(.+)$/);
    if (!m) break;

    const indent = m[1].length;
    const marker = m[2];
    const text = m[3];
    const type = /^\d+\./.test(marker) ? BT.OrderedItem : BT.BulletItem;
    const item = { type, text, children: [] };

    // 找到当前 item 的父节点
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (stack.length > 0) {
      stack[stack.length - 1].item.children.push(item);
    }

    stack.push({ indent, item });
    i++;
  }

  // 提取顶层 items（indent 最小的那些）
  const allItems = [];
  const minIndent = stack.length > 0 ? Math.min(...stack.map(s => s.indent)) : 0;
  // 重新遍历构建树
  const result = [];
  const buildStack = [];
  let j = startIndex;
  while (j < i) {
    const line = lines[j];
    const m = line.match(/^(\s*)([\-\*\+]|\d+\.)\s+(.+)$/);
    const indent = m[1].length;
    const marker = m[2];
    const text = m[3];
    const type = /^\d+\./.test(marker) ? BT.OrderedItem : BT.BulletItem;
    const item = { type, text, children: [] };

    while (buildStack.length > 0 && buildStack[buildStack.length - 1].indent >= indent) {
      buildStack.pop();
    }

    if (buildStack.length > 0) {
      buildStack[buildStack.length - 1].item.children.push(item);
    } else {
      result.push(item);
    }

    buildStack.push({ indent, item });
    j++;
  }

  return { items: result, endLine: i };
}

/**
 * 构造嵌套列表的 Descendant API block 树
 */
export function buildNestedListBlocks(items) {
  let idCounter = 0;
  const descendants = [];
  const topIds = [];

  function processItem(item) {
    const id = `nl_${idCounter++}`;
    const childIds = [];

    for (const child of (item.children || [])) {
      childIds.push(processItem(child));
    }

    const key = item.type === BT.BulletItem ? 'bullet' : 'ordered';
    const block = {
      block_id: id,
      block_type: item.type,
      [key]: {
        elements: parseInline(item.text),
        style: {},
      },
    };

    if (childIds.length > 0) {
      block.children = childIds;
    }

    descendants.push(block);
    return id;
  }

  for (const item of items) {
    topIds.push(processItem(item));
  }

  return { children_id: topIds, descendants };
}

// ─── QuoteContainer 构造 ────────────────────────────────────────────────────

/**
 * 构造 QuoteContainer 的 Descendant API block 树
 * QuoteContainer (type 34) 是容器 block，内部嵌套 Text 子 block
 * @param {string[]} lines - QuoteContainer 内的文本行
 */
export function buildQuoteContainerBlocks(lines) {
  const containerId = 'qc_container';
  const descendants = [];
  const childIds = [];

  for (let i = 0; i < lines.length; i++) {
    const textId = `qc_text_${i}`;
    childIds.push(textId);
    descendants.push({
      block_id: textId,
      block_type: BT.Text,
      text: {
        elements: parseInline(lines[i]),
        style: {},
      },
    });
  }

  descendants.push({
    block_id: containerId,
    block_type: BT.QuoteContainer,
    quote_container: {},
    children: childIds,
  });

  return { children_id: [containerId], descendants };
}

// ─── Markdown → Blocks 转换 ──────────────────────────────────────────────────

export function markdownToBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // 代码块
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      blocks.push(makeCodeBlock(code.join('\n'), lang));
      i++;
      continue;
    }

    // QuoteContainer（>>>...>>> 语法）
    if (trimmed === '>>>') {
      const qcLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '>>>') {
        qcLines.push(lines[i]);
        i++;
      }
      if (qcLines.length > 0) {
        blocks.push({ _type: 'quote_container', lines: qcLines });
      }
      i++; // 跳过结束的 >>>
      continue;
    }

    // 表格检测（在代码块检测之后）
    if (isTableLine(line)) {
      const { rows, endLine } = parseMarkdownTable(lines, i);
      if (rows.length > 0) {
        blocks.push({ _type: 'table', rows });
      }
      i = endLine;
      continue;
    }

    // 图片（独立行）
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      blocks.push({ _type: 'image', alt: imgMatch[1], url: imgMatch[2] });
      i++;
      continue;
    }

    // 分割线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ block_type: BT.Divider, divider: {} });
      i++;
      continue;
    }

    // 标题 H1-H6
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const lvl = hm[1].length;
      const typeMap = [null, BT.Heading1, BT.Heading2, BT.Heading3, BT.Heading4, BT.Heading5, BT.Heading6];
      blocks.push(makeTextBlock(typeMap[lvl], hm[2]));
      i++;
      continue;
    }

    // 无序列表（支持嵌套）
    const bm = line.match(/^[\-\*\+]\s+(.+)$/);
    if (bm) {
      const { items, endLine } = parseListGroup(lines, i);
      if (items.some(it => it.children && it.children.length > 0)) {
        blocks.push({ _type: 'nested_list', items });
      } else {
        for (const it of items) blocks.push(makeTextBlock(it.type, it.text));
      }
      i = endLine;
      continue;
    }

    // 有序列表（支持嵌套）
    const om = line.match(/^\d+\.\s+(.+)$/);
    if (om) {
      const { items, endLine } = parseListGroup(lines, i);
      if (items.some(it => it.children && it.children.length > 0)) {
        blocks.push({ _type: 'nested_list', items });
      } else {
        for (const it of items) blocks.push(makeTextBlock(it.type, it.text));
      }
      i = endLine;
      continue;
    }

    // 引用
    const qm = line.match(/^>\s*(.+)$/);
    if (qm) {
      blocks.push(makeTextBlock(BT.Quote, qm[1]));
      i++;
      continue;
    }

    // 空行跳过
    if (!trimmed) {
      i++;
      continue;
    }

    // 普通段落
    blocks.push(makeTextBlock(BT.Text, line));
    i++;
  }

  return blocks;
}

// ─── API 客户端 ─────────────────────────────────────────────────────────────

export class FeishuDocWriter {
  constructor(options = {}) {
    this.token = null;
    this.tokenType = null; // 'user' or 'tenant'
    this.base = FEISHU_BASE;
    this._userTokenFile = tokenFile();
    // oauth \u7BA1\u5BB6\u4E0E\u672C\u6587\u4EF6\u540C\u76EE\u5F55
    this._oauthScript = fileURLToPath(new URL('./feishu-oauth.mjs', import.meta.url));
  }

  async init() {
    const { appId, appSecret } = loadAppCredentials();
    this._appId = appId;
    this._appSecret = appSecret;

    // 优先尝试 user_access_token
    if (await this._tryUserToken()) {
      return;
    }
    // 降级到 tenant_access_token
    await this._refreshTenantToken();
  }

  async _tryUserToken() {
    if (!existsSync(this._userTokenFile)) return false;
    try {
      const data = JSON.parse(readFileSync(this._userTokenFile, 'utf8'));
      if (!data.access_token) return false;

      const now = Date.now();
      // access_token 还有效（留 5 分钟余量）
      if (data.access_expires_at && data.access_expires_at > now + 300_000) {
        this.token = data.access_token;
        this.tokenType = 'user';
        return true;
      }

      // access_token 过期时，只允许通过 feishu-oauth.mjs 管家刷新，避免 refresh_token 链断裂
      if (data.refresh_token && data.refresh_expires_at && data.refresh_expires_at > now) {
        const refreshed = this._refreshUserTokenViaManager();
        if (refreshed) return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  _refreshUserTokenViaManager() {
    try {
      if (!existsSync(this._oauthScript)) return false;
      const token = execFileSync(process.execPath, [this._oauthScript, 'get'], {
        encoding: 'utf8',
        env: process.env,
      }).trim();
      if (!token) return false;
      this.token = token;
      this.tokenType = 'user';
      return true;
    } catch {
      return false;
    }
  }

  async _refreshTenantToken() {
    const r = await fetch(`${this.base}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this._appId, app_secret: this._appSecret }),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(`Token error: ${d.msg}`);
    this.token = d.tenant_access_token;
    this.tokenType = 'tenant';
  }

  async _get(path, query = {}) {
    const qs = new URLSearchParams(query).toString();
    const url = `${this.base}${path}${qs ? '?' + qs : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    const d = await r.json();
    if (d.code !== 0) throw new Error(`Feishu ${d.code}: ${d.msg} [GET ${path}]`);
    return d.data;
  }

  async _post(path, body) {
    const r = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(`Feishu ${d.code}: ${d.msg} [POST ${path}]`);
    return d.data;
  }

  async _delete(path, body) {
    const r = await fetch(`${this.base}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(`Feishu ${d.code}: ${d.msg} [DELETE ${path}]`);
    return d.data;
  }

  async _patch(path, body) {
    const r = await fetch(`${this.base}${path}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(`Feishu ${d.code}: ${d.msg} [PATCH ${path}]`);
    return d.data;
  }

  /** 上传图片到飞书 Drive（multipart form data） */
  async _uploadMedia(docToken, blockId, buffer, fileName) {
    const boundary = '----FormBoundary' + Date.now().toString(36);
    const parts = [];

    const fields = {
      file_name: fileName,
      parent_type: 'docx_image',
      parent_node: blockId,
      size: String(buffer.length),
      extra: JSON.stringify({ drive_route_token: docToken }),
    };

    for (const [key, val] of Object.entries(fields)) {
      parts.push(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      );
    }

    // 文件部分
    const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const fileFooter = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(fileHeader);
    const footerBuf = Buffer.from(fileFooter);
    const fieldsBuf = Buffer.from(parts.join(''));
    const body = Buffer.concat([fieldsBuf, headerBuf, buffer, footerBuf]);

    const r = await fetch(`${this.base}/drive/v1/medias/upload_all`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const d = await r.json();
    if (d.code !== 0) throw new Error(`Feishu ${d.code}: ${d.msg} [upload_all]`);
    return d.data?.file_token;
  }

  /** 插入图片：下载→创建占位block→上传→关联 */
  async _insertImage(docToken, url, alt = '') {
    // 1. 下载图片
    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`Image download failed: ${imgRes.status} ${url}`);
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const fileName = url.split('/').pop().split('?')[0] || 'image.png';

    // 2. 创建占位 image block
    const insertData = await this._post(
      `/docx/v1/documents/${docToken}/blocks/${docToken}/children`,
      { children: [{ block_type: BT.Image, image: {} }], index: -1 }
    );
    const imageBlockId = insertData?.children?.[0]?.block_id;
    if (!imageBlockId) throw new Error('Failed to create image placeholder block');

    // 3. 上传图片
    const fileToken = await this._uploadMedia(docToken, imageBlockId, buffer, fileName);
    if (!fileToken) throw new Error('Failed to upload image');

    // 4. 关联图片到 block
    const fitted = fitImageSize(readImageSize(buffer));
    await this._patch(
      `/docx/v1/documents/${docToken}/blocks/${imageBlockId}`,
      { replace_image: { token: fileToken, ...(fitted || {}) } }
    );

    return { success: true, block_id: imageBlockId, file_token: fileToken };
  }

  /** 列出文档所有 blocks（自动翻页） */
  async _listBlocks(docToken) {
    const items = [];
    let pageToken = undefined;
    do {
      const q = { page_size: '200' };
      if (pageToken) q.page_token = pageToken;
      const d = await this._get(`/docx/v1/documents/${docToken}/blocks`, q);
      items.push(...(d.items || []));
      pageToken = d.page_token;
    } while (pageToken);
    return items;
  }

  /** 清空文档正文（保留 Page block 本身） */
  async _clear(docToken) {
    const all = await this._listBlocks(docToken);
    const children = all.filter(b => b.parent_id === docToken && b.block_type !== BT.Page);
    if (children.length === 0) return 0;
    await this._delete(
      `/docx/v1/documents/${docToken}/blocks/${docToken}/children/batch_delete`,
      { start_index: 0, end_index: children.length }
    );
    return children.length;
  }

  /** 往文档末尾插入普通 blocks（自动分批，每批最多 50，每批间隔 400ms 避免限频） */
  async _insert(docToken, blocks) {
    const BATCH = 50;
    let total = 0;
    for (let i = 0; i < blocks.length; i += BATCH) {
      if (i > 0) await new Promise(r => setTimeout(r, 400)); // 限频保护
      const batch = blocks.slice(i, i + BATCH);
      await this._post(`/docx/v1/documents/${docToken}/blocks/${docToken}/children`, {
        children: batch,
        index: -1,
      });
      total += batch.length;
    }
    return total;
  }

  /** 通过 Descendant API 插入表格（cells ≤ 499） */
  async _insertViaDescendant(docToken, tableData, parentBlockId, index) {
    return this._post(
      `/docx/v1/documents/${docToken}/blocks/${parentBlockId}/descendant`,
      {
        children_id: tableData.children_id,
        descendants: tableData.descendants,
        index,
      }
    );
  }

  /** 大表格：拆成多个子表格写入（每个子表格 cells ≤ 499），共享表头 */
  async _insertLargeTable(docToken, rows, parentBlockId, index) {
    const colCount = Math.max(...rows.map(r => r.length));
    const maxRowsPerChunk = Math.floor(MAX_CELLS / colCount);
    if (maxRowsPerChunk < 2) throw new Error(`Table too wide (${colCount} cols): max supported with chunking is ${MAX_CELLS} cells`);

    const headerRow = rows[0];
    const dataRows = rows.slice(1);
    const chunks = [];
    for (let i = 0; i < dataRows.length; i += maxRowsPerChunk - 1) {
      const chunkData = dataRows.slice(i, i + maxRowsPerChunk - 1);
      chunks.push([headerRow, ...chunkData]);
    }

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 400));
      const tableData = buildTableBlocks(chunks[i]);
      const data = await this._insertViaDescendant(docToken, tableData, parentBlockId, -1);
      results.push({
        chunk: i + 1,
        rows: chunks[i].length,
        block_id_relations: data?.block_id_relations,
      });
    }

    return {
      chunks: results.length,
      total_rows: rows.length,
      details: results,
    };
  }

  /**
   * 插入表格（自动判断大小）
   * cells ≤ 499 → 一次 Descendant API，超过 → 自动分块
   */
  async insertTable(docToken, rows, options = {}) {
    if (rows.length === 0) throw new Error('Empty table data');

    const parentBlockId = options.parentBlockId || docToken;
    const index = options.index ?? -1;
    const colCount = Math.max(...rows.map(r => r.length));
    const totalCells = rows.length * colCount;

    if (totalCells <= MAX_CELLS) {
      const tableData = buildTableBlocks(rows);
      if (!tableData) throw new Error('Empty table data');
      const data = await this._insertViaDescendant(docToken, tableData, parentBlockId, index);
      return {
        success: true,
        rows: rows.length,
        cols: colCount,
        method: 'descendant',
        block_id_relations: data?.block_id_relations,
      };
    } else {
      const result = await this._insertLargeTable(docToken, rows, parentBlockId, index);
      return {
        success: true,
        rows: rows.length,
        cols: colCount,
        method: 'chunked',
        chunks: result.chunks,
        total_rows: result.total_rows,
      };
    }
  }

  /** 插入混合内容（普通 blocks + 表格 + 图片 + 嵌套列表交替） */
  async _insertMixed(docToken, blocks) {
    const hasSpecial = blocks.some(b => b._type);
    if (!hasSpecial) return this._insert(docToken, blocks);

    let total = 0;
    let normalBatch = [];

    const flushNormal = async () => {
      if (normalBatch.length > 0) {
        total += await this._insert(docToken, normalBatch);
        normalBatch = [];
        await new Promise(r => setTimeout(r, 400));
      }
    };

    for (const block of blocks) {
      if (block._type === 'table') {
        await flushNormal();
        await this.insertTable(docToken, block.rows);
        total++;
        await new Promise(r => setTimeout(r, 400));
      } else if (block._type === 'image') {
        await flushNormal();
        await this._insertImage(docToken, block.url, block.alt);
        total++;
        await new Promise(r => setTimeout(r, 400));
      } else if (block._type === 'nested_list') {
        await flushNormal();
        const listData = buildNestedListBlocks(block.items);
        await this._insertViaDescendant(docToken, listData, docToken, -1);
        total += block.items.length;
        await new Promise(r => setTimeout(r, 400));
      } else if (block._type === 'quote_container') {
        await flushNormal();
        const qcData = buildQuoteContainerBlocks(block.lines);
        await this._insertViaDescendant(docToken, qcData, docToken, -1);
        total++;
        await new Promise(r => setTimeout(r, 400));
      } else {
        normalBatch.push(block);
      }
    }

    if (normalBatch.length > 0) {
      total += await this._insert(docToken, normalBatch);
    }

    return total;
  }

  // ─── 公开方法 ─────────────────────────────────────────────────────────────

  /** 读取文档（返回标题 + blocks 列表） */
  async read(docToken) {
    const [doc, blocks] = await Promise.all([
      this._get(`/docx/v1/documents/${docToken}`),
      this._listBlocks(docToken),
    ]);
    return { title: doc.document?.title, block_count: blocks.length, blocks };
  }

  /** 替换文档全部正文内容 */
  async write(docToken, markdown) {
    const blocks = markdownToBlocks(markdown);
    const deleted = await this._clear(docToken);
    if (blocks.length === 0) return { success: true, blocks_deleted: deleted, blocks_added: 0 };
    const added = await this._insertMixed(docToken, blocks);
    return { success: true, blocks_deleted: deleted, blocks_added: added };
  }

  /** 追加内容到文档末尾 */
  async append(docToken, markdown) {
    const blocks = markdownToBlocks(markdown);
    if (blocks.length === 0) throw new Error('Content is empty');
    const added = await this._insertMixed(docToken, blocks);
    return { success: true, blocks_added: added };
  }

  /** 创建新文档 */
  async create(title, folderToken = null, ownerOpenId = null) {
    const body = { title };
    if (folderToken) body.folder_token = folderToken;
    const data = await this._post('/docx/v1/documents', body);
    // 如果用的是 tenant token 且指定了 owner，给他加编辑权限
    if (this.tokenType === 'tenant' && ownerOpenId && data?.document?.document_id) {
      const docId = data.document.document_id;
      try {
        await this._post(`/drive/v1/permissions/${docId}/members?type=docx`, {
          member_type: 'openid',
          member_id: ownerOpenId,
          perm: 'edit',
          type: 'user',
        });
      } catch (e) {
        // 权限授予失败不影响创建成功
        console.warn('Warning: could not grant permission:', e.message);
      }
    }
    return data?.document;
  }
}

// ─── CLI 测试入口 ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] && (process.argv[1].endsWith('feishu-doc-writer.mjs') || process.argv[1].endsWith('feishu-doc-writer'));
if (isMain) {
  const [,, action, docToken] = process.argv;
  if (!docToken) {
    console.error('用法: node feishu-doc-writer.mjs <test|read|append> <doc_token>');
    process.exit(1);
  }
  const w = new FeishuDocWriter();
  await w.init();
  console.log('Feishu token OK');

  const testDoc = docToken;

  if (!action || action === 'test') {
    console.log(`Writing to doc: ${testDoc}`);
    const result = await w.write(testDoc, `# 小埋の碎碎念

这是用本地转换器写入的第一篇文章。包含各种格式测试。

## 行内样式

普通段落里有**粗体**、*斜体*、~~删除线~~、\`inline code\`，还有[链接](https://feishu.cn)。

## 列表

- 第一项（无序）
- 第二项，带**粗体**
- 第三项

1. 步骤一
2. 步骤二
3. 步骤三

## 引用

> 能躺着绝不坐着，能坐着绝不站着。

## 代码块

\`\`\`javascript
const umaru = {
  mode: '在家',
  snack: '薯片',
  drink: '可乐',
};
console.log('天才小埋✌️');
\`\`\`

## 表格

| 功能 | 状态 | 备注 |
|------|------|------|
| 标题 | ✅ 完成 | H1-H6 |
| 段落 | ✅ 完成 | 含行内样式 |
| 列表 | ✅ 完成 | 有序+无序 |
| 代码块 | ✅ 完成 | 73种语言 |
| 引用 | ✅ 完成 | blockquote |
| **表格** | ✅ **已合并** | Descendant API |

---

*写入完成 🐹*`);
    console.log('Result:', JSON.stringify(result, null, 2));

  } else if (action === 'read') {
    const result = await w.read(testDoc);
    console.log('Title:', result.title);
    console.log('Block count:', result.block_count);

  } else if (action === 'append') {
    const result = await w.append(testDoc, '\n## 追加内容\n\n这是追加的一段。\n');
    console.log('Append result:', JSON.stringify(result, null, 2));
  }
}
