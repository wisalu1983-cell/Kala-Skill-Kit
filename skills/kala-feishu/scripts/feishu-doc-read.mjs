/**
 * feishu-doc-read.mjs —— 把飞书文档/电子表格/多维表格读成可读 Markdown 的 CLI 薄封装。
 *
 * 目标可以是:
 *   - 云文档 docx token 或链接 (https://xxx.feishu.cn/docx/XXXX)
 *   - 电子表格链接 (https://xxx.feishu.cn/sheets/XXXX)
 *   - 多维表格链接 (https://xxx.feishu.cn/base/XXXX)
 *   - 知识库节点链接 (https://xxx.feishu.cn/wiki/XXXX) → 自动解析出底层类型和 obj_token,按类型分发
 *   - 裸 token(不带 URL,无法从 token 本身判断类型)→ 必须加 --type docx|sheet|bitable
 *
 * 用法:
 *   node feishu-doc-read.mjs <token|url> [--out file.md] [--type docx|sheet|bitable]
 *     (默认)     把全文 Markdown 打印到 stdout(不落盘,读完即用,适合直接喂进对话上下文)
 *     --out FILE 同时(或只)存一份到本地文件
 *     --type     裸 token 时指定文档类型;URL/wiki 链接会自动识别,通常不用传
 *
 * 能力边界:
 *   - docx:飞书里生成不出对应 Markdown 的块——画板(43)和嵌入的多维表格(18)/电子表格(30)——不会被
 *     静默丢弃。嵌入的多维表格/电子表格会展开成实际内容(取它引用的那一张表/那一个工作表);
 *     画板等真的没法转文本的块,渲染成一行占位提示注明块类型,需要看这部分内容时去飞书原文档看。
 *   - 图片:飞书图片没有可直接访问的公网 URL,本工具会把图片下载到本地(见下方「图片」),
 *     Markdown 里引用的是本地文件路径,不是网络地址。**本工具本身不做图像识别/转录**——
 *     下载下来的图片文字/图表内容需要 agent 用 Read 工具查看后自行补充说明,这是设计上的分工:
 *     脚本负责机械下载,"看懂图里是什么"这一步留给有视觉能力的一方来做。
 *   - 电子表格/多维表格:每张工作表/数据表默认只取前 200 行/条(保护 context,和
 *     feishu-sheets.mjs / feishu-bitable.mjs 的 CLI 默认行为一致),超出会在文末提示怎么导出全量。
 *   - 知识库节点若指向旧版「文档」(doc,非 docx)或幻灯片/思维笔记等类型,本工具不支持,会明确报错。
 *
 * 嵌入的多维表格/电子表格块(block_type 18/30)引用的 token 格式是 `主token_子ID`
 * (如 `多维表格appToken_tableId`、`电子表格spreadsheetToken_sheetId`,来自飞书官方 docx
 * BlockData 结构文档),本工具按最后一个下划线拆分——展开失败时会退回占位提示,不会中断整篇读取。
 */
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, basename } from 'path';
import { FeishuDocWriter } from './feishu-doc-writer.mjs';
import { getNode } from './feishu-wiki.mjs';
import { autoSelectAccount } from './feishu-route.mjs';
import { listSheets, readRange, resolveReadRange, sliceRange, DEFAULT_READ_ROWS } from './feishu-sheets.mjs';
import { listTables, listFields, listRecords } from './feishu-bitable.mjs';

const RECORD_CAP = DEFAULT_READ_ROWS; // 多维表格没有自己的默认上限,借用电子表格那份保护 context 的考量

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  let out = null, type = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { out = argv[++i]; continue; }
    if (a === '--type') { type = argv[++i]; continue; }
    if (a.startsWith('--')) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { positional, flags, out, type };
}

