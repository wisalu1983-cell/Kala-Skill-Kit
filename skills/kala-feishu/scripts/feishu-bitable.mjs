/**
 * feishu-bitable.mjs —— 飞书多维表格(Base / Bitable)读写(用户身份 user_access_token)。
 *
 * 层级:一个「多维表格」(app_token)→ 多张「数据表」(table_id)→ 「字段」(列)+「记录」(行)。
 * 和电子表格的根本区别:这里没有「格子坐标」,只有**字段名 → 值**的记录对象。
 * 所以写入用 JSON({字段名: 值}),不是二维数组。
 *
 * ⚠️ 字段(列)是有类型的强约束:往「数字」字段写字符串会被飞书拒绝。
 *    写入前用 listFields 看清类型,别猜。
 */
import { readFileSync, writeFileSync } from 'fs';
import { api, printResult, fail } from './feishu-api.mjs';
import { parseCsv, coerceValue, toCsv } from './feishu-csv.mjs';
import { parseArgv, confirmDestructive } from './feishu-cli.mjs';
import { autoSelectAccount } from './feishu-route.mjs';

/**
 * 字段类型:飞书 API 用数字 code(`type: 2`),没人记得住那是什么。
 * 对外统一收/发**中文类型名**,只映射真人常用的那些;冷门类型(关联/公式/自动编号等)
 * 直接传数字 code 也接受,读出来时显示 `类型2x` 形式,不假装认识。
 */
const FIELD_TYPES = {
  文本: 1, 数字: 2, 单选: 3, 多选: 4, 日期: 5,
  复选框: 7, 人员: 11, 电话: 13, 超链接: 15, 附件: 17,
};
const TYPE_NAMES = Object.fromEntries(Object.entries(FIELD_TYPES).map(([k, v]) => [v, k]));

/** 中文类型名 → 数字 code;已经是数字就原样返回。 */
export function fieldTypeCode(type) {
  if (typeof type === 'number') return type;
  const code = FIELD_TYPES[String(type).trim()];
  if (!code) {
    throw new Error(`不认识的字段类型「${type}」。可用:${Object.keys(FIELD_TYPES).join('/')},或直接传飞书的数字 code`);
  }
  return code;
}

/** 数字 code → 中文类型名;没映射的返回 `类型<code>`。 */
export function fieldTypeName(code) {
  return TYPE_NAMES[code] || `类型${code}`;
}

/** 建多维表格。folderToken 省略则落到云盘根目录。 */
export async function createBase(name, folderToken) {
  const body = { name };
  if (folderToken) body.folder_token = folderToken;
  const d = await api('POST', '/bitable/v1/apps', { body });
  const app = d.app || {};
  return { app_token: app.app_token, name: app.name, url: app.url };
}

/** 列出所有数据表。 */
export async function listTables(appToken) {
  const d = await api('GET', `/bitable/v1/apps/${appToken}/tables`, { query: { page_size: '100' } });
  return (d.items || []).map(t => ({ table_id: t.table_id, name: t.name, revision: t.revision }));
}

/** 新增数据表。 */
export async function addTable(appToken, name) {
  const d = await api('POST', `/bitable/v1/apps/${appToken}/tables`, { body: { table: { name } } });
  return { table_id: d.table_id, name };
}

/** 删数据表。⚠️ 表内所有记录一起消失,CLI 层要求 --yes。 */
export async function deleteTable(appToken, tableId) {
  await api('DELETE', `/bitable/v1/apps/${appToken}/tables/${tableId}`);
  return { deleted_table_id: tableId };
}

// ── 字段(列结构)──────────────────────────────────────────────

/** 列出字段。type_name 是可读类型名,type 是飞书原始 code(两个都给,便于排错)。 */
export async function listFields(appToken, tableId) {
  const d = await api('GET', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, { query: { page_size: '100' } });
  return (d.items || []).map(f => ({
    field_id: f.field_id,
    field_name: f.field_name,
    type: f.type,
    type_name: fieldTypeName(f.type),
    property: f.property,
  }));
}

