/**
 * patch-selftest.mjs —— feishu-doc-patch 的**离线**自检:不碰网络、不需要 token。
 *
 * 用一个假文档(内存里的块树)顶替飞书,跑「建文档 → 改 Markdown → patch」全流程,
 * 校验两条性质:
 *   1. patch 完成后,文档的签名序列必须等于新 Markdown 的签名序列(改对了);
 *   2. 计划里标 keep / update 的块,block_id 必须还在(没被顺手删掉重建)。
 * 重点覆盖多处同时改动——那是下标最容易漂的地方。
 *
 * 用法: node patch-selftest.mjs
 * 真实 API 那一半在 selftest.mjs 的 P13(需要 user token)。
 */
import { BT, BT_KEY, buildTableBlocks } from './feishu-doc-writer.mjs';
import {
  unitsFromMarkdown, unitsFromDoc, planPatch, applyPatch, describePlan,
} from './feishu-doc-patch.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));

class FakeDoc {
  constructor(token = 'DOC') {
    this.token = token;
    this.blocks = new Map();
    this.blocks.set(token, { block_id: token, block_type: BT.Page, parent_id: '', children: [] });
    this.n = 0;
    this.calls = [];
  }
  newId() { return 'b' + (++this.n); }
  get page() { return this.blocks.get(this.token); }
  async read() { return { title: 'fake', blocks: [...this.blocks.values()] }; }

  async insertBlocksAt(_doc, blocks, index) {
    this.calls.push(['insert', index, blocks.length]);
    const ids = blocks.map((b) => {
      const id = this.newId();
      this.blocks.set(id, { ...clone(b), block_id: id, parent_id: this.token });
      return id;
    });
    const at = index < 0 ? this.page.children.length : index;
    this.page.children.splice(at, 0, ...ids);
  }

  async insertSubtree(_doc, tree, index) {
    this.calls.push(['subtree', index]);
    const byTmp = new Map(tree.descendants.map((d) => [d.block_id, d]));
    const create = (tmpId, parentId) => {
      const d = byTmp.get(tmpId);
      const id = this.newId();
      const rec = { ...clone(d), block_id: id, parent_id: parentId };
      this.blocks.set(id, rec);
      rec.children = (d.children || []).map((c) => create(c, id));
      return id;
    };
    const roots = tree.children_id.map((t) => create(t, this.token));
    const at = index < 0 ? this.page.children.length : index;
    this.page.children.splice(at, 0, ...roots);
  }

  async insertTable(_doc, rows, opts = {}) {
    await this.insertSubtree(_doc, buildTableBlocks(rows), opts.index ?? -1);
    return { chunks: 1 };
  }

  async insertImageAt(_doc, url, alt, index) {
    this.calls.push(['image', index]);
    const id = this.newId();
    this.blocks.set(id, { block_id: id, parent_id: this.token, block_type: BT.Image, image: { token: 'ft_' + url } });
    const at = index < 0 ? this.page.children.length : index;
    this.page.children.splice(at, 0, id);
  }

  async deleteChildren(_doc, start, end) {
    this.calls.push(['delete', start, end]);
    const ids = this.page.children.splice(start, end - start);
    const drop = (id) => {
      const b = this.blocks.get(id);
      (b?.children || []).forEach(drop);
      this.blocks.delete(id);
    };
    ids.forEach(drop);
  }

  /** 手工塞一个 Markdown 生成不出来的块(画板 43 / 电子表格 30 之类) */
  async insertForeign(blockType, index = -1) {
    const id = this.newId();
    this.blocks.set(id, { block_id: id, parent_id: this.token, block_type: blockType, board: { token: 'brd_x' } });
    const at = index < 0 ? this.page.children.length : index;
    this.page.children.splice(at, 0, id);
    return id;
  }

  async updateTextElements(_doc, blockId, elements) {
    this.calls.push(['update', blockId]);
    const b = this.blocks.get(blockId);
    if (!b) throw new Error(`update 了不存在的块 ${blockId}`);
    const key = b.block_type === BT.Code ? 'code' : BT_KEY[b.block_type];
    if (!key) throw new Error(`块类型 ${b.block_type} 不支持 update_text_elements`);
    b[key] = { ...(b[key] || {}), elements };
  }
}

async function build(doc, markdown) {
  const plan = planPatch([], unitsFromMarkdown(markdown));
  await applyPatch(doc, doc.token, plan);
}