/** 从 URL/token 判断类型。返回 { kind: 'docx'|'sheet'|'bitable'|'wiki', token } */
function detectTarget(input, explicitType) {
  const docm = input.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docm) return { kind: 'docx', token: docm[1] };
  const sheetm = input.match(/\/sheets\/([A-Za-z0-9]+)/);
  if (sheetm) return { kind: 'sheet', token: sheetm[1] };
  const basem = input.match(/\/base\/([A-Za-z0-9]+)/);
  if (basem) return { kind: 'bitable', token: basem[1] };
  const wikim = input.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikim) return { kind: 'wiki', token: wikim[1] };

  // 裸 token(不含 URL 路径)判断不了类型:docx 是最初也是最常见的用法,默认按它处理;
  // 要读裸的 sheet/bitable token 得显式传 --type。
  const bare = input.split(/[?#]/)[0].trim();
  return { kind: explicitType || 'docx', token: bare };
}

function mdRow(cells) {
  return '| ' + cells.map((c) => {
    const s = String(c ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
    return s || ' ';
  }).join(' | ') + ' |';
}

/**
 * 多维表格的字段值(富文本数组/多选/附件/人员……)归一化成一段可读文本。
 * @param {*} v - 字段值
 * @param {{type:number}} [field] - 对应的字段定义(listFields 的结果项),用于识别日期字段
 *   ——日期字段的值是飞书给的毫秒时间戳,不认字段类型就只能原样打印一串数字,不可读。
 */
function stringifyBitableValue(v, field) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? '是' : '否';
  // 5=日期(见 feishu-bitable.mjs 的 FIELD_TYPES);1001/1002=创建时间/最后更新时间(系统自动字段,
  // 不在那份映射里,但值同样是毫秒时间戳)。
  if ([5, 1001, 1002].includes(field?.type) && typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
  }
  if (Array.isArray(v)) {
    return v.map((item) => {
      if (item && typeof item === 'object') return item.text ?? item.name ?? item.file_token ?? JSON.stringify(item);
      return String(item);
    }).join(', ');
  }
  if (v && typeof v === 'object') {
    // 关联字段(单向关联/双向关联)未展开时只有 { link_record_ids: [...] },原样打印是天书
    if (Array.isArray(v.link_record_ids)) {
      return v.link_record_ids.length ? `(关联 ${v.link_record_ids.length} 条记录)` : '';
    }
    if (Object.keys(v).length === 0) return ''; // 空关联字段是 {}
    return v.text ?? v.link ?? v.name ?? JSON.stringify(v);
  }
  return String(v);
}

/** 渲染一张数据表(独立读取、或从 docx 里的嵌入块展开时都走这条路)。 */
async function renderBitableTable(appToken, tableId, heading) {
  const fields = await listFields(appToken, tableId);
  const lines = [`${heading}\n`];
  if (!fields.length) { lines.push('(没有字段)\n'); return lines.join('\n'); }
  const { records, has_more, total } = await listRecords(appToken, tableId, { pageSize: RECORD_CAP });
  const header = fields.map((f) => f.field_name);
  // 新建多维表格自带默认字段(单选/日期/附件……)和几条空白模板记录,原样渲染全是空格子。
  // 丢掉全空的行,再丢掉剩下的行里所有值都是空的列。
  const rows = records
    .map((r) => header.map((h, i) => stringifyBitableValue(r.fields[h], fields[i])))
    .filter((cells) => cells.some((c) => c.trim() !== ''));
  if (!rows.length) {
    lines.push('(没有记录)\n');
  } else {
    const keep = header.map((_, i) => rows.some((r) => r[i].trim() !== ''));
    const keptHeader = header.filter((_, i) => keep[i]);
    lines.push(mdRow(keptHeader), mdRow(keptHeader.map(() => '---')));
    for (const row of rows) lines.push(mdRow(row.filter((_, i) => keep[i])));
  }
  if (has_more) {
    lines.push(`\n(仅在前 ${records.length} 条里找数据${total ? `,共 ${total} 条` : ''}。读全部: node feishu-bitable.mjs records ${appToken} ${tableId} --out data.csv)`);
  }
  return lines.join('\n') + '\n';
}

async function bitableToMarkdown(appToken) {
  const tables = await listTables(appToken);
  if (!tables.length) return '(这个多维表格里没有数据表)\n';
  const parts = [];
  for (const t of tables) parts.push(await renderBitableTable(appToken, t.table_id, `## 数据表: ${t.name}`));
  return parts.join('\n');
}

/**
 * 飞书新建的工作表默认留一片空网格(常见 200 行 x 20 列),原样渲染会输出一堆空单元格的
 * Markdown 表格,又占 context 又没内容。丢掉整行/整列都是空值的行列,只留真正有数据的部分。
 */
function trimEmptyGrid(values) {
  const isEmpty = (v) => v === null || v === undefined || v === '';
  const rows = values.filter((row) => !row.every(isEmpty));
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => Array.from({ length: width }, (_, i) => r[i]));
  let lastCol = width - 1;
  while (lastCol >= 0 && padded.every((r) => isEmpty(r[lastCol]))) lastCol--;
  if (lastCol < 0) return [];
  return padded.map((r) => r.slice(0, lastCol + 1));
}

