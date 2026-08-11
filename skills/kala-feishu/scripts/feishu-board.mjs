/**
 * feishu-board.mjs —— 飞书画板(Board / Whiteboard)读写(用户身份 user_access_token)。
 *
 * 层级:文档里插入一个 `block_type=43` 的画板块 → 该块的 `board.token` 就是 **whiteboard_token**
 * → 往这个画板里创建「节点」(形状 / 文字)。节点是绝对坐标定位的,不像文档那样按流排版。
 *
 * ⚠️ 权限分两层,别混:
 *   - **插入画板块**(docx 侧):不需要任何画板权限,`docx:document` 就够。
 *   - **读写画板节点**(board 侧):需要 `board:whiteboard:node:create` / `board:whiteboard:node:read`,
 *     且这两个是**用户身份**权限 —— 后台加完必须重跑 `feishu-oauth.mjs auth`,否则旧 token 里没有。
 *
 * ⚠️ 飞书是**先校验字段、后检查权限**:结构写错时只回一句笼统的
 *    `99992402 field validation failed`,看起来像"接口不通"或"没权限",极易误判。
 *    所以本模块把已知的字段约束全做成**本地前置校验**,在发请求前就报清楚哪个字段错。
 */
import { writeFileSync } from 'fs';
import { api, userToken, printResult, fail } from './feishu-api.mjs';
import { FEISHU_BASE } from './feishu-config.mjs';
import { parseArgv } from './feishu-cli.mjs';
import { autoSelectAccount } from './feishu-route.mjs';

/** 实测可用的形状(飞书对不支持的值只回 field validation failed,不说是哪个)。 */
export const SHAPES = ['round_rect', 'rect', 'ellipse', 'diamond', 'triangle', 'star', 'parallelogram'];

/** 实测被拒的形状,单独列出来好给可读报错 —— 免得使用者以为是权限问题。 */
const REJECTED_SHAPES = ['arrow'];

const HEX = /^#[0-9a-fA-F]{6}$/;
const COLOR_FIELDS = ['fill_color', 'border_color'];

/**
 * 本地校验一个节点。飞书的报错不指字段,这里替它把话说明白。
 * 只拦**实测确认**的约束,不猜、不过度限制,免得挡住飞书以后新增的合法用法。
 */
export function validateNode(n, i = 0) {
  const at = `第 ${i + 1} 个节点`;
  if (!n || typeof n !== 'object') throw new Error(`${at}: 不是对象`);
  if (!n.type) throw new Error(`${at}: 缺 type(如 composite_shape / text_shape)`);

  if (n.type === 'composite_shape') {
    const s = n.composite_shape?.type;
    if (!s) throw new Error(`${at}: composite_shape 必须带 composite_shape.type,可用:${SHAPES.join(' / ')}`);
    if (REJECTED_SHAPES.includes(s)) {
      throw new Error(`${at}: 形状「${s}」飞书不接受(实测被拒)。可用:${SHAPES.join(' / ')}`);
    }
    if (!SHAPES.includes(s)) {
      throw new Error(`${at}: 形状「${s}」不在实测可用清单里。可用:${SHAPES.join(' / ')};确实要试新形状请直接改本模块的 SHAPES`);
    }
  }

  for (const f of COLOR_FIELDS) {
    const v = n.style?.[f];
    if (v !== undefined && !HEX.test(v)) {
      throw new Error(`${at}: style.${f} = ${JSON.stringify(v)} 不合法,必须是 #RRGGBB 十六进制(颜色名如 "blue" 会被飞书拒掉)`);
    }
  }

  for (const k of ['x', 'y', 'width', 'height']) {
    if (n[k] !== undefined && typeof n[k] !== 'number') {
      throw new Error(`${at}: ${k} 必须是数字,收到 ${JSON.stringify(n[k])}`);
    }
  }
  return n;
}