function sigs(units) { return units.map((u) => u.sig); }

let pass = 0, fail = 0;
async function check(name, A, B, expect = {}) {
  const doc = new FakeDoc();
  await build(doc, A);
  const before = unitsFromDoc((await doc.read()).blocks, doc.token);
  if (JSON.stringify(sigs(before)) !== JSON.stringify(sigs(unitsFromMarkdown(A)))) {
    console.log(`❌ ${name}: 初始构建就和 Markdown 对不上`);
    console.log('  doc:', sigs(before).map((s) => s.slice(0, 40)));
    console.log('  md :', sigs(unitsFromMarkdown(A)).map((s) => s.slice(0, 40)));
    fail++; return;
  }
  const idBefore = new Map(before.map((u, i) => [u.sig + '#' + i, u.blockId]));

  const plan = planPatch(before, unitsFromMarkdown(B));
  doc.calls = [];
  await applyPatch(doc, doc.token, plan);

  const after = unitsFromDoc((await doc.read()).blocks, doc.token);
  const want = unitsFromMarkdown(B);
  const ok = JSON.stringify(sigs(after)) === JSON.stringify(sigs(want));

  const problems = [];
  if (!ok) {
    problems.push('结果和目标 Markdown 不一致');
    console.log('  got :', sigs(after).map((s) => s.replace(/[-]/g, '|').slice(0, 50)));
    console.log('  want:', sigs(want).map((s) => s.replace(/[-]/g, '|').slice(0, 50)));
  }
  for (const [k, v] of Object.entries(expect)) {
    if (plan.stats[k] !== v) problems.push(`stats.${k} 期望 ${v},实际 ${plan.stats[k]}`);
  }
  // keep 的块必须还是原来那个 block_id
  const keptOps = plan.ops.filter((o) => o.op === 'keep');
  for (const op of keptOps) {
    if (!doc.blocks.has(op.blockId)) problems.push(`keep 的块 ${op.blockId} 竟然没了`);
  }
  // update 的块也必须保住 id
  for (const op of plan.ops.filter((o) => o.op === 'update')) {
    if (!doc.blocks.has(op.blockId)) problems.push(`update 的块 ${op.blockId} 竟然没了`);
  }

  if (problems.length) {
    console.log(`❌ ${name}: ${problems.join(' / ')}`);
    console.log(describePlan(plan).split('\n').map((l) => '     ' + l).join('\n'));
    fail++;
  } else {
    console.log(`✅ ${name}  (${JSON.stringify(plan.stats)})`);
    pass++;
  }
}

const BASE = `# 标题

第一段。

## 小节 A

- 列表一
- 列表二

| 列1 | 列2 |
|---|---|
| a | b |

\`\`\`js
const x = 1;
\`\`\`

> 引用一句。

最后一段。
`;

await check('改一个段落的文字', BASE, BASE.replace('第一段。', '第一段改了几个字。'), { update: 1, delete: 0, insert: 0, replace: 0 });

await check('段落里加粗一个词', BASE, BASE.replace('第一段。', '第**一**段。'), { update: 1 });

await check('中间插一段', BASE, BASE.replace('## 小节 A', '## 小节 A\n\n插进来的一段。'), { insert: 1, delete: 0, update: 0, replace: 0 });

await check('删掉中间一段', BASE, BASE.replace('第一段。\n\n', ''), { delete: 1, insert: 0, update: 0, replace: 0 });

await check('改表格一格', BASE, BASE.replace('| a | b |', '| a | B改了 |'), { replace: 1 });

await check('列表加一项', BASE, BASE.replace('- 列表二', '- 列表二\n- 列表三'), { insert: 1 });

await check('列表变嵌套', BASE, BASE.replace('- 列表二', '- 列表二\n  - 子项'), { });

await check('代码块改内容', BASE, BASE.replace('const x = 1;', 'const x = 2;'), { update: 1 });

await check('代码块换语言', BASE, BASE.replace('```js', '```python'), { replace: 1 });

await check('段落换成标题(类型变了)', BASE, BASE.replace('最后一段。', '### 最后一段。'), { replace: 1 });

await check('整体重排(标题挪到后面)', BASE, BASE.replace('## 小节 A\n\n', '') + '\n## 小节 A\n', {});

await check('清空到只剩一句', BASE, '# 只剩标题\n', {});

await check('从空文档写全量', '', BASE, {});

