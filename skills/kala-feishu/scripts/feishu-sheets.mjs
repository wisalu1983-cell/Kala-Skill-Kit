/**
 * feishu-sheets.mjs —— 飞书电子表格(Sheets)读写(用户身份 user_access_token)。
 *
 * 关键概念:一个「电子表格」(spreadsheet_token)里有多张「工作表」(sheet_id)。
 * 单元格区域用 A1 记法且**必须带 sheet_id 前缀**:`{sheet_id}!A1:C10`。
 * 只写 `A1:C10` 飞书不知道是哪张工作表,会报错。
 *
 * ⚠️ 单元格值的读写走 v2 接口(`/sheets/v2/.../values`),不是 v3——v3 没有单元格值接口。
 *    官方 lark-mcp SDK 也缺这块,这是自己实现的原因之一。
 */
import { readFileSync, writeFileSync } from 'fs';
import { api, printResult, fail } from './feishu-api.mjs';
import { parseCsv, coerceValue, toCsv } from './feishu-csv.mjs';
import { parseArgv, confirmDestructive } from './feishu-cli.mjs';
import { autoSelectAccount } from './feishu-route.mjs';

// ── A1 记法 ────────────────────────────────────────────────────

/** 1 → A,27 → AA */
export function colLetter(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** 'E1' → { col: 5, row: 1 } */
export function parseA1(cell) {
  const m = /^([A-Za-z]+)(\d+)$/.exec(String(cell).trim());
  if (!m) throw new Error(`起始单元格格式错: ${cell}(应形如 A1)`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

/** 由起点 + 数据大小算出 A1 区间,例:('E1', 3 行 3 列) → 'E1:G3' */
export function rangeFor(startCell, rowCount, colCount) {
  const { col, row } = parseA1(startCell);
  return `${colLetter(col)}${row}:${colLetter(col + colCount - 1)}${row + rowCount - 1}`;
}

/** 拆 `sheetId!A1:E10` → { sheetId, start, end, rows, cols } */
export function parseRange(range) {
  const idx = String(range).indexOf('!');
  if (idx < 0) throw new Error(`range 必须带 sheet_id 前缀,例 sheetId!A1:C10,收到: ${range}`);
  const sheetId = range.slice(0, idx);
  const [start, end] = range.slice(idx + 1).split(':');
  const s = parseA1(start);
  const e = end ? parseA1(end) : s;
  return { sheetId, start: s, end: e, rows: e.row - s.row + 1, cols: e.col - s.col + 1 };
}

// ── 表格操作 ───────────────────────────────────────────────────

/** 建电子表格。folderToken 省略则落到云盘根目录。 */
export async function createSpreadsheet(title, folderToken) {
  const body = { title };
  if (folderToken) body.folder_token = folderToken;
  const d = await api('POST', '/sheets/v3/spreadsheets', { body });
  const ss = d.spreadsheet || {};
  return { spreadsheet_token: ss.spreadsheet_token, title: ss.title, url: ss.url };
}

/** 列出所有工作表。 */
export async function listSheets(spreadsheetToken) {
  const d = await api('GET', `/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`);
  return (d.sheets || []).map(s => ({
    sheet_id: s.sheet_id,
    title: s.title,
    index: s.index,
    row_count: s.grid_properties?.row_count,
    column_count: s.grid_properties?.column_count,
  }));
}

/**
 * 写一个区域。**覆盖**该区域原有内容,不是插入——想追加用 append 那条路。
 * range 必须带 sheet_id 前缀:`{sheet_id}!A1:C2`。
 */
export async function writeRange(spreadsheetToken, range, values) {
  const d = await api('PUT', `/sheets/v2/spreadsheets/${spreadsheetToken}/values`, {
    body: { valueRange: { range, values } },
  });
  return { updated_cells: d.updatedCells, updated_range: d.updatedRange, updated_rows: d.updatedRows };
}

/** 读一个区域。range 必须带 sheet_id 前缀。 */
export async function readRange(spreadsheetToken, range) {
  const d = await api('GET', `/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}`);
  const vr = d.valueRange || {};
  return { range: vr.range, values: vr.values || [] };
}

/**
 * 追加行到工作表现有数据的**末尾**,不覆盖原内容 —— 与 writeRange 的语义区别就在这里。
 * 用飞书原生 values_append,由它自己定位最后一行,不靠客户端猜。
 * insertDataOption 用 OVERWRITE(写进已有数据下方的空白格),不用 INSERT_ROWS
 * (后者会插入新行、把下方无关数据整体推移)。
 */
export async function appendRows(spreadsheetToken, sheetId, values) {
  if (!values?.length) throw new Error('appendRows: values 为空');
  const cols = Math.max(...values.map(r => r.length));
  const grid = values.map(r => r.length === cols ? r : [...r, ...Array(cols - r.length).fill('')]);
  // range 只用来指明列范围(飞书自己找末行),但它的行数不能少于 values 的行数,
  // 否则报 90202 rows of value > range。
  const range = `${sheetId}!A1:${colLetter(cols)}${grid.length}`;
  const d = await api('POST', `/sheets/v2/spreadsheets/${spreadsheetToken}/values_append`, {
    query: { insertDataOption: 'OVERWRITE' },
    body: { valueRange: { range, values: grid } },
  });
  const u = d.updates || {};
  return { appended_rows: u.updatedRows, updated_range: u.updatedRange, updated_cells: u.updatedCells };
}

/**
 * 工作表结构变更统一入口(飞书把增/改/删都塞进同一个 batch_update)。
 * retryable 由调用方按操作语义给:改名/删除重做一遍结果相同,新增会多出一张表。
 */
async function sheetsBatchUpdate(spreadsheetToken, requests, retryable = false) {
  const d = await api('POST', `/sheets/v2/spreadsheets/${spreadsheetToken}/sheets_batch_update`, { body: { requests }, retryable });
  return d.replies || [];
}

/** 新增工作表。index 省略则加到最后。 */
export async function addSheet(spreadsheetToken, title, index) {
  const properties = { title };
  if (index !== undefined) properties.index = index;
  const replies = await sheetsBatchUpdate(spreadsheetToken, [{ addSheet: { properties } }]);
  const p = replies[0]?.addSheet?.properties || {};
  return { sheet_id: p.sheetId, title: p.title, index: p.index };
}

/** 工作表改名。 */
export async function renameSheet(spreadsheetToken, sheetId, title) {
  await sheetsBatchUpdate(spreadsheetToken, [{ updateSheet: { properties: { sheetId, title } } }], true);
  return { sheet_id: sheetId, title };
}

/** 删工作表。⚠️ 整张表的数据一起消失,CLI 层要求 --yes。 */
export async function deleteSheet(spreadsheetToken, sheetId) {
  await sheetsBatchUpdate(spreadsheetToken, [{ deleteSheet: { sheetId } }], true);
  return { deleted_sheet_id: sheetId };
}

// ── 行列增删 ───────────────────────────────────────────────────
//
// ⚠️ 飞书这两个接口的索引基准**不一致**,是历史坑,别想着合并:
//   插入 insert_dimension_range: startIndex 从 0 数,endIndex 不含(半开区间)
//   删除 dimension_range:        startIndex 从 1 数,endIndex 含  (闭区间)
// 本模块对外统一用**从 1 数的行/列号**(真人视角:第 1 行就是第 1 行),内部各自换算。

/** 在第 startRow 行**之前**插入 count 个空行(startRow 从 1 数)。 */
export async function insertRows(spreadsheetToken, sheetId, startRow, count = 1) {
  return insertDimension(spreadsheetToken, sheetId, 'ROWS', startRow, count);
}
/** 在第 startCol 列**之前**插入 count 个空列(startCol 从 1 数)。 */
export async function insertCols(spreadsheetToken, sheetId, startCol, count = 1) {
  return insertDimension(spreadsheetToken, sheetId, 'COLUMNS', startCol, count);
}
/** 删除第 startRow 行起的 count 行。⚠️ 数据真删,CLI 层要求 --yes。 */
export async function deleteRows(spreadsheetToken, sheetId, startRow, count = 1) {
  return deleteDimension(spreadsheetToken, sheetId, 'ROWS', startRow, count);
}
/** 删除第 startCol 列起的 count 列。⚠️ 整列数据一起消失,CLI 层要求 --yes。 */
export async function deleteCols(spreadsheetToken, sheetId, startCol, count = 1) {
  return deleteDimension(spreadsheetToken, sheetId, 'COLUMNS', startCol, count);
}

async function insertDimension(spreadsheetToken, sheetId, majorDimension, start1, count) {
  const startIndex = start1 - 1;               // 1-based → 0-based
  await api('POST', `/sheets/v2/spreadsheets/${spreadsheetToken}/insert_dimension_range`, {
    body: {
      dimension: { sheetId, majorDimension, startIndex, endIndex: startIndex + count },
      inheritStyle: 'BEFORE',
    },
  });
  return { inserted: count, at: start1, dimension: majorDimension };
}

async function deleteDimension(spreadsheetToken, sheetId, majorDimension, start1, count) {
  await api('DELETE', `/sheets/v2/spreadsheets/${spreadsheetToken}/dimension_range`, {
    body: {
      // 这个接口就是 1-based 闭区间,直接用真人行号
      dimension: { sheetId, majorDimension, startIndex: start1, endIndex: start1 + count - 1 },
    },
  });
  return { deleted: count, from: start1, dimension: majorDimension };
}

/** 清空区域内容(保留行列本身,只清值)。飞书没有专门的 clear 接口,写 null 即清空。 */
export async function clearRange(spreadsheetToken, range) {
  const { rows, cols } = parseRange(range);
  const empty = Array.from({ length: rows }, () => Array(cols).fill(null));
  const r = await writeRange(spreadsheetToken, range, empty);
  return { cleared_range: range, cleared_cells: rows * cols, updated_cells: r.updated_cells };
}

/** 把本地 CSV 文件写进指定工作表,从 startCell 起(默认 A1)。 */
export async function writeCsv(spreadsheetToken, sheetId, csvPath, { startCell = 'A1' } = {}) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).map(r => r.map(coerceValue));
  if (!rows.length) throw new Error(`CSV 没有数据: ${csvPath}`);
  const cols = Math.max(...rows.map(r => r.length));
  // 补齐短行:飞书要求 values 是规整矩形,行长不一会报错
  const grid = rows.map(r => r.length === cols ? r : [...r, ...Array(cols - r.length).fill('')]);
  const range = `${sheetId}!${rangeFor(startCell, grid.length, cols)}`;
  const r = await writeRange(spreadsheetToken, range, grid);
  return { rows: grid.length, cols, range, updated_cells: r.updated_cells };
}

/** 读本地 CSV 为二维数组(已做数字识别)。给 CLI 的 append 用。 */
function loadCsvGrid(csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8')).map(r => r.map(coerceValue));
  if (!rows.length) throw new Error(`CSV 没有数据: ${csvPath}`);
  return rows;
}

// ── URL / 区间解析 ─────────────────────────────────────────────

/**
 * 把用户给的东西统一成 spreadsheet_token,并顺带按域名自动选账号:
 *   https://x.feishu.cn/sheets/<token>  → token
 *   https://x.feishu.cn/wiki/<node>     → 该节点底层的 obj_token(知识库里的表格)
 *   裸 token                            → 原样
 */
export async function resolveSheetToken(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('缺少表格 token 或 URL');

  const wiki = s.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) {
    await autoSelectAccount({ url: s, wikiToken: wiki[1] });
    const { getNode } = await import('./feishu-wiki.mjs'); // 动态 import,避免顶层互相依赖
    const node = await getNode(wiki[1]);
    if (!node?.obj_token) throw new Error(`知识库节点解析不到 obj_token: ${wiki[1]}`);
    return node.obj_token;
  }
  const m = s.match(/\/(?:sheets|base)\/([A-Za-z0-9]+)/);
  if (m) {
    await autoSelectAccount({ url: s, sheetToken: m[1] });
    return m[1];
  }
  if (/^https?:\/\//.test(s)) throw new Error(`无法从这个 URL 提取表格 token: ${s}`);
  return s.split(/[?#]/)[0];
}

/** 第二个参数可以是完整区间(带 `!`)、sheet_id/工作表名(读整张)、或省略(读第一张)。 */
export async function resolveReadRange(spreadsheetToken, arg) {
  if (arg && arg.includes('!')) return arg;
  const sheets = await listSheets(spreadsheetToken);
  if (!sheets.length) throw new Error('这个表格里没有工作表');
  const sheet = arg ? sheets.find(s => s.sheet_id === arg || s.title === arg) : sheets[0];
  if (!sheet) {
    throw new Error(`找不到工作表「${arg}」。现有:${sheets.map(s => `${s.title}(${s.sheet_id})`).join('、')}`);
  }
  return `${sheet.sheet_id}!A1:${colLetter(sheet.column_count || 26)}${sheet.row_count || 1000}`;
}

/** 从完整区间里按行切一段。limitRows <= 0 表示到区间末尾。 */
export function sliceRange(fullRange, offsetRows, limitRows) {
  const { sheetId, start, end } = parseRange(fullRange);
  const first = Math.min(start.row + offsetRows, end.row);
  const last = limitRows > 0 ? Math.min(end.row, first + limitRows - 1) : end.row;
  return `${sheetId}!${colLetter(start.col)}${first}:${colLetter(end.col)}${last}`;
}

/** 导出用:分块拉完整个区间,并裁掉尾部的全空行(请求区间通常比实际数据大)。 */
const EXPORT_CHUNK = 500;
async function readAllRows(spreadsheetToken, fullRange) {
  const { rows: total } = parseRange(fullRange);
  const all = [];
  for (let off = 0; off < total; off += EXPORT_CHUNK) {
    const chunk = await readRange(spreadsheetToken, sliceRange(fullRange, off, EXPORT_CHUNK));
    all.push(...chunk.values);
    if (chunk.values.length < EXPORT_CHUNK) break; // 没给满 = 到底了
  }
  while (all.length && all[all.length - 1].every(c => c === null || c === '')) all.pop();
  return all;
}

// ── CLI ────────────────────────────────────────────────────────

/**
 * read 默认最多打印这么多行。这不是能力上限,是**保护 agent 的 context**:
 * 一张几千行的表全塞进对话会把上下文占满,读完也没空间干活。
 * 要全量就 --out 导出到文件(数据不进 context),要续读就 --offset。
 */
export const DEFAULT_READ_ROWS = 200;

const USAGE = `用法: node feishu-sheets.mjs <命令> ...

  create   <标题> [folder_token]                    建电子表格
  info     <token>                                  元信息 + 工作表清单
  read     <token> <sheet_id!A1:C10>                读区域
  write    <token> <sheet_id!A1:C10> <csv文件>      写区域(覆盖,输出里回显被覆盖的原值)
  append   <token> <sheet_id> <csv文件>             追加到现有数据末尾
  addsheet <token> <标题>                           加工作表
  rensheet <token> <sheet_id> <新名>                工作表改名
  delsheet <token> <sheet_id> --yes                 删工作表
  insrow   <token> <sheet_id> <起始行> [行数]        在该行前插入空行(行号从 1 数)
  delrow   <token> <sheet_id> <起始行> [行数] --yes  删行
  inscol   <token> <sheet_id> <起始列> [列数]        在该列前插入空列(列号从 1 数)
  delcol   <token> <sheet_id> <起始列> [列数] --yes  删列
  clear    <token> <sheet_id!A1:C10>                清空区域内容(输出里回显清掉的内容)

删除类命令必须带 --yes;不带时只打印预览并退出 1。`;

async function main() {
  const { flags, pos } = parseArgv(process.argv.slice(2));
  const [cmd, ...args] = pos;

  switch (cmd) {
    case 'create': {
      const [title, folder] = args;
      if (!title) return fail('用法: create <标题> [folder_token]');
      return printResult(await createSpreadsheet(title, folder));
    }
    case 'info': {
      const [raw] = args;
      if (!raw) return fail('用法: info <token|url>');
      const tk = await resolveSheetToken(raw);
      return printResult({ spreadsheet_token: tk, sheets: await listSheets(tk) });
    }
    case 'read': {
      const [raw, rangeArg] = args;
      if (!raw) return fail('用法: read <token|url> [sheet_id | sheet_id!A1:C10] [--limit N] [--offset N] [--out 文件]');
      const tk = await resolveSheetToken(raw);
      const full = await resolveReadRange(tk, rangeArg);
      const meta = parseRange(full);

      if (flags.out) {
        const rows = await readAllRows(tk, full);
        writeFileSync(flags.out, toCsv(rows), 'utf8');
        // 刻意不把数据放进 stdout —— --out 的全部意义就是让数据别进 context
        return printResult({ out: flags.out, rows: rows.length, cols: meta.cols, range: full });
      }

      const limit = flags.limit === undefined ? DEFAULT_READ_ROWS : Number(flags.limit);
      const offset = Number(flags.offset || 0);
      const sub = sliceRange(full, offset, limit);
      const got = await readRange(tk, sub);
      const returned = got.values.length;
      const total = meta.rows;
      const hasMore = limit > 0 && offset + returned < total;
      const out = { range: sub, values: got.values, returned, offset, total, has_more: hasMore };
      if (hasMore) {
        out.hint = `还有 ${total - offset - returned} 行未返回。继续读加 --offset ${offset + returned};`
          + '要全量分析改用 --out data.csv(导出到文件,不占 context)。';
      }
      return printResult(out);
    }
    case 'write': {
      const [raw, range, csv] = args;
      if (!raw || !range || !csv) return fail('用法: write <token|url> <sheet_id!A1:C10> <csv文件>');
      const tk = await resolveSheetToken(raw);
      // 覆盖不可逆,把原值一起回显出去,调用方要回滚有据可依
      let overwritten = [];
      try { overwritten = (await readRange(tk, range)).values; } catch { /* 空区域读不到,不阻塞 */ }
      const grid = loadCsvGrid(csv);
      const r = await writeRange(tk, range, grid);
      return printResult({ ...r, overwritten });
    }
    case 'append': {
      const [raw, sheetId, csv] = args;
      if (!raw || !sheetId || !csv) return fail('用法: append <token|url> <sheet_id> <csv文件>');
      const tk = await resolveSheetToken(raw);
      return printResult(await appendRows(tk, sheetId, loadCsvGrid(csv)));
    }
    case 'addsheet': {
      const [raw, title] = args;
      if (!raw || !title) return fail('用法: addsheet <token|url> <标题>');
      const tk = await resolveSheetToken(raw);
      return printResult(await addSheet(tk, title));
    }
    case 'rensheet': {
      const [raw, sheetId, ...rest] = args;
      const title = rest.join(' ');
      if (!raw || !sheetId || !title) return fail('用法: rensheet <token|url> <sheet_id> <新名>');
      const tk = await resolveSheetToken(raw);
      return printResult(await renameSheet(tk, sheetId, title));
    }
    case 'delsheet': {
      const [raw, sheetId] = args;
      if (!raw || !sheetId) return fail('用法: delsheet <token|url> <sheet_id> --yes');
      const tk = await resolveSheetToken(raw);
      const target = (await listSheets(tk)).find(s => s.sheet_id === sheetId);
      if (!target) return fail(`工作表不存在: ${sheetId}`);
      await confirmDestructive(flags, `删除工作表「${target.title}」(${target.row_count} 行 × ${target.column_count} 列)`,
        () => readRange(tk, `${sheetId}!A1:E5`).then(r => r.values));
      return printResult(await deleteSheet(tk, sheetId));
    }
    case 'insrow': case 'inscol': {
      const [raw, sheetId, start, count = '1'] = args;
      if (!raw || !sheetId || !start) return fail(`用法: ${cmd} <token|url> <sheet_id> <起始${cmd === 'insrow' ? '行' : '列'}> [数量]`);
      const tk = await resolveSheetToken(raw);
      const fn = cmd === 'insrow' ? insertRows : insertCols;
      return printResult(await fn(tk, sheetId, Number(start), Number(count)));
    }
    case 'delrow': case 'delcol': {
      const [raw, sheetId, start, count = '1'] = args;
      const unit = cmd === 'delrow' ? '行' : '列';
      if (!raw || !sheetId || !start) return fail(`用法: ${cmd} <token|url> <sheet_id> <起始${unit}> [数量] --yes`);
      const tk = await resolveSheetToken(raw);
      const s = Number(start), c = Number(count);
      await confirmDestructive(flags, `删除第 ${s} ${unit}起的 ${c} ${unit}`, () => {
        const range = cmd === 'delrow'
          ? `${sheetId}!A${s}:E${s + c - 1}`
          : `${sheetId}!${colLetter(s)}1:${colLetter(s + c - 1)}5`;
        return readRange(tk, range).then(r => r.values);
      });
      const fn = cmd === 'delrow' ? deleteRows : deleteCols;
      return printResult(await fn(tk, sheetId, s, c));
    }
    case 'clear': {
      const [raw, range] = args;
      if (!raw || !range) return fail('用法: clear <token|url> <sheet_id!A1:C10>');
      const tk = await resolveSheetToken(raw);
      let cleared = [];
      try { cleared = (await readRange(tk, range)).values; } catch { /* 空区域 */ }
      const r = await clearRange(tk, range);
      return printResult({ ...r, cleared });
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

// 仅在作为脚本直接运行时执行 CLI(被 import 时不跑)
const isMain = process.argv[1] && /feishu-sheets\.mjs$/.test(process.argv[1]);
if (isMain) main().catch(fail);
