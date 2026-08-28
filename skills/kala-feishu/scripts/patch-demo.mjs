/**
 * patch-demo.mjs —— 把 --patch 的四条边界跑给人看:每条建一个假文档,改一点点,
 * 打印**真实的**改动计划(和线上同一套差异计算)。离线、不需要 token、不改任何真文档。
 *
 * 用法: node patch-demo.mjs
 *
 * 它不是测试(断言在 patch-selftest.mjs),是「这个模式在这种情况下会怎么动」的活文档。
 * 边界:1a 表格改一格 · 1b 嵌套列表改子项 · 2 换图(默认/--force-images)·
 *       3 文档里有画板(默认删 / --keep-foreign 保留)· 4 超 499 cells 的大表。
 */
import { BT, BT_KEY, buildTableBlocks } from './feishu-doc-writer.mjs';
import {
  unitsFromMarkdown, unitsFromDoc, planPatch, applyPatch, describePlan,
} from './feishu-doc-patch.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));
const MAX_CELLS = 499; // 和 feishu-doc-writer.mjs 一致

class FakeDoc {
  constructor(token = 'DOC') {
    this.token = token;
    this.blocks = new Map();
    this.blocks.set(token, { block_id: token, block_type: BT.Page, parent_id: '', children: [] });
    this.n = 0;
  }
  newId() { return 'b' + (++this.n); }
  get page() { return this.blocks.get(this.token); }
  async read() { return { title: 'fake', blocks: [...this.blocks.values()] }; }
  place(ids, index) {
    const at = index < 0 ? this.page.children.length : index;
    this.page.children.splice(at, 0, ...ids);
  }
  async insertBlocksAt(_d, blocks, index) {
    this.place(blocks.map((b) => {
      const id = this.newId();
      this.blocks.set(id, { ...clone(b), block_id: id, parent_id: this.token });
      return id;
    }), index);
  }
  async insertSubtree(_d, tree, index) {
    const byTmp = new Map(tree.descendants.map((d) => [d.block_id, d]));
    const create = (tmpId, parentId) => {
      const d = byTmp.get(tmpId);
      const id = this.newId();
      const rec = { ...clone(d), block_id: id, parent_id: parentId };
      this.blocks.set(id, rec);
      rec.children = (d.children || []).map((c) => create(c, id));
      return id;
    };
    this.place(tree.children_id.map((t) => create(t, this.token)), index);
  }
  /** 照 _insertLargeTable 的算法:超过 499 cells 就拆成多张共享表头的子表 */
  async insertTable(_d, rows, opts = {}) {
    const cols = Math.max(...rows.map((r) => r.length));
    const index = opts.index ?? -1;
    if (rows.length * cols <= MAX_CELLS) {
      await this.insertSubtree(_d, buildTableBlocks(rows), index);
      return { chunks: 1 };
    }
    const perChunk = Math.floor(MAX_CELLS / cols);
    const chunks = [];
    for (let i = 0; i < rows.length - 1; i += perChunk - 1) {
      chunks.push([rows[0], ...rows.slice(1).slice(i, i + perChunk - 1)]);
    }
    for (let i = 0; i < chunks.length; i++) {
      await this.insertSubtree(_d, buildTableBlocks(chunks[i]), index < 0 ? -1 : index + i);
    }
    return { chunks: chunks.length };
  }
  async insertImageAt(_d, url, alt, index) {
    const id = this.newId();
    this.blocks.set(id, { block_id: id, parent_id: this.token, block_type: BT.Image, image: { token: 'ft_' + url } });
    this.place([id], index);
  }
  async deleteChildren(_d, start, end) {
    const drop = (id) => {
      const b = this.blocks.get(id);
      (b?.children || []).forEach(drop);
      this.blocks.delete(id);
    };
    this.page.children.splice(start, end - start).forEach(drop);
  }
  async updateTextElements(_d, blockId, elements) {
    const b = this.blocks.get(blockId);
    const key = b.block_type === BT.Code ? 'code' : BT_KEY[b.block_type];
    b[key] = { ...(b[key] || {}), elements };
  }
  /** 手工塞一个 Markdown 生成不出来的块(画板 43 / 电子表格 30 之类) */
  async insertForeign(blockType, index = -1) {
    const id = this.newId();
    this.blocks.set(id, { block_id: id, parent_id: this.token, block_type: blockType, board: { token: 'brd_x' } });
    this.place([id], index);
    return id;
  }
}

