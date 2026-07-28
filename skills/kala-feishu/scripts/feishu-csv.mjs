/**
 * feishu-csv.mjs —— CSV 解析与值类型推断,给 feishu-sheets / feishu-bitable 共用。
 *
 * 单独一个模块,是因为电子表格和多维表格都要吃 CSV,但两者是平级能力,
 * 不该让其中一个 import 另一个。零依赖手写:本 skill 的铁律是不引 npm 包。
 */

/** 解析 CSV 文本为二维数组。支持双引号包裹、引号内的逗号/换行、`""` 转义为一个 `"`。 */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  const s = text.replace(/^﻿/, ''); // 去 BOM,Excel 导出的 CSV 常带
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; } // "" → "
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * CSV 的格子都是字符串,但表格里数字必须是 number 才能参与求和/排序——
 * 真人从 Excel 粘数据进去也是数字。所以纯数字的格子转成 number。
 *
 * 刻意不转的两类(转了就是数据损坏):
 *   - 前导零:`007`、邮编 `010000` —— 转成数字会丢掉零,那是编号不是数量
 *   - 超过 15 位:身份证、长订单号 —— 超出 IEEE754 安全整数范围会静默丢精度
 * 日期也不转:`2026-07-27` 和 `07/27/2026` 的语义要看地区,猜错比留字符串更糟。
 */
export function coerceValue(v) {
  if (typeof v !== 'string' || v === '') return v;
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) return v;
  if (v.replace(/[-.]/g, '').length > 15) return v;
  return Number(v);
}

/** 二维数组 → CSV 文本(含必要的引号转义)。读表导出用。 */
export function toCsv(rows) {
  return rows.map(row => row.map(cell => {
    const s = cell === null || cell === undefined ? '' : String(cell);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n') + '\n';
}