/** 从文档 URL / token 里取 docx token,并按域名自动选账号。 */
async function resolveDocToken(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('缺少文档 token 或 URL');
  const wiki = s.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wiki) {
    await autoSelectAccount({ url: s, wikiToken: wiki[1] });
    const { getNode } = await import('./feishu-wiki.mjs');
    const node = await getNode(wiki[1]);
    if (!node?.obj_token) throw new Error(`知识库节点解析不到 obj_token: ${wiki[1]}`);
    return node.obj_token;
  }
  const m = s.match(/\/(?:docx|docs)\/([A-Za-z0-9]+)/);
  if (m) { await autoSelectAccount({ url: s, docToken: m[1] }); return m[1]; }
  if (/^https?:\/\//.test(s)) throw new Error(`无法从这个 URL 提取文档 token: ${s}`);
  return s.split(/[?#]/)[0];
}

/**
 * 在文档末尾(或指定位置)插入一个画板块。
 * 返回的 whiteboard_token 才是后续 addNodes / listNodes 用的 id,不是 block_id。
 */
export async function insertBoard(docInput, { index = 0, align = 1 } = {}) {
  const doc = await resolveDocToken(docInput);
  const d = await api('POST', `/docx/v1/documents/${doc}/blocks/${doc}/children`, {
    body: { children: [{ block_type: 43, board: { align } }], index },
  });
  const blk = d.children?.[0] || {};
  return {
    document_id: doc,
    block_id: blk.block_id,
    block_type: blk.block_type,
    whiteboard_token: blk.board?.token,
  };
}

/** 批量创建节点。先本地校验,再发请求。 */
export async function addNodes(whiteboardToken, nodes) {
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('addNodes: nodes 为空');
  nodes.forEach(validateNode);
  const d = await api('POST', `/board/v1/whiteboards/${whiteboardToken}/nodes`, { body: { nodes } });
  const created = d.nodes?.length ?? nodes.length;
  return { created, nodes: d.nodes || [] };
}

/** 读画板所有节点。 */
export async function listNodes(whiteboardToken) {
  // GET 是幂等的,api() 会自动重试网络抖动
  const d = await api('GET', `/board/v1/whiteboards/${whiteboardToken}/nodes`);
  return { nodes: d.nodes || [] };
}

/**
 * 导出画板为图片并写到本地文件。
 * 这个接口返回的是**二进制 JPEG**(不是 JSON),所以不能走 api() —— 它会拿 JSON.parse 去解析图片。
 */
export async function exportImage(whiteboardToken, outPath) {
  const t = userToken();
  const r = await fetch(`${FEISHU_BASE}/board/v1/whiteboards/${whiteboardToken}/download_as_image`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (/json/i.test(ct)) {
    // 出错时飞书才回 JSON,把里面的 msg 抛出来
    let msg = buf.toString('utf8').slice(0, 300);
    try { const j = JSON.parse(msg); msg = `Feishu ${j.code}: ${j.msg}`; } catch { /* 原样 */ }
    throw new Error(`导出画板图片失败 —— ${msg}`);
  }
  writeFileSync(outPath, buf);
  return { out: outPath, bytes: buf.length, content_type: ct };
}

// ── CLI ────────────────────────────────────────────────────────

const USAGE = `用法: node feishu-board.mjs <命令> ...

  insert <doc_token|url>                    在文档里插入画板块 → 返回 whiteboard_token
  nodes  <whiteboard_token>                 读画板所有节点
  add    <whiteboard_token> <nodes.json>    批量创建节点(json 是节点数组,或 {"nodes":[...]})
  image  <whiteboard_token> <输出.jpg>       导出画板为图片
  shapes                                    列出实测可用的形状

节点最小结构:
  {"type":"composite_shape","x":0,"y":0,"width":300,"height":160,
   "composite_shape":{"type":"round_rect"},
   "style":{"fill_color":"#eaf3ff","border_color":"#d0d7de"},
   "text":{"text":"标题","font_size":20,"font_weight":"bold",
           "horizontal_align":"center","vertical_align":"mid"}}

⚠️ style 里的颜色必须是 #RRGGBB;写 "blue" 这类颜色名飞书会拒(本脚本会先在本地拦住)。
⚠️ 画板节点读写需要 board:whiteboard:node:create / :read 两个**用户身份**权限,
   后台加完要重跑 feishu-oauth.mjs auth,旧 token 不会自动带上新权限。`;

async function main() {
  const { pos } = parseArgv(process.argv.slice(2));
  const [cmd, ...args] = pos;

  switch (cmd) {
    case 'insert': {
      const [doc] = args;
      if (!doc) return fail('用法: insert <doc_token|url>');
      return printResult(await insertBoard(doc));
    }
    case 'nodes': {
      const [wb] = args;
      if (!wb) return fail('用法: nodes <whiteboard_token>');
      const { nodes } = await listNodes(wb);
      return printResult({ count: nodes.length, nodes });
    }
    case 'add': {
      const [wb, file] = args;
      if (!wb || !file) return fail('用法: add <whiteboard_token> <nodes.json>');
      const { readFileSync } = await import('fs');
      let parsed;
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
      catch (e) { return fail(`读取/解析 ${file} 失败: ${e.message}`); }
      const nodes = Array.isArray(parsed) ? parsed : parsed.nodes;
      if (!Array.isArray(nodes)) return fail(`${file} 要么是节点数组,要么是 {"nodes":[...]}`);
      return printResult(await addNodes(wb, nodes));
    }
    case 'image': {
      const [wb, out] = args;
      if (!wb || !out) return fail('用法: image <whiteboard_token> <输出.jpg>');
      return printResult(await exportImage(wb, out));
    }
    case 'shapes':
      return printResult({ usable: SHAPES, rejected: REJECTED_SHAPES });
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

const isMain = process.argv[1] && /feishu-board\.mjs$/.test(process.argv[1]);
if (isMain) main().catch(fail);
