/**
 * feishu-doc-patch.mjs —— 增量更新:只改文档里真正变了的那几块。
 *
 * 为什么要有这个模块:
 *   feishu-doc-writer.mjs 的 write() 是「清空全文 + 按 Markdown 重建」。语义最简单,
 *   但小改也要全篇重写——冲掉别人在飞书里的编辑、废掉锚在旧块上的局部评论、
 *   大文档要删 N 块再建 N 块(每 50 块间隔 400ms,很慢)、版本历史里每次都是全文变更。
 *
 * 做法:
 *   1. 读文档现有**顶层块**,和 Markdown 解析出的新块各算一条签名(内容 + 行内样式)。
 *   2. 两个签名序列做 LCS 对齐,得出 keep / update / replace / insert / delete。
 *   3. 按**原始下标从大到小**执行。从后往前是关键:先动后面的,前面的下标才不会漂。
 *      文本类改动走 PATCH update_text_elements,block_id 不变,评论和位置都保住。
 *
 * 能力边界(先写清楚,免得误判):
 *   - 只在**顶层块**这一层对齐。表格改一格 = 整张表替换;嵌套列表改一项 = 该项整棵子树替换。
 *   - **图片按位置对齐,不比对内容**。飞书那边只有 file_token,Markdown 这边只有 URL,无从比对。
 *     同一位置的图片默认视为未变、不重传;要强制重传传 forceImages。
 *   - 文档里有 Markdown 生成不出来的块(画板、电子表格、高亮块、分栏……)时,这些块永远
 *     匹配不上新内容,默认会被计入删除(计划里单独标出来,必须显式确认才执行)。
 *     传 keepForeign 可以把它们原地留下——代价是文档会比 Markdown 源多出这些块。
 *   - 超过 499 cells 的大表格在文档里是被拆成多张子表存的,和 Markdown 里的一张表对不上,
 *     这种表每次都会整体重建。
 */
import {
  BT,
  BT_KEY,
  parseInline,
  markdownToBlocks,
  buildNestedListBlocks,
  buildQuoteContainerBlocks,
} from './feishu-doc-writer.mjs';

const TEXTISH = new Set(Object.keys(BT_KEY).map(Number)); // 段落/标题/列表项/引用
const LCS_CELL_LIMIT = 4_000_000; // 超过就别算了,退回全量重写

// 签名里的分隔符:用控制字符,正文里不可能出现,不会和内容撞车
const SEP_RUN = '\u0001';
const SEP_ELEM = '\u0002';
const SEP_CELL = '\u0003';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 签名 ────────────────────────────────────────────────────────────────────

/** 行内样式归一化:只比对会影响呈现的那几项,两侧用同一套写法 */
function styleKey(st = {}) {
  let link = '';
  const raw = st.link?.url;
  if (raw) {
    try { link = decodeURIComponent(raw); } catch { link = raw; }
  }
  return [
    st.bold ? 1 : 0,
    st.italic ? 1 : 0,
    st.strikethrough ? 1 : 0,
    st.underline ? 1 : 0,
    st.inline_code ? 1 : 0,
    link,
  ].join('');
}

/** elements → 签名。相邻同样式的 run 先合并,免得飞书拆分/合并 run 造成假差异 */
function elementsSig(elements = []) {
  const runs = [];
  for (const el of elements || []) {
    if (el?.text_run) {
      const k = styleKey(el.text_run.text_element_style);
      const c = el.text_run.content ?? '';
      if (runs.length && runs[runs.length - 1].k === k) runs[runs.length - 1].c += c;
      else runs.push({ k, c });
    } else {
      runs.push({ k: 'x', c: JSON.stringify(el) });
    }
  }
  return runs.map((r) => `${r.k}${SEP_RUN}${r.c}`).join(SEP_ELEM);
}

function plainText(elements = []) {
  return (elements || []).map((e) => e?.text_run?.content ?? '').join('');
}

