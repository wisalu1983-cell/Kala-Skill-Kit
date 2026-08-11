/**
 * selftest.mjs —— kala-feishu 端到端自动化冒烟测试。
 *
 * 跑真实飞书 API,逐项打印 PASS/FAIL/SKIP,结束自动清理本次创建的所有对象。
 * 所有测试对象都建在一个带时间戳的隔离容器里(云盘 __kala_selftest__<ts> 文件夹),
 * 绝不触碰任何已有正式文档。
 *
 * 前置:必须已有可用的 user token(node feishu-oauth.mjs auth / status 确认)。
 *       没有 user token 时直接给出提示并退出,不产生误导性的 FAIL。
 *
 * 用法: node selftest.mjs
 *       node selftest.mjs --only P7     # 只跑 id 以 P7 开头的用例(开发期用,省去每轮全量重跑)
 *
 * 阶段:P0 部署 · P1/P2 云盘文档 · P3/P4 知识库 · P5 token/错误码 · P6 评论
 *      P7 电子表格 · P8 多维表格 · P9 CLI 契约与删除门槛 · P10 体积保护/分批/URL 解析
 *      P11 网络重试策略 · P12 画板(board)
 *
 * 退出码:所有「必需」用例(P0–P2、P5–P12)通过 = 0;有必需用例 FAIL = 1。
 *        知识库用例(P3–P4)在本机无 wiki 条件时记为 SKIP,不影响退出码。
 */
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { FeishuDocWriter } from './feishu-doc-writer.mjs';
import { api, resetUserToken } from './feishu-api.mjs';
import { getNode } from './feishu-wiki.mjs';

const TS = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const CONTAINER = `__kala_selftest__${TS}`;

// --only <前缀>[,<前缀>...]:只跑 id 以这些前缀开头的用例(如 `--only P7,P8,P9`,
// 后段用例依赖前段建的对象时要一起带上)。隔离容器仍会建,跑完照常清理。
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
const onlyList = ONLY ? ONLY.split(',').map(s => s.trim()).filter(Boolean) : null;
const wanted = id => !onlyList || onlyList.some(p => id.startsWith(p));

const results = [];
function log(status, id, name, detail) {
  const icon = { PASS: '✅', FAIL: '❌', SKIP: '⚠️ ', INFO: '·' }[status] || '';
  results.push({ status, id, name, detail });
  console.log(`${icon} [${status}] ${id} ${name}${detail ? '  — ' + detail : ''}`);
}

// 追踪需要清理的对象(倒序清理)
const cleanup = [];

const TEST_MD = `# kala-feishu 自检文档

普通段落里有**粗体**、*斜体*、~~删除线~~、\`inline code\`,还有[链接](https://feishu.cn)。

## 二级标题

### 三级标题

- 无序一
- 无序二,带**粗体**
  - 嵌套子项 A
  - 嵌套子项 B

1. 有序一
2. 有序二

> 这是一段引用。

\`\`\`javascript
const ok = true;
console.log('kala', ok);
\`\`\`

---

| 功能 | 状态 |
|------|------|
| 标题 | ✅ |
| 表格 | ✅ |
| 列表 | ✅ |
`;