/** 新增字段。type 传中文名(如 '数字')或飞书数字 code。单选/多选需要额外传 property.options。 */
export async function addField(appToken, tableId, name, type, property) {
  const body = { field_name: name, type: fieldTypeCode(type) };
  if (property) body.property = property;
  const d = await api('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`, { body });
  const f = d.field || {};
  return { field_id: f.field_id, field_name: f.field_name, type: f.type, type_name: fieldTypeName(f.type) };
}

/**
 * 改字段。飞书的 PUT 要求 field_name 和 type 都必填,
 * 所以只改名时先读出当前 type 带上——否则会把类型改没。
 */
export async function updateField(appToken, tableId, fieldId, { name, type, property } = {}) {
  const current = (await listFields(appToken, tableId)).find(f => f.field_id === fieldId);
  if (!current) throw new Error(`字段不存在: ${fieldId}`);
  const body = {
    field_name: name ?? current.field_name,
    type: type === undefined ? current.type : fieldTypeCode(type),
  };
  const prop = property ?? current.property;
  if (prop) body.property = prop;
  const d = await api('PUT', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`, { body });
  const f = d.field || {};
  return { field_id: f.field_id, field_name: f.field_name, type: f.type, type_name: fieldTypeName(f.type) };
}

/** 删字段。⚠️ 这一列所有记录的值一起消失,且 bitable 字段删了回收站找不回来。CLI 层要求 --yes。 */
export async function deleteField(appToken, tableId, fieldId) {
  await api('DELETE', `/bitable/v1/apps/${appToken}/tables/${tableId}/fields/${fieldId}`);
  return { deleted_field_id: fieldId };
}

// ── 记录(行)────────────────────────────────────────────────────

/**
 * 飞书把文本类字段返成富文本数组 `[{text:'x',type:'text'}]`,直接给调用者用不了。
 * 这里拼回纯字符串。判定条件是「数组且每个元素都带 text 属性」——
 * 多选字段的 `['A','B']`、附件的 `[{file_token,...}]`、人员的 `[{id,name}]` 都不满足,
 * 会原样保留,不会被误伤。
 */
function normalizeFieldValue(v) {
  if (Array.isArray(v) && v.length && v.every(x => x && typeof x === 'object' && typeof x.text === 'string')) {
    return v.map(x => x.text).join('');
  }
  return v;
}

function normalizeRecord(r) {
  const fields = {};
  for (const [k, v] of Object.entries(r.fields || {})) fields[k] = normalizeFieldValue(v);
  return { record_id: r.record_id, fields };
}

/** 读记录。用 search 接口(list 已被飞书标记为不推荐)。 */
export async function listRecords(appToken, tableId, { pageSize = 500, pageToken } = {}) {
  const query = { page_size: String(Math.min(pageSize, 500)) };
  if (pageToken) query.page_token = pageToken;
  // search 虽然是 POST,但只读 —— 显式标 retryable,否则网络抖动会直接失败
  const d = await api('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`, { query, body: {}, retryable: true });
  return {
    records: (d.items || []).map(normalizeRecord),
    has_more: !!d.has_more,
    page_token: d.page_token,
    total: d.total,
  };
}

/** 新增一条记录。fields 是 { 字段名: 值 }。 */
export async function addRecord(appToken, tableId, fields) {
  const d = await api('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records`, { body: { fields } });
  return normalizeRecord(d.record || {});
}

/**
 * 批量操作的单批上限。飞书文档对 batch_create / batch_delete 都写 500,
 * 实测偶尔能塞进更多,但那是未文档化的宽容行为,量再大一定会失败 —— 按上限切片。
 */
const BATCH_LIMIT = 500;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 批量新增记录,超过单批上限自动分批。失败时报清楚已成功几批,不假装整体成功。 */
export async function addRecords(appToken, tableId, fieldsList) {
  if (!fieldsList?.length) throw new Error('addRecords: 记录列表为空');
  const batches = chunk(fieldsList, BATCH_LIMIT);
  const records = [];
  for (const [i, group] of batches.entries()) {
    try {
      const d = await api('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`, {
        body: { records: group.map(fields => ({ fields })) },
      });
      records.push(...(d.records || []).map(normalizeRecord));
    } catch (e) {
      throw new Error(`第 ${i + 1}/${batches.length} 批写入失败(前 ${records.length} 条已写入,不会回滚): ${e.message}`);
    }
  }
  return { record_ids: records.map(r => r.record_id), records, batches: batches.length };
}

/** 改一条记录(只需传要改的字段,其余不动)。 */
export async function updateRecord(appToken, tableId, recordId, fields) {
  const d = await api('PUT', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, { body: { fields } });
  return normalizeRecord(d.record || {});
}

/** 批量删记录,超过单批上限自动分批。⚠️ 真删,CLI 层要求 --yes。 */
export async function deleteRecords(appToken, tableId, recordIds) {
  const ids = Array.isArray(recordIds) ? recordIds : [recordIds];
  if (!ids.length) throw new Error('deleteRecords: 没有要删的 record_id');
  const batches = chunk(ids, BATCH_LIMIT);
  let deleted = 0;
  for (const [i, group] of batches.entries()) {
    try {
      const d = await api('POST', `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`, {
        body: { records: group }, retryable: true, // 删同一批 id 两次结果相同
      });
      deleted += (d.records || []).length || group.length;
    } catch (e) {
      throw new Error(`第 ${i + 1}/${batches.length} 批删除失败(前 ${deleted} 条已删除,删除不可回滚): ${e.message}`);
    }
  }
  return { deleted, record_ids: ids, batches: batches.length };
}

/** 从本地 CSV 批量建记录:**表头即字段名**,必须和表里现有字段名对得上。 */
export async function addRecordsFromCsv(appToken, tableId, csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  if (rows.length < 2) throw new Error(`CSV 至少要有表头 + 1 行数据: ${csvPath}`);
  const header = rows[0].map(h => h.trim());
  const known = new Set((await listFields(appToken, tableId)).map(f => f.field_name));
  const unknown = header.filter(h => !known.has(h));
  if (unknown.length) {
    throw new Error(`CSV 表头里这些列在表中没有对应字段:${unknown.join('、')}。现有字段:${[...known].join('、')}`);
  }
  const list = rows.slice(1).map(r => {
    const fields = {};
    header.forEach((h, i) => {
      const v = coerceValue(r[i] ?? '');
      if (v !== '') fields[h] = v; // 空值不写,避免把已有值清成空
    });
    return fields;
  }).filter(f => Object.keys(f).length);
  return addRecords(appToken, tableId, list);
}

// ── URL 解析 / 导出 ────────────────────────────────────────────

/**
 * 统一成 app_token,并顺带按域名自动选账号:
 *   https://x.feishu.cn/base/<app_token|url> → app_token
 *   https://x.feishu.cn/wiki/<node>      → 该节点底层的 obj_token(知识库里的多维表格)
 *   裸 token                             → 原样
 */
export async function resolveBaseToken(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('缺少多维表格 token 或 URL');

  const wiki = s.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) {
    await autoSelectAccount({ url: s, wikiToken: wiki[1] });
    const { getNode } = await import('./feishu-wiki.mjs');
    const node = await getNode(wiki[1]);
    if (!node?.obj_token) throw new Error(`知识库节点解析不到 obj_token: ${wiki[1]}`);
    return node.obj_token;
  }
  const m = s.match(/\/(?:base|bitable)\/([A-Za-z0-9]+)/);
  if (m) {
    await autoSelectAccount({ url: s, baseToken: m[1] });
    return m[1];
  }
  if (/^https?:\/\//.test(s)) throw new Error(`无法从这个 URL 提取多维表格 token: ${s}`);
  return s.split(/[?#]/)[0];
}

/** 翻完所有页,拿全部记录(导出用,不进 context)。 */
async function readAllRecords(appToken, tableId) {
  const all = [];
  let pageToken;
  do {
    const r = await listRecords(appToken, tableId, { pageSize: 500, pageToken });
    all.push(...r.records);
    pageToken = r.has_more ? r.page_token : null;
  } while (pageToken);
  return all;
}

/** 记录数组 → CSV 二维表(表头是所有字段名的并集;复杂值如附件/人员序列化成 JSON)。 */
function recordsToCsvRows(records) {
  const names = [...new Set(records.flatMap(r => Object.keys(r.fields)))];
  const cell = v => (v === null || v === undefined) ? ''
    : (typeof v === 'object' ? JSON.stringify(v) : v);
  return [['record_id', ...names], ...records.map(r => [r.record_id, ...names.map(n => cell(r.fields[n]))])];
}

// ── CLI ────────────────────────────────────────────────────────

/** records 默认最多打印这么多条,理由同 feishu-sheets 的 DEFAULT_READ_ROWS:保护 context。 */
const DEFAULT_RECORDS = 200;

const USAGE = `用法: node feishu-bitable.mjs <命令> ...

  create   <名字> [folder_token]                    建多维表格
  tables   <app_token|url>                              列数据表
  addtable <app_token|url> <名字>                       加数据表
  deltable <app_token|url> <table_id> --yes             删数据表
  fields   <app_token|url> <table_id>                   列字段(带可读类型名)
  addfield <app_token|url> <table_id> <名字> <类型>      加字段(类型:${Object.keys(FIELD_TYPES).join('/')})
  delfield <app_token|url> <table_id> <field_id> --yes  删字段
  records  <app_token|url> <table_id>                   读记录
  addrec   <app_token|url> <table_id> <json或csv文件>    新增记录(csv 表头即字段名)
  updrec   <app_token|url> <table_id> <record_id> <json> 改记录
  delrec   <app_token|url> <table_id> <record_id...> --yes  删记录(可多个)

删除类命令必须带 --yes;不带时只打印预览并退出 1。
addrec 的 json 可以是一个对象或对象数组,也可以传 .csv 文件路径。`;

/** addrec/updrec 的入参:.csv 文件路径、或 JSON 字符串、或 .json 文件路径。 */
function loadFieldsArg(arg) {
  if (/\.csv$/i.test(arg)) return { kind: 'csv', path: arg };
  const text = /\.json$/i.test(arg) ? readFileSync(arg, 'utf8') : arg;
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`解析 JSON 失败: ${e.message}`); }
  return { kind: 'json', value: parsed };
}

async function main() {
  const { flags, pos } = parseArgv(process.argv.slice(2));
  const [cmd, ...args] = pos;

  switch (cmd) {
    case 'create': {
      const [name, folder] = args;
      if (!name) return fail('用法: create <名字> [folder_token]');
      return printResult(await createBase(name, folder));
    }
    case 'tables': {
      const [raw] = args;
      if (!raw) return fail('用法: tables <app_token|url>');
      const app = await resolveBaseToken(raw);
      return printResult({ app_token: app, tables: await listTables(app) });
    }
    case 'addtable': {
      const [raw, name] = args;
      if (!raw || !name) return fail('用法: addtable <app_token|url> <名字>');
      const app = await resolveBaseToken(raw);
      return printResult(await addTable(app, name));
    }
    case 'deltable': {
      const [raw, tableId] = args;
      if (!raw || !tableId) return fail('用法: deltable <app_token|url> <table_id> --yes');
      const app = await resolveBaseToken(raw);
      const target = (await listTables(app)).find(t => t.table_id === tableId);
      if (!target) return fail(`数据表不存在: ${tableId}`);
      await confirmDestructive(flags, `删除数据表「${target.name}」及其全部记录`,
        () => listRecords(app, tableId, { pageSize: 5 }).then(r => r.records));
      return printResult(await deleteTable(app, tableId));
    }
    case 'fields': {
      const [raw, tableId] = args;
      if (!raw || !tableId) return fail('用法: fields <app_token|url> <table_id>');
      const app = await resolveBaseToken(raw);
      return printResult({ fields: await listFields(app, tableId) });
    }
    case 'addfield': {
      const [raw, tableId, name, type] = args;
      if (!raw || !tableId || !name || !type) return fail(`用法: addfield <app_token|url> <table_id> <名字> <类型>`);
      const app = await resolveBaseToken(raw);
      return printResult(await addField(app, tableId, name, type));
    }
    case 'delfield': {
      const [raw, tableId, fieldId] = args;
      if (!raw || !tableId || !fieldId) return fail('用法: delfield <app_token|url> <table_id> <field_id> --yes');
      const app = await resolveBaseToken(raw);
      const target = (await listFields(app, tableId)).find(f => f.field_id === fieldId);
      if (!target) return fail(`字段不存在: ${fieldId}`);
      // 字段删除在 bitable 里回收站找不回来,预览给足
      await confirmDestructive(flags, `删除字段「${target.field_name}」(${target.type_name})—— 该列所有记录的值一起消失,且回收站无法恢复`,
        () => listRecords(app, tableId, { pageSize: 5 }).then(r => r.records.map(x => ({ record_id: x.record_id, 该字段值: x.fields[target.field_name] }))));
      return printResult(await deleteField(app, tableId, fieldId));
    }
    case 'records': {
      const [raw, tableId] = args;
      if (!raw || !tableId) return fail('用法: records <app_token|url> <table_id> [--limit N] [--page-token T] [--out 文件]');
      const app = await resolveBaseToken(raw);

      if (flags.out) {
        const all = await readAllRecords(app, tableId);
        writeFileSync(flags.out, toCsv(recordsToCsvRows(all)), 'utf8');
        // 同 sheets:--out 的意义就是数据别进 context。
        // 计数用 record_count 而不是复用 records —— 同一个字段不能一会儿是数组一会儿是数字。
        return printResult({ out: flags.out, record_count: all.length });
      }

      const limit = flags.limit === undefined ? DEFAULT_RECORDS : Number(flags.limit);
      const r = await listRecords(app, tableId, {
        pageSize: limit > 0 ? limit : 500,
        pageToken: flags['page-token'] || undefined,
      });
      const out = {
        records: r.records,
        returned: r.records.length,
        total: r.total,
        has_more: r.has_more,
        next_page_token: r.has_more ? r.page_token : undefined,
      };
      if (r.has_more) {
        // bitable 是游标分页(不能按 offset 跳),续读只能靠 page_token
        out.hint = `还有更多记录。继续读加 --page-token ${r.page_token};`
          + '要全量分析改用 --out data.csv(导出到文件,不占 context)。';
      }
      return printResult(out);
    }
    case 'addrec': {
      const [raw, tableId, data] = args;
      if (!raw || !tableId || !data) return fail('用法: addrec <app_token|url> <table_id> <json或csv文件>');
      const app = await resolveBaseToken(raw);
      const input = loadFieldsArg(data);
      if (input.kind === 'csv') return printResult(await addRecordsFromCsv(app, tableId, input.path));
      const list = Array.isArray(input.value) ? input.value : [input.value];
      return printResult(await addRecords(app, tableId, list));
    }
    case 'updrec': {
      const [raw, tableId, recordId, data] = args;
      if (!raw || !tableId || !recordId || !data) return fail('用法: updrec <app_token|url> <table_id> <record_id> <json>');
      const app = await resolveBaseToken(raw);
      const input = loadFieldsArg(data);
      if (input.kind !== 'json') return fail('updrec 只接受 JSON(改单条记录)');
      return printResult(await updateRecord(app, tableId, recordId, input.value));
    }
    case 'delrec': {
      const [raw, tableId, ...ids] = args;
      if (!raw || !tableId || !ids.length) return fail('用法: delrec <app_token|url> <table_id> <record_id...> --yes');
      const app = await resolveBaseToken(raw);
      await confirmDestructive(flags, `删除 ${ids.length} 条记录`, async () => {
        const all = (await listRecords(app, tableId)).records;
        return all.filter(r => ids.includes(r.record_id));
      });
      return printResult(await deleteRecords(app, tableId, ids));
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

const isMain = process.argv[1] && /feishu-bitable\.mjs$/.test(process.argv[1]);
if (isMain) main().catch(fail);
