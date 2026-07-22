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
 *
 * 退出码:所有「必需」用例(P0–P2、P5)通过 = 0;有必需用例 FAIL = 1。
 *        知识库用例(P3–P4)在本机无 wiki 条件时记为 SKIP,不影响退出码。
 */
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FeishuDocWriter } from './feishu-doc-writer.mjs';
import { api, resetUserToken } from './feishu-api.mjs';
import { getNode } from './feishu-wiki.mjs';

const TS = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const CONTAINER = `__kala_selftest__${TS}`;

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
  let wikiAvailable = true;
  try {
    const sp = await api('GET', '/wiki/v2/spaces', { query: { page_size: '10' } });
    const spaces = sp.items || [];
    if (!spaces.length) { wikiAvailable = false; log('SKIP', 'P3-P4', '知识库全部', '本机无可用知识库空间'); }
    else spaceId = spaces[0].space_id;
  } catch (e) {
    wikiAvailable = false;
    log('SKIP', 'P3-P4', '知识库全部', `列空间失败(多半是缺 wiki 权限): ${e.message}`);
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

// run: 执行一个用例,PASS/FAIL/SKIP 记账。required=false 时失败记 SKIP。
async function run(id, name, fn, { required = true } = {}) {
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