async function main() {
  // ── P0 部署自检 ──────────────────────────────────────────────
  const w = new FeishuDocWriter();
  await w.init();
  if (w.tokenType !== 'user') {
    log('FAIL', 'P0', '身份检查', `当前是 ${w.tokenType} token,自检需要 user token。请先: node feishu-oauth.mjs auth`);
    console.log('\n中止:缺少 user token,不继续跑(避免误导性 FAIL)。');
    process.exit(1);
  }
  log('PASS', 'P0', '部署自检', `user token OK`);

  // 容器文件夹(create_folder 必须带父 folder_token,根目录要先取 root token)
  const root = await api('GET', '/drive/explorer/v2/root_folder/meta');
  const folder = await api('POST', '/drive/v1/files/create_folder', { body: { name: CONTAINER, folder_token: root.token } });
  const containerToken = folder.token;
  cleanup.push({ kind: 'file', token: containerToken, type: 'folder', desc: `容器 ${CONTAINER}` });
  log('INFO', '--', '隔离容器', `${CONTAINER} (${containerToken})`);

  // ── P1 云盘文档:编辑 ─────────────────────────────────────────
  let docToken;
  await run('P1.1', '云盘·建文档', async () => {
    const doc = await w.create('kala 自检-P1', containerToken);
    docToken = doc.document_id;
    cleanup.push({ kind: 'file', token: docToken, type: 'docx', desc: 'P1 文档' });
    return docToken;
  });

  await run('P1.2', '云盘·全元素写入', async () => {
    const r = await w.write(docToken, TEST_MD);
    if (!r.success) throw new Error('write 未返回 success');
    return `写入 ${r.blocks_added} 块`;
  });

  await run('P1.3', '云盘·读回校验', async () => {
    const { blocks } = await w.read(docToken);
    const types = new Set(blocks.map(b => b.block_type));
    const need = { 标题: 3, 表格: 31, 代码: 14 };
    const missing = Object.entries(need).filter(([, t]) => !types.has(t)).map(([n]) => n);
    if (missing.length) throw new Error(`缺失块类型: ${missing.join('/')}`);
    return `块类型齐全 (${blocks.length} 块)`;
  });

  await run('P1.4', '云盘·追加', async () => {
    const before = (await w.read(docToken)).blocks.length;
    await w.append(docToken, '\n## 追加段\n\n这是追加的一段。\n');
    const after = (await w.read(docToken)).blocks.length;
    if (after <= before) throw new Error(`追加后块数未增加 (${before}→${after})`);
    return `${before}→${after}`;
  });

  await run('P1.5', '云盘·全量重写', async () => {
    await w.write(docToken, '# 重写后\n\n只剩这一段。\n');
    const { blocks } = await w.read(docToken);
    if (blocks.length > 5) throw new Error(`重写后块数异常偏多: ${blocks.length}`);
    return `重写为 ${blocks.length} 块`;
  });

  // 图片:最优努力(需能访问图片主机),失败记 SKIP 不算 FAIL
  await run('P1.6', '云盘·图片插入(最优努力)', async () => {
    await w.append(docToken, '\n![dot](https://open.feishu.cn/favicon.ico)\n');
    return '图片块已插入';
  }, { required: false });

  // ── P2 云盘:结构管理 ────────────────────────────────────────
  let subFolder;
  await run('P2.1', '云盘·建子文件夹', async () => {
    const f = await api('POST', '/drive/v1/files/create_folder', { body: { name: 'sub', folder_token: containerToken } });
    subFolder = f.token;
    return subFolder;
  });

  let uploadedToken;
  const tmpFile = join(tmpdir(), `kala-selftest-${TS}.txt`);
  await run('P2.2', '云盘·上传文件', async () => {
    writeFileSync(tmpFile, 'kala selftest upload\n', 'utf8');
    const { readFileSync } = await import('fs');
    const buf = readFileSync(tmpFile);
    const { uploadMultipart } = await import('./feishu-api.mjs');
    const d = await uploadMultipart('/drive/v1/files/upload_all', [
      ['file_name', `kala-selftest-${TS}.txt`],
      ['parent_type', 'explorer'],
      ['parent_node', containerToken],
      ['size', String(buf.length)],
      ['file', buf, { filename: `kala-selftest-${TS}.txt`, contentType: 'text/plain' }],
    ]);
    uploadedToken = d.file_token;
    cleanup.push({ kind: 'file', token: uploadedToken, type: 'file', desc: '上传文件' });
    return uploadedToken;
  });

  await run('P2.3', '云盘·移动文档', async () => {
    await api('POST', `/drive/v1/files/${docToken}/move`, { body: { type: 'docx', folder_token: subFolder } });
    return `→ sub`;
  });

  await run('P2.4', '云盘·设公开权限', async () => {
    // 文档归用户所有 → 用 user token(owner 身份)设权限
    await api('PATCH', `/drive/v1/permissions/${docToken}/public`, {
      query: { type: 'docx' },
      body: { external_access_entity: 'open', security_entity: 'anyone_can_view', link_share_entity: 'anyone_readable' },
    });
    return 'anyone_readable';
  }, { required: false }); // 组织可能整体禁用外链分享,设为非必需

  // ── P3/P4 知识库(条件门)────────────────────────────────────
  let spaceId, wikiNodeToken, wikiObjToken;
  // --only 指向别的阶段时不必探测 wiki(省一次请求,也避免无关的 SKIP 混进汇总)
  let wikiAvailable = wanted('P3') || wanted('P4');
  if (wikiAvailable) {
    try {
      const sp = await api('GET', '/wiki/v2/spaces', { query: { page_size: '10' } });
      const spaces = sp.items || [];
      if (!spaces.length) { wikiAvailable = false; log('SKIP', 'P3-P4', '知识库全部', '本机无可用知识库空间'); }
      else spaceId = spaces[0].space_id;
    } catch (e) {
      wikiAvailable = false;
      log('SKIP', 'P3-P4', '知识库全部', `列空间失败(多半是缺 wiki 权限): ${e.message}`);
    }
  }

  if (wikiAvailable) {
    const ok = await run('P3.1/2', '知识库·列空间+建节点', async () => {
      const node = await api('POST', `/wiki/v2/spaces/${spaceId}/nodes`, {
        body: { obj_type: 'docx', node_type: 'origin', title: `kala 自检-wiki-${TS}` },
      });
      wikiNodeToken = node.node.node_token;
      wikiObjToken = node.node.obj_token;
      cleanup.push({ kind: 'file', token: wikiObjToken, type: 'docx', desc: 'wiki 节点底层文档' });
      return `space=${spaceId} node=${wikiNodeToken} obj=${wikiObjToken}`;
    }, { required: false });

    if (ok !== false && wikiObjToken) {
      await run('P3.3', '知识库·写入 obj', async () => {
        const r = await w.write(wikiObjToken, TEST_MD);
        return `写入 ${r.blocks_added} 块`;
      }, { required: false });

      await run('P3.4', '知识库·URL 自动解析(填坑)', async () => {
        const node = await getNode(wikiNodeToken);
        if (node.obj_token !== wikiObjToken) throw new Error(`解析 obj_token 不一致: ${node.obj_token} != ${wikiObjToken}`);
        return `node→obj 解析一致`;
      }, { required: false });

      await run('P3.5', '知识库·读回', async () => {
        const { blocks } = await w.read(wikiObjToken);
        if (!blocks.length) throw new Error('读回为空');
        return `${blocks.length} 块`;
      }, { required: false });

      await run('P4.1', '知识库·重命名', async () => {
        await api('POST', `/wiki/v2/spaces/${spaceId}/nodes/${wikiNodeToken}/update_title`, { body: { title: `kala 自检-改名-${TS}` } });
        return '已改名';
      }, { required: false });

      await run('P4.2', '知识库·树内移动', async () => {
        const parent = await api('POST', `/wiki/v2/spaces/${spaceId}/nodes`, {
          body: { obj_type: 'docx', node_type: 'origin', title: `kala 自检-父-${TS}` },
        });
        cleanup.push({ kind: 'file', token: parent.node.obj_token, type: 'docx', desc: 'wiki 父节点底层文档' });
        await api('POST', `/wiki/v2/spaces/${spaceId}/nodes/${wikiNodeToken}/move`, { body: { target_parent_token: parent.node.node_token } });
        return `移到新父节点`;
      }, { required: false });
    }
  }

  // ── P6 评论(全文评论:建/列/解决)────────────────────────────
  let commentId;
  await run('P6.1', '评论·建全文评论', async () => {
    const r = await api('POST', `/drive/v1/files/${docToken}/comments`, {
      query: { file_type: 'docx' },
      body: { is_whole: true, reply_list: { replies: [ { content: { elements: [ { type: 'text_run', text_run: { text: 'kala 自检评论' } } ] } } ] } },
    });
    commentId = r.comment_id;
    return commentId;
  });
  await run('P6.2', '评论·列出并校验', async () => {
    const d = await api('GET', `/drive/v1/files/${docToken}/comments`, { query: { file_type: 'docx' } });
    if (!(d.items || []).some(c => c.comment_id === commentId)) throw new Error('列表里找不到刚建的评论');
    return `${(d.items || []).length} 条`;
  });
  await run('P6.3', '评论·标记已解决', async () => {
    await api('PATCH', `/drive/v1/files/${docToken}/comments/${commentId}`, { query: { file_type: 'docx' }, body: { is_solved: true } });
    const d = await api('GET', `/drive/v1/files/${docToken}/comments/${commentId}`, { query: { file_type: 'docx' } });
    if (!d.is_solved) throw new Error('标记已解决后 is_solved 仍为 false');
    return 'solved';
  });

  // ── P7 电子表格 sheets ──────────────────────────────────────
  let ssToken, sheetId;
  await run('P7.1', 'sheets·建表格', async () => {
    const S = await import('./feishu-sheets.mjs');
    const ss = await S.createSpreadsheet(`kala 自检-P7-${TS}`, containerToken);
    ssToken = ss.spreadsheet_token;
    if (!ssToken) throw new Error('未返回 spreadsheet_token');
    cleanup.push({ kind: 'file', token: ssToken, type: 'sheet', desc: 'P7 电子表格' });
    return ssToken;
  });

  await run('P7.2', 'sheets·列工作表', async () => {
    const S = await import('./feishu-sheets.mjs');
    const sheets = await S.listSheets(ssToken);
    if (!sheets.length) throw new Error('工作表清单为空');
    sheetId = sheets[0].sheet_id;
    if (!sheetId) throw new Error('工作表缺 sheet_id');
    if (!sheets[0].title) throw new Error('工作表缺 title');
    return `${sheets.length} 张,首张 ${sheetId}(${sheets[0].title})`;
  });

  await run('P7.3', 'sheets·写区域', async () => {
    const S = await import('./feishu-sheets.mjs');
    const r = await S.writeRange(ssToken, `${sheetId}!A1:C2`, [['姓名', '分数', '备注'], ['卡拉', 99, '首轮']]);
    if (r.updated_cells !== 6) throw new Error(`updated_cells 应为 6,实际 ${JSON.stringify(r)}`);
    return `${r.updated_cells} 格`;
  });

  await run('P7.4', 'sheets·读回逐格比对', async () => {
    const S = await import('./feishu-sheets.mjs');
    const got = await S.readRange(ssToken, `${sheetId}!A1:C2`);
    const expect = [['姓名', '分数', '备注'], ['卡拉', 99, '首轮']];
    if (JSON.stringify(got.values) !== JSON.stringify(expect)) {
      throw new Error(`读回不一致: ${JSON.stringify(got.values)} != ${JSON.stringify(expect)}`);
    }
    return '逐格一致(数字仍是 number)';
  });

  await run('P7.5', 'sheets·CSV 写入(数字识别+引号转义)', async () => {
    const S = await import('./feishu-sheets.mjs');
    const csv = join(tmpdir(), `kala-p7-${TS}.csv`);
    // 第 2 行第 3 列是带转义双引号的 CSV 值,解析后应为:含"引号"的值
    writeFileSync(csv, '城市,人口,备注\n上海,2487,"含""引号""的值"\n北京,2189,\n', 'utf8');
    try {
      const r = await S.writeCsv(ssToken, sheetId, csv, { startCell: 'E1' });
      if (r.rows !== 3) throw new Error(`应写 3 行,实际 ${r.rows}`);
      const got = await S.readRange(ssToken, `${sheetId}!E1:G3`);
      const num = got.values[1][1];
      if (num !== 2487) throw new Error(`数字应识别为 number,实际 ${JSON.stringify(num)} (${typeof num})`);
      if (got.values[1][2] !== '含"引号"的值') throw new Error(`引号转义解析错: ${JSON.stringify(got.values[1][2])}`);
      return '3 行,数字与引号均正确';
    } finally {
      try { unlinkSync(csv); } catch { /* 临时文件,删不掉不影响 */ }
    }
  });

  let sheet2Id;
  await run('P7.6', 'sheets·加工作表', async () => {
    const S = await import('./feishu-sheets.mjs');
    const s = await S.addSheet(ssToken, '第二张');
    sheet2Id = s.sheet_id;
    if (!sheet2Id) throw new Error('未返回 sheet_id');
    const all = await S.listSheets(ssToken);
    if (all.length !== 2) throw new Error(`应有 2 张工作表,实际 ${all.length}`);
    return sheet2Id;
  });

  await run('P7.7', 'sheets·工作表改名', async () => {
    const S = await import('./feishu-sheets.mjs');
    await S.renameSheet(ssToken, sheet2Id, '改过名的');
    const all = await S.listSheets(ssToken);
    const t = all.find(s => s.sheet_id === sheet2Id)?.title;
    if (t !== '改过名的') throw new Error(`改名未生效,当前 title=${t}`);
    return '改过名的';
  });

  await run('P7.8', 'sheets·追加行(不覆盖原内容)', async () => {
    const S = await import('./feishu-sheets.mjs');
    await S.writeRange(ssToken, `${sheet2Id}!A1:B2`, [['a', 1], ['b', 2]]);
    const r = await S.appendRows(ssToken, sheet2Id, [['c', 3], ['d', 4]]);
    if (r.appended_rows !== 2) throw new Error(`应追加 2 行,实际 ${JSON.stringify(r)}`);
    const got = await S.readRange(ssToken, `${sheet2Id}!A1:B4`);
    const expect = [['a', 1], ['b', 2], ['c', 3], ['d', 4]];
    if (JSON.stringify(got.values) !== JSON.stringify(expect)) {
      throw new Error(`追加后内容不符: ${JSON.stringify(got.values)}`);
    }
    return '原 2 行保留,新 2 行接在其后';
  });

  await run('P7.9', 'sheets·删工作表', async () => {
    const S = await import('./feishu-sheets.mjs');
    await S.deleteSheet(ssToken, sheet2Id);
    const all = await S.listSheets(ssToken);
    if (all.some(s => s.sheet_id === sheet2Id)) throw new Error('删除后仍在清单里');
    return `剩 ${all.length} 张`;
  });

  let sheet3Id;
  await run('P7.10', 'sheets·删除行(后续行上移)', async () => {
    const S = await import('./feishu-sheets.mjs');
    const s = await S.addSheet(ssToken, '行列测试');
    sheet3Id = s.sheet_id;
    await S.writeRange(ssToken, `${sheet3Id}!A1:A4`, [['r1'], ['r2'], ['r3'], ['r4']]);
    await S.deleteRows(ssToken, sheet3Id, 2, 1); // 删第 2 行(行号从 1 数,真人视角)
    const got = await S.readRange(ssToken, `${sheet3Id}!A1:A3`);
    const flat = got.values.map(r => r[0]);
    if (JSON.stringify(flat) !== JSON.stringify(['r1', 'r3', 'r4'])) {
      throw new Error(`删行后应为 r1/r3/r4,实际 ${JSON.stringify(flat)}`);
    }
    return 'r2 已删,r3/r4 上移';
  });

  await run('P7.11', 'sheets·插入行(在指定行之前)', async () => {
    const S = await import('./feishu-sheets.mjs');
    await S.insertRows(ssToken, sheet3Id, 2, 1); // 在第 2 行之前插 1 行
    const got = await S.readRange(ssToken, `${sheet3Id}!A1:A4`);
    const flat = got.values.map(r => r[0]);
    if (flat[0] !== 'r1' || flat[2] !== 'r3') {
      throw new Error(`插行后 A1 应为 r1、A3 应为 r3,实际 ${JSON.stringify(flat)}`);
    }
    if (flat[1] !== null && flat[1] !== '') throw new Error(`插入的行应为空,实际 ${JSON.stringify(flat[1])}`);
    return '第 2 行为新空行,原内容下移';
  });

  await run('P7.12', 'sheets·插入/删除列', async () => {
    const S = await import('./feishu-sheets.mjs');
    await S.writeRange(ssToken, `${sheet3Id}!C1:D1`, [['c', 'd']]);
    await S.insertCols(ssToken, sheet3Id, 3, 1); // 在第 3 列(C)之前插一列
    let got = await S.readRange(ssToken, `${sheet3Id}!C1:E1`);
    if (got.values[0][1] !== 'c') throw new Error(`插列后 D1 应为 c,实际 ${JSON.stringify(got.values[0])}`);
    await S.deleteCols(ssToken, sheet3Id, 3, 1);
    got = await S.readRange(ssToken, `${sheet3Id}!C1:D1`);
    if (got.values[0][0] !== 'c') throw new Error(`删列后 C1 应复原为 c,实际 ${JSON.stringify(got.values[0])}`);
    return '插列右移、删列复原';
  });

  await run('P7.13', 'sheets·清空区域', async () => {
    const S = await import('./feishu-sheets.mjs');
    await S.clearRange(ssToken, `${sheet3Id}!A1:E10`);
    const got = await S.readRange(ssToken, `${sheet3Id}!A1:E10`);
    const nonEmpty = (got.values || []).flat().filter(v => v !== null && v !== '');
    if (nonEmpty.length) throw new Error(`清空后仍有内容: ${JSON.stringify(nonEmpty)}`);
    return '区域已空';
  });

  // ── P8 多维表格 bitable ─────────────────────────────────────
  let baseToken, tableId;
  await run('P8.1', 'bitable·建多维表格', async () => {
    const B = await import('./feishu-bitable.mjs');
    const b = await B.createBase(`kala 自检-P8-${TS}`, containerToken);
    baseToken = b.app_token;
    if (!baseToken) throw new Error('未返回 app_token');
    cleanup.push({ kind: 'file', token: baseToken, type: 'bitable', desc: 'P8 多维表格' });
    return baseToken;
  });

  await run('P8.2', 'bitable·列数据表', async () => {
    const B = await import('./feishu-bitable.mjs');
    const tables = await B.listTables(baseToken);
    if (!tables.length) throw new Error('数据表清单为空');
    tableId = tables[0].table_id;
    if (!tableId || !tables[0].name) throw new Error(`数据表缺 table_id/name: ${JSON.stringify(tables[0])}`);
    return `${tables.length} 张,首张 ${tableId}(${tables[0].name})`;
  });

  let table2Id;
  await run('P8.3', 'bitable·新增数据表', async () => {
    const B = await import('./feishu-bitable.mjs');
    const t = await B.addTable(baseToken, '第二张表');
    table2Id = t.table_id;
    if (!table2Id) throw new Error('未返回 table_id');
    const all = await B.listTables(baseToken);
    if (all.length !== 2) throw new Error(`应有 2 张数据表,实际 ${all.length}`);
    return table2Id;
  });

  await run('P8.4', 'bitable·删数据表', async () => {
    const B = await import('./feishu-bitable.mjs');
    await B.deleteTable(baseToken, table2Id);
    const all = await B.listTables(baseToken);
    if (all.some(t => t.table_id === table2Id)) throw new Error('删除后仍在清单里');
    return `剩 ${all.length} 张`;
  });

  let fieldId;
  await run('P8.5', 'bitable·列字段(带可读类型名)', async () => {
    const B = await import('./feishu-bitable.mjs');
    const fields = await B.listFields(baseToken, tableId);
    if (!fields.length) throw new Error('字段清单为空');
    if (!fields[0].field_name || !fields[0].type_name) {
      throw new Error(`字段应同时带 field_name 和可读 type_name: ${JSON.stringify(fields[0])}`);
    }
    return fields.map(f => `${f.field_name}(${f.type_name})`).join('/');
  });

  await run('P8.6', 'bitable·新增字段(类型用中文名)', async () => {
    const B = await import('./feishu-bitable.mjs');
    const f = await B.addField(baseToken, tableId, '分数', '数字');
    fieldId = f.field_id;
    if (!fieldId) throw new Error('未返回 field_id');
    const got = (await B.listFields(baseToken, tableId)).find(x => x.field_id === fieldId);
    if (got?.type_name !== '数字') throw new Error(`新字段类型应为数字,实际 ${got?.type_name}`);
    return `分数(数字)`;
  });

  await run('P8.7', 'bitable·改字段名(保留原类型)', async () => {
    const B = await import('./feishu-bitable.mjs');
    await B.updateField(baseToken, tableId, fieldId, { name: '总分' });
    const got = (await B.listFields(baseToken, tableId)).find(x => x.field_id === fieldId);
    if (got?.field_name !== '总分') throw new Error(`改名未生效,当前 ${got?.field_name}`);
    if (got?.type_name !== '数字') throw new Error(`只改名不该动类型,当前 ${got?.type_name}`);
    return '总分(数字)';
  });

  await run('P8.8', 'bitable·删字段', async () => {
    const B = await import('./feishu-bitable.mjs');
    await B.deleteField(baseToken, tableId, fieldId);
    const fields = await B.listFields(baseToken, tableId);
    if (fields.some(x => x.field_id === fieldId)) throw new Error('删除后仍在字段清单里');
    return `剩 ${fields.length} 个字段`;
  });

  let recId;
  await run('P8.9', 'bitable·新增记录(JSON)', async () => {
    const B = await import('./feishu-bitable.mjs');
    await B.addField(baseToken, tableId, '数量', '数字');
    const r = await B.addRecord(baseToken, tableId, { 文本: '第一条', 数量: 42 });
    recId = r.record_id;
    if (!recId) throw new Error('未返回 record_id');
    return recId;
  });

  await run('P8.10', 'bitable·读记录(文本归一化+数字类型)', async () => {
    const B = await import('./feishu-bitable.mjs');
    const { records } = await B.listRecords(baseToken, tableId);
    const got = records.find(r => r.record_id === recId);
    if (!got) throw new Error('刚建的记录读不到');
    // 飞书 search 接口把文本字段返成富文本数组 [{text,type}],对调用者应归一化成纯字符串
    if (got.fields['文本'] !== '第一条') {
      throw new Error(`文本字段应归一化为纯字符串,实际 ${JSON.stringify(got.fields['文本'])}`);
    }
    if (got.fields['数量'] !== 42) {
      throw new Error(`数字字段应为 42(number),实际 ${JSON.stringify(got.fields['数量'])}`);
    }
    return `${records.length} 条,文本/数字均正确`;
  });

  await run('P8.11', 'bitable·改记录', async () => {
    const B = await import('./feishu-bitable.mjs');
    await B.updateRecord(baseToken, tableId, recId, { 数量: 99 });
    const { records } = await B.listRecords(baseToken, tableId);
    const got = records.find(r => r.record_id === recId);
    if (got.fields['数量'] !== 99) throw new Error(`改后应为 99,实际 ${JSON.stringify(got.fields['数量'])}`);
    return '数量 42→99';
  });

  await run('P8.12', 'bitable·批量新增记录', async () => {
    const B = await import('./feishu-bitable.mjs');
    const r = await B.addRecords(baseToken, tableId, [
      { 文本: '批量A', 数量: 1 },
      { 文本: '批量B', 数量: 2 },
    ]);
    if (r.record_ids?.length !== 2) throw new Error(`应返回 2 个 record_id,实际 ${JSON.stringify(r)}`);
    return `新增 ${r.record_ids.length} 条`;
  });

  await run('P8.13', 'bitable·CSV 写记录(表头映射字段名)', async () => {
    const B = await import('./feishu-bitable.mjs');
    const csv = join(tmpdir(), `kala-p8-${TS}.csv`);
    writeFileSync(csv, '文本,数量\nCSV一,7\nCSV二,8\n', 'utf8');
    try {
      const r = await B.addRecordsFromCsv(baseToken, tableId, csv);
      if (r.record_ids?.length !== 2) throw new Error(`应写入 2 条,实际 ${JSON.stringify(r)}`);
      const { records } = await B.listRecords(baseToken, tableId);
      const one = records.find(x => x.fields['文本'] === 'CSV一');
      if (!one) throw new Error('找不到 CSV 写入的记录');
      if (one.fields['数量'] !== 7) throw new Error(`CSV 数字应转 number,实际 ${JSON.stringify(one.fields['数量'])}`);
      return '2 条,数字已转 number';
    } finally {
      try { unlinkSync(csv); } catch { /* 临时文件 */ }
    }
  });

  await run('P8.14', 'bitable·批量删记录', async () => {
    const B = await import('./feishu-bitable.mjs');
    const ids = (await B.listRecords(baseToken, tableId)).records.map(r => r.record_id);
    await B.deleteRecords(baseToken, tableId, ids);
    const after = (await B.listRecords(baseToken, tableId)).records;
    if (after.length) throw new Error(`应全删完,仍剩 ${after.length} 条`);
    return `删除 ${ids.length} 条`;
  });

  // ── P9 CLI 层:输出契约 + 破坏性操作门槛 ──────────────────────
  await run('P9.1', 'CLI·sheets read 输出可解析 JSON', async () => {
    const { code, stdout, stderr } = runCli('feishu-sheets.mjs', ['read', ssToken, `${sheetId}!A1:C2`]);
    if (code !== 0) throw new Error(`退出码 ${code}: ${stderr.slice(0, 160)}`);
    const j = JSON.parse(stdout);
    if (!Array.isArray(j.values)) throw new Error(`应输出含 values 数组的 JSON,实际 ${stdout.slice(0, 120)}`);
    return `${j.values.length} 行`;
  });

  await run('P9.2', 'CLI·write 覆盖前打印原值', async () => {
    const S = await import('./feishu-sheets.mjs');
    const s = await S.addSheet(ssToken, '覆盖预览');
    await S.writeRange(ssToken, `${s.sheet_id}!A1:A1`, [['旧值']]);
    const csv = join(tmpdir(), `kala-p9-${TS}.csv`);
    writeFileSync(csv, '新值\n', 'utf8');
    try {
      const { code, stdout, stderr } = runCli('feishu-sheets.mjs', ['write', ssToken, `${s.sheet_id}!A1:A1`, csv]);
      if (code !== 0) throw new Error(`退出码 ${code}: ${stderr.slice(0, 160)}`);
      // 覆盖是不可逆的,输出里必须能看到被覆盖掉的是什么
      if (!stdout.includes('旧值')) throw new Error(`输出里应包含被覆盖的原值「旧值」,实际: ${stdout.slice(0, 200)}`);
      const got = await S.readRange(ssToken, `${s.sheet_id}!A1:A1`);
      if (got.values[0][0] !== '新值') throw new Error(`写入未生效: ${JSON.stringify(got.values)}`);
      return '原值已提示,新值已写入';
    } finally {
      try { unlinkSync(csv); } catch { /* 临时文件 */ }
    }
  });

  await run('P9.3', 'CLI·sheets 删除类缺 --yes 拒绝执行', async () => {
    const S = await import('./feishu-sheets.mjs');
    const s = await S.addSheet(ssToken, '待删验证');
    const no = runCli('feishu-sheets.mjs', ['delsheet', ssToken, s.sheet_id]);
    if (no.code === 0) throw new Error('缺 --yes 竟然执行成功了');
    if (!/--yes/.test(no.stderr + no.stdout)) throw new Error(`报错应提示需要 --yes,实际: ${(no.stderr || no.stdout).slice(0, 160)}`);
    if (!(await S.listSheets(ssToken)).some(x => x.sheet_id === s.sheet_id)) throw new Error('拒绝执行却把工作表删了');
    const yes = runCli('feishu-sheets.mjs', ['delsheet', ssToken, s.sheet_id, '--yes']);
    if (yes.code !== 0) throw new Error(`带 --yes 应成功,实际 code=${yes.code} ${yes.stderr.slice(0, 160)}`);
    if ((await S.listSheets(ssToken)).some(x => x.sheet_id === s.sheet_id)) throw new Error('带 --yes 后仍未删除');
    return '无 --yes 拒绝、有 --yes 执行';
  });

  await run('P9.4', 'CLI·bitable 删除类缺 --yes 拒绝执行', async () => {
    const B = await import('./feishu-bitable.mjs');
    const t = await B.addTable(baseToken, '待删表');
    const no = runCli('feishu-bitable.mjs', ['deltable', baseToken, t.table_id]);
    if (no.code === 0) throw new Error('缺 --yes 竟然执行成功了');
    if (!/--yes/.test(no.stderr + no.stdout)) throw new Error(`报错应提示需要 --yes,实际: ${(no.stderr || no.stdout).slice(0, 160)}`);
    if (!(await B.listTables(baseToken)).some(x => x.table_id === t.table_id)) throw new Error('拒绝执行却把数据表删了');
    const yes = runCli('feishu-bitable.mjs', ['deltable', baseToken, t.table_id, '--yes']);
    if (yes.code !== 0) throw new Error(`带 --yes 应成功,实际 code=${yes.code} ${yes.stderr.slice(0, 160)}`);
    if ((await B.listTables(baseToken)).some(x => x.table_id === t.table_id)) throw new Error('带 --yes 后仍未删除');
    return '无 --yes 拒绝、有 --yes 执行';
  });

  await run('P9.5', 'CLI·未知命令给用法提示', async () => {
    for (const script of ['feishu-sheets.mjs', 'feishu-bitable.mjs']) {
      const { code, stdout, stderr } = runCli(script, ['没这个命令']);
      if (code === 0) throw new Error(`${script} 未知命令竟返回 0`);
      if (!/用法/.test(stdout + stderr)) throw new Error(`${script} 应打印用法,实际: ${(stdout + stderr).slice(0, 160)}`);
    }
    return '两个脚本都给用法且退出码非 0';
  });

  // ── P10 体积保护 / 自动分批 / URL 解析 ────────────────────────
  let bigSheetId;
  await run('P10.1', 'read 默认只返回 200 行并报总数', async () => {
    const S = await import('./feishu-sheets.mjs');
    const s = await S.addSheet(ssToken, '大表');
    bigSheetId = s.sheet_id;
    await S.writeRange(ssToken, `${bigSheetId}!A1:A250`, Array.from({ length: 250 }, (_, i) => [`行${i + 1}`]));
    const { code, stdout, stderr } = runCli('feishu-sheets.mjs', ['read', ssToken, `${bigSheetId}!A1:A250`]);
    if (code !== 0) throw new Error(`退出码 ${code}: ${stderr.slice(0, 160)}`);
    const j = JSON.parse(stdout);
    if (j.values.length !== 200) throw new Error(`默认应返回 200 行,实际 ${j.values.length}`);
    if (j.has_more !== true) throw new Error('超出上限应标 has_more=true');
    if (j.total !== 250) throw new Error(`total 应为 250,实际 ${j.total}`);
    if (j.values[0][0] !== '行1' || j.values[199][0] !== '行200') {
      throw new Error(`应返回第 1-200 行,实际首尾 ${j.values[0][0]}/${j.values[199][0]}`);
    }
    return '200/250,has_more=true';
  });

  await run('P10.2', 'read --offset 续读不重不漏', async () => {
    const { code, stdout, stderr } = runCli('feishu-sheets.mjs', ['read', ssToken, `${bigSheetId}!A1:A250`, '--offset', '200']);
    if (code !== 0) throw new Error(`退出码 ${code}: ${stderr.slice(0, 160)}`);
    const j = JSON.parse(stdout);
    if (j.values.length !== 50) throw new Error(`应返回剩余 50 行,实际 ${j.values.length}`);
    if (j.values[0][0] !== '行201') throw new Error(`续读首行应为 行201,实际 ${j.values[0][0]}`);
    if (j.values[49][0] !== '行250') throw new Error(`续读末行应为 行250,实际 ${j.values[49][0]}`);
    if (j.has_more) throw new Error('已读完不该再标 has_more');
    return '201-250,has_more=false';
  });

  await run('P10.3', 'read --out 导出全量到文件且不占 stdout', async () => {
    const out = join(tmpdir(), `kala-p10-${TS}.csv`);
    try {
      const { code, stdout, stderr } = runCli('feishu-sheets.mjs', ['read', ssToken, `${bigSheetId}!A1:A250`, '--out', out]);
      if (code !== 0) throw new Error(`退出码 ${code}: ${stderr.slice(0, 160)}`);
      if (!existsSync(out)) throw new Error('没生成导出文件');
      const lines = readFileSync(out, 'utf8').trim().split('\n');
      if (lines.length !== 250) throw new Error(`导出应有 250 行,实际 ${lines.length}`);
      if (lines[249].trim() !== '行250') throw new Error(`末行应为 行250,实际 ${lines[249]}`);
      const j = JSON.parse(stdout);
      if (j.values) throw new Error('--out 模式不该把数据打进 stdout(那样还是会占 context)');
      if (j.rows !== 250) throw new Error(`stdout 应报告 rows=250,实际 ${JSON.stringify(j)}`);
      return '250 行落盘,stdout 只报摘要';
    } finally {
      try { unlinkSync(out); } catch { /* 临时文件 */ }
    }
  });

  await run('P10.4', 'bitable 写入/删除超 500 条自动分批', async () => {
    const B = await import('./feishu-bitable.mjs');
    const list = Array.from({ length: 600 }, (_, i) => ({ 文本: `批量${i + 1}`, 数量: i + 1 }));
    const r = await B.addRecords(baseToken, tableId, list);
    if (r.record_ids?.length !== 600) throw new Error(`应建 600 条,实际 ${r.record_ids?.length}`);
    if (r.batches !== 2) throw new Error(`600 条应分 2 批(飞书单批上限 500),实际 batches=${r.batches}`);
    const del = await B.deleteRecords(baseToken, tableId, r.record_ids);
    if (del.deleted !== 600) throw new Error(`应删 600 条,实际 ${del.deleted}`);
    if (del.batches !== 2) throw new Error(`删除也应分 2 批,实际 batches=${del.batches}`);
    return '600 条分 2 批写入 + 2 批删除';
  });

  await run('P10.5', '传飞书 URL 而非 token 也能读', async () => {
    const S = await import('./feishu-sheets.mjs');
    const info = await S.createSpreadsheet(`kala 自检-P10-url-${TS}`, containerToken);
    cleanup.push({ kind: 'file', token: info.spreadsheet_token, type: 'sheet', desc: 'P10 URL 表格' });
    if (!info.url) throw new Error('建表未返回 url,无法测 URL 解析');
    const sheets = await S.listSheets(info.spreadsheet_token);
    await S.writeRange(info.spreadsheet_token, `${sheets[0].sheet_id}!A1:A1`, [['URL可读']]);
    // 第二个参数只给 sheet_id(不带 !区间)= 读整张,顺便验证这个便利写法
    const { code, stdout, stderr } = runCli('feishu-sheets.mjs', ['read', info.url, sheets[0].sheet_id]);
    if (code !== 0) throw new Error(`用 URL 读失败,退出码 ${code}: ${stderr.slice(0, 160)}`);
    const j = JSON.parse(stdout);
    if (j.values?.[0]?.[0] !== 'URL可读') throw new Error(`URL 读出的内容不对: ${JSON.stringify(j.values?.slice(0, 2))}`);
    return 'URL→token 解析 + 省略区间读整张';
  });

  await run('P10.6', 'bitable records 默认限量 + 游标续读', async () => {
    const B = await import('./feishu-bitable.mjs');
    const made = await B.addRecords(baseToken, tableId, Array.from({ length: 250 }, (_, i) => ({ 文本: `记录${i + 1}` })));
    const first = runCli('feishu-bitable.mjs', ['records', baseToken, tableId]);
    if (first.code !== 0) throw new Error(`退出码 ${first.code}: ${first.stderr.slice(0, 160)}`);
    const j1 = JSON.parse(first.stdout);
    if (j1.records.length !== 200) throw new Error(`默认应返回 200 条,实际 ${j1.records.length}`);
    if (j1.has_more !== true) throw new Error('应标 has_more=true');
    if (!j1.next_page_token) throw new Error('应给出 next_page_token 供续读');
    const second = runCli('feishu-bitable.mjs', ['records', baseToken, tableId, '--page-token', j1.next_page_token]);
    if (second.code !== 0) throw new Error(`续读退出码 ${second.code}: ${second.stderr.slice(0, 160)}`);
    const j2 = JSON.parse(second.stdout);
    if (j2.records.length !== 50) throw new Error(`续读应返回剩余 50 条,实际 ${j2.records.length}`);
    const ids = new Set([...j1.records, ...j2.records].map(r => r.record_id));
    if (ids.size !== 250) throw new Error(`两页合起来应是 250 条不重复记录,实际 ${ids.size}`);
    await B.deleteRecords(baseToken, tableId, made.record_ids);
    return '200 + 50,无重复';
  });

  await run('P10.7', 'bitable records --out 导出 + 传 URL 可用', async () => {
    const B = await import('./feishu-bitable.mjs');
    const info = await B.createBase(`kala 自检-P10-base-url-${TS}`, containerToken);
    cleanup.push({ kind: 'file', token: info.app_token, type: 'bitable', desc: 'P10 URL 多维表格' });
    if (!info.url) throw new Error('建多维表格未返回 url,无法测 URL 解析');
    const t = (await B.listTables(info.app_token))[0];
    await B.addRecords(info.app_token, t.table_id, [{ 文本: 'URL可读A' }, { 文本: 'URL可读B' }]);
    const out = join(tmpdir(), `kala-p10-base-${TS}.csv`);
    try {
      // 用 URL 而不是 app_token
      const r = runCli('feishu-bitable.mjs', ['records', info.url, t.table_id, '--out', out]);
      if (r.code !== 0) throw new Error(`用 URL 读失败,退出码 ${r.code}: ${r.stderr.slice(0, 160)}`);
      const j = JSON.parse(r.stdout);
      if (j.records) throw new Error('--out 模式不该把记录打进 stdout');
      if (!existsSync(out)) throw new Error('没生成导出文件');
      const text = readFileSync(out, 'utf8');
      if (!text.includes('URL可读A') || !text.includes('URL可读B')) {
        throw new Error(`导出内容不含记录: ${text.slice(0, 200)}`);
      }
      return 'URL→app_token 解析 + CSV 落盘';
    } finally {
      try { unlinkSync(out); } catch { /* 临时文件 */ }
    }
  });

  await run('P10.8', '写类命令也接受 URL(不只 read)', async () => {
    const S = await import('./feishu-sheets.mjs');
    const B = await import('./feishu-bitable.mjs');
    const ss = await S.createSpreadsheet(`kala 自检-P10-w-${TS}`, containerToken);
    cleanup.push({ kind: 'file', token: ss.spreadsheet_token, type: 'sheet', desc: 'P10 写类URL表格' });
    const sh = (await S.listSheets(ss.spreadsheet_token))[0];
    const csv = join(tmpdir(), `kala-p108-${TS}.csv`);
    writeFileSync(csv, 'URL写入\n', 'utf8');
    try {
      const w = runCli('feishu-sheets.mjs', ['write', ss.url, `${sh.sheet_id}!A1:A1`, csv]);
      if (w.code !== 0) throw new Error(`sheets write 用 URL 失败: ${w.stderr.slice(0, 160)}`);
      const got = await S.readRange(ss.spreadsheet_token, `${sh.sheet_id}!A1:A1`);
      if (got.values[0][0] !== 'URL写入') throw new Error(`写入未生效: ${JSON.stringify(got.values)}`);

      const bb = await B.createBase(`kala 自检-P10-w-base-${TS}`, containerToken);
      cleanup.push({ kind: 'file', token: bb.app_token, type: 'bitable', desc: 'P10 写类URL多维表格' });
      const t = (await B.listTables(bb.app_token))[0];
      const a = runCli('feishu-bitable.mjs', ['addrec', bb.url, t.table_id, JSON.stringify({ 文本: 'URL新增' })]);
      if (a.code !== 0) throw new Error(`bitable addrec 用 URL 失败: ${a.stderr.slice(0, 160)}`);
      const recs = (await B.listRecords(bb.app_token, t.table_id)).records;
      if (!recs.some(r => r.fields['文本'] === 'URL新增')) throw new Error('记录未写入');
      return 'sheets write / bitable addrec 都接受 URL';
    } finally {
      try { unlinkSync(csv); } catch { /* 临时文件 */ }
    }
  });

  // ── P11 网络瞬时失败的重试策略 ────────────────────────────────
  // 真实网络抖动没法稳定触发,这里 mock 掉 globalThis.fetch 来造,跑完还原。
  await run('P11.1', '幂等请求遇网络错自动重试后成功', async () => {
    const { api } = await import('./feishu-api.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...a) => {
      calls++;
      if (calls <= 2) throw new TypeError('fetch failed');
      return real(...a);
    };
    try {
      const d = await api('GET', '/drive/explorer/v2/root_folder/meta');
      if (!d?.token) throw new Error('重试后应拿到正常结果');
      if (calls !== 3) throw new Error(`应重试到第 3 次才成功,实际调用 ${calls} 次`);
      return `前 2 次失败,第 ${calls} 次成功`;
    } finally { globalThis.fetch = real; }
  });

  await run('P11.2', '非幂等请求不自动重试,且提示可能已生效', async () => {
    const { api } = await import('./feishu-api.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
    let msg = '';
    try {
      await api('POST', '/bitable/v1/apps', { body: { name: '__never_created__' } });
      throw new Error('网络全失败时应当抛错');
    } catch (e) {
      msg = e.message;
    } finally { globalThis.fetch = real; }
    if (calls !== 1) throw new Error(`非幂等请求不该重试(会重复写入),实际调用 ${calls} 次`);
    if (!/可能已生效/.test(msg)) throw new Error(`错误信息必须提示「可能已生效」,实际: ${msg}`);
    if (!/核对/.test(msg)) throw new Error(`错误信息必须提示先核对再重试,实际: ${msg}`);
    return '只调 1 次,且提示先核对';
  });

  await run('P11.3', '飞书业务错误码不重试(重试也没用)', async () => {
    const { api } = await import('./feishu-api.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...a) => { calls++; return real(...a); };
    try {
      await api('GET', '/docx/v1/documents/doxcnInvalidTokenForRetryTest');
      throw new Error('无效文档应当报错');
    } catch (e) {
      if (!/Feishu \d+:/.test(e.message)) throw new Error(`应是飞书业务错误,实际: ${e.message}`);
    } finally { globalThis.fetch = real; }
    if (calls !== 1) throw new Error(`业务错误不该重试,实际调用 ${calls} 次`);
    return '只调 1 次';
  });

  await run('P11.4', '重试耗尽后报错要说明重试过几次', async () => {
    const { api } = await import('./feishu-api.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new TypeError('fetch failed'); };
    let msg = '';
    try {
      await api('GET', '/drive/explorer/v2/root_folder/meta');
      throw new Error('全失败时应当抛错');
    } catch (e) { msg = e.message; } finally { globalThis.fetch = real; }
    if (calls !== 3) throw new Error(`幂等请求应共尝试 3 次(1 次 + 重试 2 次),实际 ${calls} 次`);
    if (!/重试/.test(msg)) throw new Error(`错误信息应说明重试过,实际: ${msg}`);
    return `尝试 ${calls} 次后如实报错`;
  });

  await run('P11.5', '「稍后重试」类业务码要自动重试(画板未就绪)', async () => {
    const { api } = await import('./feishu-api.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...a) => {
      calls++;
      // 前两次冒充飞书的「画板还没初始化好」,第三次放行
      if (calls <= 2) {
        return new Response(JSON.stringify({ code: 2890007, msg: 'This whiteboard is not ready yet. Please try again later.' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(...a);
    };
    try {
      const d = await api('GET', '/drive/explorer/v2/root_folder/meta');
      if (!d?.token) throw new Error('重试后应拿到正常结果');
      if (calls !== 3) throw new Error(`应重试到第 3 次,实际调用 ${calls} 次`);
      return `2890007 被重试,第 ${calls} 次成功`;
    } finally { globalThis.fetch = real; }
  });

  await run('P11.6', '「稍后重试」类业务码对非幂等请求也要重试', async () => {
    const { api } = await import('./feishu-api.mjs');
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...a) => {
      calls++;
      if (calls <= 2) {
        return new Response(JSON.stringify({ code: 2890007, msg: 'not ready yet' }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(...a);
    };
    let err = null, created = null;
    try {
      // POST 默认不幂等,但 2890007 表示「压根没执行」,重发不会写两份 —— 必须重试
      const d = await api('POST', '/docx/v1/documents', { body: { title: `__retry_probe__${TS}` } });
      created = d.document?.document_id;
    } catch (e) { err = e; }
    finally { globalThis.fetch = real; }
    // 第 3 次是真请求,真建出来了就删掉,别留垃圾
    if (created) {
      try { await api('DELETE', `/drive/v1/files/${created}`, { query: { type: 'docx' } }); }
      catch { console.error(`     (提示:探测文档未删掉 ${created})`); }
    }
    if (calls !== 3) throw new Error(`非幂等请求遇 2890007 也应重试到第 3 次,实际 ${calls} 次`);
    if (err) throw new Error(`第 3 次真实请求失败: ${err.message.slice(0, 120)}`);
    return `非幂等请求也重试,共 ${calls} 次`;
  });

  // ── P12 画板(board)──────────────────────────────────────────
  let wbToken;
  await run('P12.1', 'board·在文档里插入画板块', async () => {
    const B = await import('./feishu-board.mjs');
    const r = await B.insertBoard(docToken);
    wbToken = r.whiteboard_token;
    if (!wbToken) throw new Error(`未返回 whiteboard_token: ${JSON.stringify(r)}`);
    if (r.block_type !== 43) throw new Error(`画板块的 block_type 应为 43,实际 ${r.block_type}`);
    return `${wbToken}(block ${r.block_id})`;
  });

  await run('P12.2', 'board·批量创建节点(形状+文字)', async () => {
    const B = await import('./feishu-board.mjs');
    const r = await B.addNodes(wbToken, [
      { type: 'composite_shape', x: 0, y: 0, width: 300, height: 160,
        composite_shape: { type: 'round_rect' },
        style: { fill_color: '#eaf3ff', border_color: '#d0d7de' } },
      { type: 'text_shape', x: 24, y: 20, width: 250, height: 40,
        text: { text: '自检标题', font_size: 20, font_weight: 'bold' } },
      { type: 'text_shape', x: 24, y: 70, width: 250, height: 60,
        text: { text: '自检正文', font_size: 14 } },
    ]);
    if (r.created !== 3) throw new Error(`应创建 3 个节点,实际 ${JSON.stringify(r)}`);
    return `${r.created} 个节点`;
  });

  await run('P12.3', 'board·读回节点并校验文字', async () => {
    const B = await import('./feishu-board.mjs');
    const { nodes } = await B.listNodes(wbToken);
    if (nodes.length !== 3) throw new Error(`应读回 3 个节点,实际 ${nodes.length}`);
    const texts = nodes.map(n => n.text?.text).filter(Boolean);
    for (const want of ['自检标题', '自检正文']) {
      if (!texts.includes(want)) throw new Error(`读回的文字里缺「${want}」: ${JSON.stringify(texts)}`);
    }
    const shape = nodes.find(n => n.type === 'composite_shape');
    if (shape?.style?.fill_color?.toLowerCase() !== '#eaf3ff') {
      throw new Error(`填充色应为 #eaf3ff,实际 ${shape?.style?.fill_color}`);
    }
    return '3 个节点,文字与填充色都对得上';
  });

  await run('P12.4', 'board·颜色名要在本地被拦住(不能甩飞书的笼统报错)', async () => {
    const B = await import('./feishu-board.mjs');
    let msg = '';
    try {
      await B.addNodes(wbToken, [{ type: 'composite_shape', x: 400, y: 0, width: 100, height: 50,
        composite_shape: { type: 'round_rect' }, style: { fill_color: 'blue' } }]);
      throw new Error('颜色名 blue 竟然被放过了');
    } catch (e) { msg = e.message; }
    // 飞书只会回一句笼统的 field validation failed,脚本必须在本地就说清是哪个字段错、要什么格式
    if (/field validation failed/i.test(msg)) throw new Error(`不该把飞书的笼统报错直接抛出: ${msg}`);
    if (!/fill_color/.test(msg)) throw new Error(`报错要点明是 fill_color: ${msg}`);
    if (!/#/.test(msg)) throw new Error(`报错要说明需要 #RRGGBB 格式: ${msg}`);
    return '本地拦下并给出可读报错';
  });

  await run('P12.5', 'board·不支持的形状要在本地被拦住', async () => {
    const B = await import('./feishu-board.mjs');
    let msg = '';
    try {
      await B.addNodes(wbToken, [{ type: 'composite_shape', x: 400, y: 100, width: 100, height: 50,
        composite_shape: { type: 'arrow' } }]);
      throw new Error('arrow 竟然被放过了(实测飞书不支持)');
    } catch (e) { msg = e.message; }
    if (/field validation failed/i.test(msg)) throw new Error(`不该甩飞书的笼统报错: ${msg}`);
    if (!/arrow/.test(msg)) throw new Error(`报错要点明是 arrow: ${msg}`);
    return '本地拦下';
  });

  await run('P12.6', 'board·导出为图片(写到文件)', async () => {
    const B = await import('./feishu-board.mjs');
    const out = join(tmpdir(), `kala-board-${TS}.jpg`);
    try {
      const r = await B.exportImage(wbToken, out);
      if (!existsSync(out)) throw new Error('没生成图片文件');
      const size = readFileSync(out).length;
      if (size < 1000) throw new Error(`图片过小,可能不是有效图片: ${size} 字节`);
      if (r.bytes !== size) throw new Error(`返回的 bytes(${r.bytes})与实际文件大小(${size})不一致`);
      return `${size} 字节`;
    } finally {
      try { unlinkSync(out); } catch { /* 临时文件 */ }
    }
  });

  await run('P12.7', 'board·CLI 契约(insert/nodes/shapes/未知命令)', async () => {
    const ins = runCli('feishu-board.mjs', ['insert', docToken]);
    if (ins.code !== 0) throw new Error(`insert 退出码 ${ins.code}: ${ins.stderr.slice(0, 160)}`);
    const j = JSON.parse(ins.stdout);
    if (!j.whiteboard_token) throw new Error(`insert 未返回 whiteboard_token: ${ins.stdout.slice(0, 160)}`);

    const nodes = runCli('feishu-board.mjs', ['nodes', j.whiteboard_token]);
    if (nodes.code !== 0) throw new Error(`nodes 退出码 ${nodes.code}: ${nodes.stderr.slice(0, 160)}`);
    if (typeof JSON.parse(nodes.stdout).count !== 'number') throw new Error('nodes 应返回 count');

    const sh = JSON.parse(runCli('feishu-board.mjs', ['shapes']).stdout);
    if (!sh.usable?.includes('round_rect')) throw new Error(`shapes 输出异常: ${JSON.stringify(sh)}`);

    const bad = runCli('feishu-board.mjs', ['没这个命令']);
    if (bad.code === 0) throw new Error('未知命令竟返回 0');
    if (!/用法/.test(bad.stdout + bad.stderr)) throw new Error('未知命令应打印用法');
    return 'insert/nodes/shapes/未知命令 都符合契约';
  });

  // ── P5 token / 错误码 ────────────────────────────────────────
  await run('P5.1', 'token·强制刷新', async () => {
    const { execFileSync } = await import('child_process');
    const { fileURLToPath } = await import('url');
    const oauth = fileURLToPath(new URL('./feishu-oauth.mjs', import.meta.url));
    const out = execFileSync(process.execPath, [oauth, 'refresh'], { encoding: 'utf8', env: process.env });
    if (!/刷新成功/.test(out)) throw new Error('refresh 未报告成功');
    resetUserToken(); // refresh 后旧 access_token 失效,清缓存,后续(含清理)用新 token
    return 'refresh OK';
  });

  await run('P5.2', '错误码映射', async () => {
    try {
      await api('GET', `/docx/v1/documents/${docToken}`, { token: 'invalid_token_for_test' });
    } catch (e) {
      if (/Feishu \d+:/.test(e.message)) return `捕获: ${e.message.split('[')[0].trim()}`;
      throw new Error(`错误信息格式不符: ${e.message}`);
    }
    throw new Error('用无效 token 竟未报错');
  });
}

// 跑同目录下某个脚本的 CLI,拿到退出码 + stdout + stderr(不抛异常,便于断言失败路径)。
function runCli(script, args) {
  const p = fileURLToPath(new URL(`./${script}`, import.meta.url));
  try {
    const stdout = execFileSync(process.execPath, [p, ...args], { encoding: 'utf8', env: process.env });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// run: 执行一个用例,PASS/FAIL/SKIP 记账。required=false 时失败记 SKIP。
// --only 过滤掉的用例直接返回 null,不记账、不打印。
async function run(id, name, fn, { required = true } = {}) {
  if (!wanted(id)) return null;
  try {
    const detail = await fn();
    log('PASS', id, name, typeof detail === 'string' ? detail : undefined);
    return true;
  } catch (e) {
    log(required ? 'FAIL' : 'SKIP', id, name, e.message);
    return false;
  }
}

async function doCleanup() {
  console.log('\n── 清理 ──');
  for (const item of cleanup.reverse()) {
    try {
      await api('DELETE', `/drive/v1/files/${item.token}`, { query: { type: item.type } });
      console.log(`  🧹 删除 ${item.desc} (${item.token})`);
    } catch (e) {
      console.log(`  ⚠️  清理失败 ${item.desc} (${item.token}): ${e.message} —— 请手动到回收站/云盘检查`);
    }
  }
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  log('FAIL', '--', '未捕获异常', e.message);
  exitCode = 1;
} finally {
  await doCleanup();
}

// 汇总
const pass = results.filter(r => r.status === 'PASS').length;
const failResults = results.filter(r => r.status === 'FAIL');
const skip = results.filter(r => r.status === 'SKIP').length;
console.log(`\n── 汇总 ──  PASS ${pass}  FAIL ${failResults.length}  SKIP ${skip}`);
if (failResults.length) {
  console.log('FAIL 项:');
  for (const f of failResults) console.log(`  - ${f.id} ${f.name}: ${f.detail}`);
  exitCode = 1;
}
console.log(exitCode === 0 ? '\n✅ 自检通过(必需项全绿)' : '\n❌ 自检未通过');
process.exit(exitCode);