/** Markdown 文本 → 与文档侧同口径的签名(先过 parseInline,把 **粗体** 这类标记吃掉) */
function mdSig(text) {
  return elementsSig(parseInline(text));
}

function mdPlain(text) {
  return plainText(parseInline(text));
}

function cut(s, n = 42) {
  const one = (s || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

function typeName(t) {
  if (t === BT.Text) return '段落';
  if (t >= BT.Heading1 && t <= BT.Heading6) return `标题${t - 2}`;
  if (t === BT.BulletItem) return '无序项';
  if (t === BT.OrderedItem) return '有序项';
  if (t === BT.Quote) return '引用';
  if (t === BT.Code) return '代码块';
  if (t === BT.Divider) return '分割线';
  if (t === BT.Image) return '图片';
  if (t === BT.Table) return '表格';
  if (t === BT.QuoteContainer) return '引用块';
  return `块类型${t}`;
}

// ─── Markdown 侧:块 → 单元 ───────────────────────────────────────────────────

function plainUnit(block) {
  const t = block.block_type;
  if (t === BT.Divider) {
    return { kind: 'plain', blockType: t, sig: `${t}`, data: block, preview: '分割线' };
  }
  if (t === BT.Code) {
    const lang = block.code?.style?.language ?? 1;
    return {
      kind: 'plain', blockType: t, lang, data: block,
      sig: `${t}:${lang}:${elementsSig(block.code?.elements)}`,
      preview: `代码块 ${cut(plainText(block.code?.elements), 30)}`,
    };
  }
  const key = BT_KEY[t];
  const elements = key ? block[key]?.elements : [];
  return {
    kind: 'plain', blockType: t, data: block,
    sig: `${t}:${elementsSig(elements)}`,
    preview: `${typeName(t)} ${cut(plainText(elements))}`,
  };
}

/** 列表项预览:带上子项文字,否则计划里只显示顶层那一行,看不出改的是哪个子项 */
function itemPreview(topText, childTexts) {
  const kids = childTexts.length ? ` › ${childTexts.join(' / ')}` : '';
  return cut(`列表项 ${topText}${kids}`, 68);
}

function mdItemTexts(item) {
  return (item.children || []).flatMap((c) => [mdPlain(c.text), ...mdItemTexts(c)]);
}

function itemSig(item) {
  const kids = (item.children || []).map(itemSig).join(',');
  return `${item.type}:${mdSig(item.text)}[${kids}]`;
}

function listItemUnit(item) {
  if (!item.children || item.children.length === 0) {
    const key = BT_KEY[item.type];
    return plainUnit({ block_type: item.type, [key]: { elements: parseInline(item.text), style: {} } });
  }
  return {
    kind: 'list_item', blockType: item.type, data: item,
    sig: `li:${itemSig(item)}`,
    preview: itemPreview(mdPlain(item.text), mdItemTexts(item)),
  };
}

function tableUnit(rows) {
  const cols = Math.max(...rows.map((r) => r.length));
  const cells = [];
  for (const row of rows) {
    for (let c = 0; c < cols; c++) cells.push(mdSig(row[c] || ''));
  }
  return {
    kind: 'table', data: rows,
    sig: `${BT.Table}:${rows.length}x${cols}|${cells.join(SEP_CELL)}`,
    preview: `表格 ${rows.length}行×${cols}列(${rows[0].slice(0, 3).map(mdPlain).join('/')})`,
  };
}

function imageUnit(block) {
  return { kind: 'image', data: block, sig: `${BT.Image}`, preview: `图片 ${cut(block.url, 50)}` };
}

function quoteContainerUnit(lines) {
  return {
    kind: 'quote_container', data: lines,
    sig: `${BT.QuoteContainer}:${lines.map(mdSig).join(SEP_CELL)}`,
    preview: `引用块 ${lines.length} 行`,
  };
}

export function unitsFromMarkdown(markdown) {
  const units = [];
  for (const b of markdownToBlocks(markdown)) {
    if (b._type === 'nested_list') for (const item of b.items) units.push(listItemUnit(item));
    else if (b._type === 'table') units.push(tableUnit(b.rows));
    else if (b._type === 'image') units.push(imageUnit(b));
    else if (b._type === 'quote_container') units.push(quoteContainerUnit(b.lines));
    else units.push(plainUnit(b));
  }
  return units;
}

// ─── 文档侧:块树 → 单元 ─────────────────────────────────────────────────────

function docItemSig(block, byId) {
  const key = BT_KEY[block.block_type];
  const self = `${block.block_type}:${elementsSig(key ? block[key]?.elements : [])}`;
  const kids = (block.children || [])
    .map((id) => byId[id])
    .filter(Boolean)
    .map((b) => docItemSig(b, byId))
    .join(',');
  return `${self}[${kids}]`;
}

function docTableSig(block, byId) {
  const prop = block.table?.property || {};
  const cells = (block.children || []).map((cid) => {
    const cell = byId[cid];
    return (cell?.children || [])
      .map((tid) => byId[tid])
      .filter(Boolean)
      .map((tb) => (BT_KEY[tb.block_type] ? elementsSig(tb[BT_KEY[tb.block_type]]?.elements) : ''))
      .join('\n');
  });
  return `${BT.Table}:${prop.row_size}x${prop.column_size}|${cells.join(SEP_CELL)}`;
}

function docUnit(block, byId, opts) {
  const t = block.block_type;
  const id = block.block_id;
  const base = { blockId: id, blockType: t };

  if (TEXTISH.has(t)) {
    const elements = block[BT_KEY[t]]?.elements;
    if (block.children?.length) {
      const kidTexts = [];
      const walk = (b) => {
        for (const cid of b.children || []) {
          const kid = byId[cid];
          if (!kid) continue;
          const k = BT_KEY[kid.block_type];
          kidTexts.push(plainText(k ? kid[k]?.elements : []));
          walk(kid);
        }
      };
      walk(block);
      return {
        ...base, kind: 'list_item', sig: `li:${docItemSig(block, byId)}`,
        preview: itemPreview(plainText(elements), kidTexts),
      };
    }
    return {
      ...base, kind: 'plain', sig: `${t}:${elementsSig(elements)}`,
      preview: `${typeName(t)} ${cut(plainText(elements))}`,
    };
  }
  if (t === BT.Code) {
    const lang = block.code?.style?.language ?? 1;
    return {
      ...base, kind: 'plain', lang, sig: `${t}:${lang}:${elementsSig(block.code?.elements)}`,
      preview: `代码块 ${cut(plainText(block.code?.elements), 30)}`,
    };
  }
  if (t === BT.Divider) return { ...base, kind: 'plain', sig: `${t}`, preview: '分割线' };
  if (t === BT.Image) {
    // 图片没法按内容比对:这边只有 file_token,Markdown 那边只有 URL。
    // 默认按位置视为未变;forceImages 时给唯一签名,强制重传。
    return { ...base, kind: 'image', sig: opts.forceImages ? `${t}:${id}` : `${t}`, preview: '图片' };
  }
  if (t === BT.Table) {
    const prop = block.table?.property || {};
    // cells 是行优先排布的,取表头就只能取前 column_size 个,别串到第二行去
    const head = (block.children || []).slice(0, Math.min(3, prop.column_size || 3)).map((cid) => {
      const cell = byId[cid];
      const tb = byId[(cell?.children || [])[0]];
      return tb && BT_KEY[tb.block_type] ? plainText(tb[BT_KEY[tb.block_type]]?.elements) : '';
    });
    return {
      ...base, kind: 'table', sig: docTableSig(block, byId),
      preview: `表格 ${prop.row_size}行×${prop.column_size}列(${head.join('/')})`,
    };
  }
  if (t === BT.QuoteContainer) {
    const lines = (block.children || [])
      .map((cid) => byId[cid])
      .filter(Boolean)
      .map((b) => (BT_KEY[b.block_type] ? elementsSig(b[BT_KEY[b.block_type]]?.elements) : ''));
    return { ...base, kind: 'quote_container', sig: `${t}:${lines.join(SEP_CELL)}`, preview: `引用块 ${lines.length} 行` };
  }
  // Markdown 生成不出来的块(画板/电子表格/高亮块/分栏……):唯一签名 = 永不匹配 = 会被删
  return { ...base, kind: 'foreign', sig: `other:${t}:${id}`, preview: `${typeName(t)}(Markdown 生成不了的块)` };
}

export function unitsFromDoc(blocks, docToken, opts = {}) {
  const byId = Object.create(null);
  for (const b of blocks) byId[b.block_id] = b;
  const page = byId[docToken];
  const order = page?.children?.length
    ? page.children
    : blocks.filter((b) => b.parent_id === docToken && b.block_type !== BT.Page).map((b) => b.block_id);
  return order.map((id) => byId[id]).filter(Boolean).map((b) => docUnit(b, byId, opts));
}

// ─── 对齐与计划 ──────────────────────────────────────────────────────────────

function lcsPairs(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * 粗粒度键:只看「是哪一类块」,不看内容。差异区间里用它再对齐一次,
 * 好让同类的块配上对(段落配段落、表配表),类型对不上的自然落进删除/新增,
 * 而不是按位置硬配——硬配会出现「把画板那一格拿去放新段落」这种错位。
 * foreign(画板/电子表格等)给唯一键 = 永不配对 = 一定进删除清单。
 */
function coarseKey(u) {
  if (u.kind === 'foreign') return `foreign:${u.blockId}`;
  if (u.kind === 'plain') return 'p';
  if (u.kind === 'list_item') return 'li';
  return u.kind; // table / image / quote_container
}

/** 能不能原地改:两边都是文本类、同类型;代码块还要同语言 */
function canUpdateInPlace(o, n) {
  if (o.kind !== 'plain' || n.kind !== 'plain') return false;
  if (o.blockType !== n.blockType) return false;
  if (o.blockType === BT.Divider) return false;
  if (o.blockType === BT.Code) return o.lang === n.lang;
  return TEXTISH.has(o.blockType);
}

/**
 * 产出操作列表。所有 index 都是**原始文档**的顶层下标,执行时从大到小走。
 * 返回 null = 两边都太长,LCS 不划算,让调用方退回全量重写。
 */
export function planPatch(oldUnits, newUnits, opts = {}) {
  if (oldUnits.length * newUnits.length > LCS_CELL_LIMIT) return null;
  // keepForeign:画板/电子表格这类 Markdown 生成不出来的块原地留着,只改它周围的内容。
  // 代价是最终文档 ≠ Markdown 源文件(多出这些块),这是有意的,计划里会报出来。
  const keepForeign = !!opts.keepForeign;

  const pairs = lcsPairs(oldUnits.map((u) => u.sig), newUnits.map((u) => u.sig));
  const ops = [];
  let oi = 0, nj = 0;

  // 一段「对不上」的区间:先按块类型再对齐一次,配上对的原地改/替换,
  // 剩下的老块删掉、剩下的新块插进来。插入位置取被删区间的末端(原始下标)。
  const gap = (oStart, oStop, nStart, nStop) => {
    if (oStop > oStart) {
      if (keepForeign) {
        // 把待删区间按 foreign 块切开:foreign 记 keep,其余照删
        let run = oStart;
        for (let i = oStart; i < oStop; i++) {
          if (oldUnits[i].kind !== 'foreign') continue;
          if (i > run) ops.push({ op: 'delete', index: run, start: run, end: i, units: oldUnits.slice(run, i) });
          ops.push({ op: 'keep', index: i, blockId: oldUnits[i].blockId, from: oldUnits[i], pinned: true });
          run = i + 1;
        }
        if (oStop > run) ops.push({ op: 'delete', index: run, start: run, end: oStop, units: oldUnits.slice(run, oStop) });
      } else {
        ops.push({ op: 'delete', index: oStart, start: oStart, end: oStop, units: oldUnits.slice(oStart, oStop) });
      }
    }
    if (nStop > nStart) {
      ops.push({ op: 'insert', index: oStop, units: newUnits.slice(nStart, nStop) });
    }
  };

  const region = (oEnd, nEnd) => {
    const oldSub = oldUnits.slice(oi, oEnd);
    const newSub = newUnits.slice(nj, nEnd);
    const byType = lcsPairs(oldSub.map(coarseKey), newSub.map(coarseKey));
    let a = 0, b = 0;
    for (const [pa, pb] of byType) {
      gap(oi + a, oi + pa, nj + b, nj + pb);
      const o = oldSub[pa], n = newSub[pb];
      const op = canUpdateInPlace(o, n) ? 'update' : 'replace';
      ops.push({ op, index: oi + pa, blockId: o.blockId, from: o, to: n });
      a = pa + 1; b = pb + 1;
    }
    gap(oi + a, oEnd, nj + b, nEnd);
  };

  for (const [mi, mj] of pairs) {
    region(mi, mj);
    ops.push({ op: 'keep', index: mi, blockId: oldUnits[mi].blockId, from: oldUnits[mi] });
    oi = mi + 1; nj = mj + 1;
  }
  region(oldUnits.length, newUnits.length);

  const stats = { keep: 0, update: 0, replace: 0, insert: 0, delete: 0 };
  for (const op of ops) {
    if (op.op === 'insert') stats.insert += op.units.length;
    else if (op.op === 'delete') stats.delete += op.units.length;
    else stats[op.op]++;
  }
  const removed = ops.flatMap((op) => (op.op === 'delete' ? op.units : op.op === 'replace' ? [op.from] : []));
  return {
    ops,
    stats,
    foreign: removed.filter((u) => u.kind === 'foreign'),
    foreignKept: ops.filter((op) => op.pinned).map((op) => op.from),
    destructive: stats.delete + stats.replace > 0,
  };
}

/** 把计划渲染成给人看的清单 */
export function describePlan(plan) {
  const s = plan.stats;
  const lines = [
    `计划:保留 ${s.keep} 块 · 原地改 ${s.update} 块 · 替换 ${s.replace} 块 · 新增 ${s.insert} 块 · 删除 ${s.delete} 块`,
  ];
  for (const op of plan.ops) {
    if (op.op === 'keep') continue;
    if (op.op === 'update') lines.push(`  ~ [${op.index}] ${op.from.preview}  →  ${op.to.preview}`);
    else if (op.op === 'replace') lines.push(`  ± [${op.index}] ${op.from.preview}  →  ${op.to.preview}`);
    else if (op.op === 'delete') for (const u of op.units) lines.push(`  - [${op.start}] ${u.preview}`);
    else if (op.op === 'insert') for (const u of op.units) lines.push(`  + [${op.index}] ${u.preview}`);
  }
  if (plan.foreign.length) {
    lines.push(`⚠️  其中 ${plan.foreign.length} 个块是 Markdown 生成不出来的(画板/电子表格等),会被删掉:`);
    for (const u of plan.foreign) lines.push(`     · ${u.preview}`);
    lines.push('     要原地保住它们,加 --keep-foreign 重跑(那样文档会比 Markdown 源多出这些块)。');
  }
  if (plan.foreignKept?.length) {
    lines.push(`ℹ️  --keep-foreign:${plan.foreignKept.length} 个非 Markdown 块原地保留(文档会比 Markdown 源多出它们):`);
    for (const u of plan.foreignKept) lines.push(`     · ${u.preview}`);
  }
  return lines.join('\n');
}

// ─── 执行 ────────────────────────────────────────────────────────────────────

/** 在 index 处按顺序插入若干单元,返回实际占掉的位置数 */
async function insertUnitsAt(writer, docToken, index, units) {
  let cursor = index;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    await writer.insertBlocksAt(docToken, batch, cursor);
    cursor += batch.length;
    batch = [];
    await sleep(400);
  };
  for (const u of units) {
    if (u.kind === 'plain') { batch.push(u.data); continue; }
    await flush();
    if (u.kind === 'table') {
      const r = await writer.insertTable(docToken, u.data, { index: cursor });
      cursor += r.chunks || 1;
    } else if (u.kind === 'image') {
      await writer.insertImageAt(docToken, u.data.url, u.data.alt, cursor);
      cursor += 1;
    } else if (u.kind === 'list_item') {
      await writer.insertSubtree(docToken, buildNestedListBlocks([u.data]), cursor);
      cursor += 1;
    } else if (u.kind === 'quote_container') {
      await writer.insertSubtree(docToken, buildQuoteContainerBlocks(u.data), cursor);
      cursor += 1;
    }
    await sleep(400);
  }
  await flush();
  return cursor - index;
}

function elementsOf(unit) {
  const t = unit.blockType;
  if (t === BT.Code) return unit.data.code?.elements || [];
  return unit.data[BT_KEY[t]]?.elements || [];
}

export async function applyPatch(writer, docToken, plan, opts = {}) {
  const log = opts.onLog || (() => {});
  // 从后往前执行:改动都落在当前 index 之后,前面的下标才保持原样
  const rank = (o) => (o.op === 'insert' ? 1 : 0); // 同下标时:先改/替换,再插入
  const todo = plan.ops
    .filter((o) => o.op !== 'keep')
    .sort((a, b) => b.index - a.index || rank(a) - rank(b));
  const done = { updated: 0, replaced: 0, inserted: 0, deleted: 0, fallback: 0 };

  for (const op of todo) {
    if (op.op === 'update') {
      try {
        await writer.updateTextElements(docToken, op.blockId, elementsOf(op.to));
        done.updated++;
        log(`~ [${op.index}] ${op.to.preview}`);
      } catch (e) {
        // update_text_elements 不吃这种块时退回「删一块补一块」,位置不变
        log(`~ [${op.index}] 原地改失败(${e.message}),退回替换`);
        await writer.deleteChildren(docToken, op.index, op.index + 1);
        await insertUnitsAt(writer, docToken, op.index, [op.to]);
        done.fallback++;
        done.replaced++;
      }
    } else if (op.op === 'replace') {
      await writer.deleteChildren(docToken, op.index, op.index + 1);
      await insertUnitsAt(writer, docToken, op.index, [op.to]);
      done.replaced++;
      log(`± [${op.index}] ${op.to.preview}`);
    } else if (op.op === 'delete') {
      await writer.deleteChildren(docToken, op.start, op.end);
      done.deleted += op.end - op.start;
      log(`- [${op.start},${op.end}) ${op.units.length} 块`);
    } else if (op.op === 'insert') {
      await insertUnitsAt(writer, docToken, op.index, op.units);
      done.inserted += op.units.length;
      log(`+ [${op.index}] ${op.units.length} 块`);
    }
    await sleep(200);
  }
  return done;
}

/**
 * 增量更新入口。
 * opts: { dryRun, forceImages, keepForeign, onLog }
 * 返回 { plan, applied, done? };文档过大时返回 { tooLarge: true },调用方退回全量重写。
 */
export async function patchDoc(writer, docToken, markdown, opts = {}) {
  const { blocks } = await writer.read(docToken);
  const oldUnits = unitsFromDoc(blocks, docToken, { forceImages: !!opts.forceImages });
  const newUnits = unitsFromMarkdown(markdown);
  const plan = planPatch(oldUnits, newUnits, { keepForeign: !!opts.keepForeign });
  if (!plan) return { tooLarge: true, oldCount: oldUnits.length, newCount: newUnits.length };
  if (opts.dryRun) return { plan, applied: false };
  const done = await applyPatch(writer, docToken, plan, opts);
  return { plan, applied: true, done };
}