/** 渲染一张工作表(独立读取、或从 docx 里的嵌入块展开时都走这条路)。 */
async function renderSheetGrid(spreadsheetToken, sheetId, heading) {
  const sheets = await listSheets(spreadsheetToken);
  const s = sheets.find((x) => x.sheet_id === sheetId);
  if (!s) throw new Error(`工作表 ${sheetId} 不存在(spreadsheet ${spreadsheetToken})`);
  const lines = [`${heading}\n`];
  const full = await resolveReadRange(spreadsheetToken, s.sheet_id);
  const capped = sliceRange(full, 0, DEFAULT_READ_ROWS);
  const { values } = await readRange(spreadsheetToken, capped);
  const trimmed = trimEmptyGrid(values);
  if (!trimmed.length) { lines.push('(空工作表)\n'); return lines.join('\n'); }
  lines.push(mdRow(trimmed[0]), mdRow(trimmed[0].map(() => '---')));
  for (const row of trimmed.slice(1)) lines.push(mdRow(row));
  const declaredRows = s.row_count || 0;
  if (declaredRows > DEFAULT_READ_ROWS) {
    lines.push(`\n(本工作表声明有 ${declaredRows} 行,本命令只在前 ${DEFAULT_READ_ROWS} 行里找数据;若数据超出这个范围,读全部: node feishu-sheets.mjs read ${spreadsheetToken} ${sheetId} --out data.csv)`);
  }
  return lines.join('\n') + '\n';
}

async function sheetToMarkdown(spreadsheetToken) {
  const sheets = await listSheets(spreadsheetToken);
  if (!sheets.length) return '(这个电子表格里没有工作表)\n';
  const parts = [];
  for (const s of sheets) parts.push(await renderSheetGrid(spreadsheetToken, s.sheet_id, `## 工作表: ${s.title}`));
  return parts.join('\n');
}

/**
 * 嵌入块(block_type 18 多维表格 / 30 电子表格)引用的 token 格式是 `主token_子ID`
 * (飞书官方 docx BlockData 文档:Bitable 为 BitableToken_TableID,Sheet 为
 * SpreadsheetToken_SheetID)。两种 token 本身都不含下划线,按最后一个下划线拆分即可。
 */
export function splitCompositeToken(raw) {
  if (!raw) return null;
  const idx = raw.lastIndexOf('_');
  if (idx <= 0 || idx === raw.length - 1) return null;
  return { main: raw.slice(0, idx), sub: raw.slice(idx + 1) };
}

/** 传给 blocksToMarkdown 的 resolveEmbed:展开 docx 里嵌入的多维表格/电子表格块。 */
export async function resolveEmbeddedBlock(block) {
  if (block.block_type === 18) { // 多维表格
    const parts = splitCompositeToken(block.bitable?.token);
    if (!parts) return null;
    return renderBitableTable(parts.main, parts.sub, '**[嵌入的多维表格]**');
  }
  if (block.block_type === 30) { // 电子表格
    const parts = splitCompositeToken(block.sheet?.token);
    if (!parts) return null;
    return renderSheetGrid(parts.main, parts.sub, '**[嵌入的电子表格]**');
  }
  return null;
}