await check('内容完全没变', BASE, BASE, { update: 0, insert: 0, delete: 0, replace: 0 });

await check('图片位置不变则不重传', '# T\n\n![i](https://x/a.png)\n\n尾巴\n', '# T\n\n![i](https://x/a.png)\n\n尾巴改了\n', { update: 1, replace: 0, insert: 0, delete: 0 });

await check('引用块 + 分割线', '# T\n\n---\n\n>>>\n里面一行\n>>>\n\n尾\n', '# T\n\n---\n\n>>>\n里面改了\n>>>\n\n尾\n', { replace: 1 });

await check('长文档只改一处', Array.from({ length: 60 }, (_, i) => `第 ${i} 段。`).join('\n\n') + '\n',
  Array.from({ length: 60 }, (_, i) => (i === 37 ? '第 37 段改了。' : `第 ${i} 段。`)).join('\n\n') + '\n',
  { update: 1, keep: 59, insert: 0, delete: 0, replace: 0 });

// 多处同时改动:最能暴露下标漂移
const MULTI_A = ['第0段。', '第1段。', '第2段。', '第3段。', '第4段。', '第5段。', '第6段。'].join('\n\n') + '\n';
const MULTI_B = ['第0段改了。', '第1段。', '新插入A。', '第3段。', '第6段。', '尾部新增。'].join('\n\n') + '\n';
await check('一次改动 = 改头 + 中间删改 + 末尾新增', MULTI_A, MULTI_B, {});

await check('删一段同时在后面插两段', MULTI_A,
  ['第0段。', '第2段。', '第3段。', '第4段。', '第5段。', '第6段。', '追加1。', '追加2。'].join('\n\n') + '\n',
  { delete: 1, insert: 2, update: 0, replace: 0 });

await check('把表格挪到文档开头', BASE,
  '| 列1 | 列2 |\n|---|---|\n| a | b |\n\n' + BASE.replace('| 列1 | 列2 |\n|---|---|\n| a | b |\n\n', ''), {});

await check('每隔一段改一次(6 处 update)',
  Array.from({ length: 12 }, (_, i) => `行 ${i}。`).join('\n\n') + '\n',
  Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? `行 ${i} 改。` : `行 ${i}。`)).join('\n\n') + '\n',
  { update: 6, keep: 6, insert: 0, delete: 0, replace: 0 });

// 文档里有 Markdown 生成不出来的块(画板 43):默认删,--keep-foreign 原地留
{
  const A = '# T\n\n甲。\n\n乙。\n';
  const B = '# T\n\n甲。\n\n乙改了。\n';
  for (const keepForeign of [false, true]) {
    const doc = new FakeDoc();
    await build(doc, A);
    const boardId = await doc.insertForeign(43, 2); // 插在「甲。」后面
    const before = unitsFromDoc((await doc.read()).blocks, doc.token);
    const plan = planPatch(before, unitsFromMarkdown(B), { keepForeign });
    await applyPatch(doc, doc.token, plan);
    const alive = doc.blocks.has(boardId);
    const name = `画板处理(keepForeign=${keepForeign})`;
    const problems = [];
    if (keepForeign) {
      if (!alive) problems.push('--keep-foreign 却把画板删了');
      if (plan.foreignKept.length !== 1) problems.push(`应报告保留 1 个非 Markdown 块,实际 ${plan.foreignKept.length}`);
      if (plan.foreign.length) problems.push('保留模式不该把画板列进删除清单');
    } else {
      if (alive) problems.push('默认模式应删掉画板');
      if (plan.foreign.length !== 1) problems.push(`删除清单应列出 1 个非 Markdown 块,实际 ${plan.foreign.length}`);
    }
    // 不管哪种模式,文字改动都必须是原地改
    if (plan.stats.update !== 1) problems.push(`应原地改 1 块,实际 ${JSON.stringify(plan.stats)}`);
    const texts = unitsFromDoc((await doc.read()).blocks, doc.token).map(u => u.preview);
    if (!texts.some(t => t.includes('乙改了。'))) problems.push(`新文字没写进去: ${JSON.stringify(texts)}`);
    if (problems.length) { console.log(`❌ ${name}: ${problems.join(' / ')}`); fail++; }
    else { console.log(`✅ ${name}  (${JSON.stringify(plan.stats)}, 画板${alive ? '保留' : '已删'})`); pass++; }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