async function build(doc, markdown) {
  await applyPatch(doc, doc.token, planPatch([], unitsFromMarkdown(markdown)));
}

async function show(title, note, doc, targetMd, opts = {}) {
  const before = unitsFromDoc((await doc.read()).blocks, doc.token, opts);
  const plan = planPatch(before, unitsFromMarkdown(targetMd), opts);
  console.log(`\n${'═'.repeat(72)}\n【${title}】\n${note}`);
  console.log(`文档现有 ${before.length} 个顶层块:`);
  before.forEach((u, i) => console.log(`   [${i}] ${u.preview}`));
  console.log(describePlan(plan));
  return plan;
}

// ── 边界 1a:表格改一格 = 整张表替换 ───────────────────────────────────────
{
  const A = `# 报表

| 地区 | 销量 |
|---|---|
| 华东 | 100 |
| 华南 | 200 |

说明文字。
`;
  const doc = new FakeDoc();
  await build(doc, A);
  await show(
    '边界 1a:表格改一格',
    '只把「100」改成「120」,其他一个字没动。',
    doc, A.replace('| 100 |', '| 120 |'),
  );
}

// ── 边界 1b:嵌套列表改一个子项 = 该顶层项整棵子树替换 ─────────────────────
{
  const A = `# 计划

- 一期
  - 需求梳理
  - 原型评审
- 二期
  - 联调
`;
  const doc = new FakeDoc();
  await build(doc, A);
  await show(
    '边界 1b:嵌套列表改一个子项',
    '只把「原型评审」改成「原型评审(已排期)」。它是「一期」下面的子项。',
    doc, A.replace('原型评审', '原型评审(已排期)'),
  );
}

// ── 边界 2:图片按位置视为未变 ─────────────────────────────────────────────
{
  const A = `# 图示

![图](https://example.com/old.png)

图下说明。
`;
  const B = `# 图示

![图](https://example.com/NEW.png)

图下说明。
`;
  const doc = new FakeDoc();
  await build(doc, A);
  await show(
    '边界 2:换了图片 URL(默认)',
    'Markdown 里 old.png 换成了 NEW.png,位置没动。',
    doc, B,
  );
  await show(
    '边界 2:同样的改动,带 --force-images',
    '同一份 Markdown,只是这次强制重传图片。',
    doc, B, { forceImages: true },
  );
}

// ── 边界 3:Markdown 生成不出来的块会进删除清单 ────────────────────────────
{
  const A = `# 会议纪要

结论一。

结论二。
`;
  const doc = new FakeDoc();
  await build(doc, A);
  await doc.insertForeign(43, 2); // 43 = 画板,插在「结论一」后面
  await show(
    '边界 3:文档里有画板',
    '有人在飞书里往文档中间插了一块画板。Markdown 源文件里当然没有它。' +
    '\n这次只想改「结论二」的文字。',
    doc, A.replace('结论二。', '结论二改了。'),
  );
}

// ── 边界 3 的解法:--keep-foreign 把画板原地留下 ────────────────────────────
{
  const A = `# 会议纪要

结论一。

结论二。
`;
  const doc = new FakeDoc();
  await build(doc, A);
  await doc.insertForeign(43, 2);
  await show(
    '边界 3 的解法:同样的文档,加 --keep-foreign',
    '同一份改动,这次让画板留在原地。注意最终文档会比 Markdown 源多出这块画板——这是有意的。',
    doc, A.replace('结论二。', '结论二改了。'), { keepForeign: true },
  );
}

// ── 边界 4:大表格(>499 cells)每次整体重建 ───────────────────────────────
{
  const rows = [['列A', '列B', '列C']];
  for (let i = 1; i <= 199; i++) rows.push([`r${i}c1`, `r${i}c2`, `r${i}c3`]);
  const md = '# 大表\n\n' + rows.map((r) => `| ${r.join(' | ')} |`).join('\n').replace(
    /^(\| 列A \| 列B \| 列C \|)$/m, '$1\n|---|---|---|',
  ) + '\n\n表后说明。\n';
  const doc = new FakeDoc();
  await build(doc, md);
  await show(
    '边界 4:200 行 × 3 列 = 600 cells 的大表',
    '这张表在飞书里被拆成了多张子表存(单表上限 499 cells)。' +
    '\n这次只改表后面的说明文字,表本身一个字没动。',
    doc, md.replace('表后说明。', '表后说明改了。'),
  );
}

console.log('');