const EXT_BY_CONTENT_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/vnd.microsoft.icon': 'ico', 'image/x-icon': 'ico',
};

/** --out 给了就存图片到它旁边的 <basename>.images/;没给就存到一个临时目录。 */
function pickImagesDir(outPath) {
  if (outPath) {
    const dir = join(dirname(outPath), `${basename(outPath).replace(/\.[^./\\]+$/, '')}.images`);
    return dir;
  }
  return mkdtempSync(join(tmpdir(), 'kala-feishu-read-images-'));
}

async function main() {
  const { positional, out, type } = parseArgs(process.argv.slice(2));
  const [input] = positional;
  if (!input) {
    console.error('用法: node feishu-doc-read.mjs <token|url> [--out file.md] [--type docx|sheet|bitable]');
    process.exit(1);
  }

  let { kind, token } = detectTarget(input, type);

  if (kind === 'wiki') {
    await autoSelectAccount({ url: input, wikiToken: token });
    const node = await getNode(token);
    if (!node?.obj_token) throw new Error(`知识库节点解析失败,拿不到 obj_token: ${token}`);
    const wikiTypeMap = { docx: 'docx', sheet: 'sheet', bitable: 'bitable' };
    const mapped = wikiTypeMap[node.obj_type];
    if (!mapped) throw new Error(`知识库节点类型「${node.obj_type}」暂不支持读取全文(本工具只支持 docx/sheet/bitable)`);
    console.error(`知识库节点 ${token} → ${node.obj_type} ${node.obj_token}`);
    kind = mapped;
    token = node.obj_token;
  } else {
    await autoSelectAccount({
      url: input,
      docToken: kind === 'docx' ? token : undefined,
      sheetToken: kind === 'sheet' ? token : undefined,
      baseToken: kind === 'bitable' ? token : undefined,
    });
  }

  let markdown;
  if (kind === 'docx') {
    const w = new FeishuDocWriter();
    await w.init();

    let imagesDir = null;
    const downloadedImages = [];
    const downloadImage = async (fileToken) => {
      if (!imagesDir) {
        imagesDir = pickImagesDir(out);
        mkdirSync(imagesDir, { recursive: true });
      }
      const { buffer, contentType } = await w.downloadMedia(fileToken);
      const ext = EXT_BY_CONTENT_TYPE[contentType.split(';')[0].trim()] || 'png';
      const filePath = join(imagesDir, `img_${downloadedImages.length + 1}.${ext}`);
      writeFileSync(filePath, buffer);
      downloadedImages.push(filePath);
      return filePath;
    };

    const r = await w.readMarkdown(token, { resolveEmbed: resolveEmbeddedBlock, downloadImage });
    console.error(`文档: ${r.title}(${r.block_count} 块)`);
    if (downloadedImages.length) {
      console.error(`已下载 ${downloadedImages.length} 张图片到 ${imagesDir}`);
      console.error('本工具不做图像识别——建议用 Read 工具逐张查看后,把图中内容补进这份参考材料再使用:');
      for (const p of downloadedImages) console.error(`  ${p}`);
    }
    markdown = r.markdown;
  } else if (kind === 'sheet') {
    markdown = await sheetToMarkdown(token);
    console.error(`电子表格: ${token}`);
  } else if (kind === 'bitable') {
    markdown = await bitableToMarkdown(token);
    console.error(`多维表格: ${token}`);
  } else {
    throw new Error(`不支持的类型: ${kind}(只支持 docx/sheet/bitable)`);
  }

  if (out) {
    writeFileSync(out, markdown, 'utf-8');
    console.error(`已存: ${out}`);
  } else {
    console.log(markdown);
  }
}

// isMain 判断: 被其它脚本 import(取 resolveEmbeddedBlock/splitCompositeToken 复用)时绝不能顺带
// 跑 main()——否则会把宿主脚本自己的 argv 当成本脚本的参数解析,并可能 process.exit() 掉宿主进程。
const isMain = process.argv[1] && /feishu-doc-read\.mjs$/.test(process.argv[1]);
if (isMain) main().catch((e) => { console.error('❌', e.message); process.exit(1); });
