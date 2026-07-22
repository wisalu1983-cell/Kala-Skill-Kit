/**
 * feishu-comment.mjs —— 飞书云文档评论(开放 API 能做的子集)。
 *
 * ⚠️ 飞书开放 API 只支持**全文评论**(整篇文档挂一条评论):
 *    - 建评论 / 列评论 / 取单条 / 标记已解决 —— 支持。
 *    - **局部评论(锚定到某段文字)建不了**:传 is_whole:false + quote 会被强制转成全文评论、quote 丢弃。
 *      锚定文字的批注只能在飞书界面手动做;本 API 只能「读到」界面里建的局部评论。
 *    - **回复评论不支持**:API 对全文评论回复返回 1069302(不允许回复)。
 *
 * 目标可用 docx token/链接,或知识库 wiki 链接(自动解析成底层 docx obj)。多账号自动按租户选账号。
 *
 * 用法:
 *   node feishu-comment.mjs create  <doc_url|token> <评论文本>   # 建全文评论
 *   node feishu-comment.mjs list    <doc_url|token>              # 列出评论(全文+界面建的局部都能读)
 *   node feishu-comment.mjs get     <doc_url|token> <comment_id> # 取单条评论
 *   node feishu-comment.mjs resolve <doc_url|token> <comment_id> # 标记为已解决
 *     可加 --wiki 强制把目标当知识库 node_token 解析(URL 含 /wiki/ 时自动识别)
 */
import { api, printResult, fail } from './feishu-api.mjs';
import { getNode } from './feishu-wiki.mjs';
import { autoSelectAccount } from './feishu-route.mjs';

const el = (t) => ({ type: 'text_run', text_run: { text: t } });

function extract(input) {
  const docm = input.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docm) return { token: docm[1], isWiki: false };
  const wikim = input.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikim) return { token: wikim[1], isWiki: true };
  return { token: input.split(/[?#]/)[0].trim(), isWiki: false };
}

// 解析目标 → { fileToken(docx obj), fileType },并按租户自动选账号
async function resolveTarget(input, wikiFlag) {
  let { token, isWiki } = extract(input);
  if (wikiFlag) isWiki = true;
  await autoSelectAccount({ url: input, wikiToken: isWiki ? token : undefined, docToken: isWiki ? undefined : token });
  if (isWiki) {
    const node = await getNode(token);
    if (!node?.obj_token) throw new Error(`知识库节点解析失败: ${token}`);
    return { fileToken: node.obj_token, fileType: node.obj_type || 'docx' };
  }
  return { fileToken: token, fileType: 'docx' };
}

function parseArgs(argv) {
  const positional = [], flags = new Set();
  for (const a of argv) (a.startsWith('--') ? flags.add(a.slice(2)) : positional.push(a));
  return { positional, flags };
}

async function main() {
  const [cmd, ...restRaw] = process.argv.slice(2);
  const { positional, flags } = parseArgs(restRaw);
  const wikiFlag = flags.has('wiki');

  switch (cmd) {
    case 'create': {
      const [target, ...rest] = positional;
      const text = rest.join(' ');
      if (!target || !text) return fail('用法: create <doc_url|token> <评论文本>');
      const { fileToken, fileType } = await resolveTarget(target, wikiFlag);
      const r = await api('POST', `/drive/v1/files/${fileToken}/comments`, {
        query: { file_type: fileType },
        body: { is_whole: true, reply_list: { replies: [ { content: { elements: [ el(text) ] } } ] } },
      });
      return printResult({ comment_id: r.comment_id, file_token: fileToken, file_type: fileType });
    }
    case 'list': {
      const [target] = positional;
      if (!target) return fail('用法: list <doc_url|token>');
      const { fileToken, fileType } = await resolveTarget(target, wikiFlag);
      const d = await api('GET', `/drive/v1/files/${fileToken}/comments`, { query: { file_type: fileType, page_size: '50' } });
      return printResult({
        comments: (d.items || []).map(c => ({
          comment_id: c.comment_id, is_whole: c.is_whole, is_solved: c.is_solved, quote: c.quote,
          replies: (c.reply_list?.replies || []).map(r => (r.content?.elements || []).map(e => e.text_run?.text || '').join('')),
        })),
        has_more: d.has_more,
      });
    }
    case 'get': {
      const [target, cid] = positional;
      if (!target || !cid) return fail('用法: get <doc_url|token> <comment_id>');
      const { fileToken, fileType } = await resolveTarget(target, wikiFlag);
      const g = await api('GET', `/drive/v1/files/${fileToken}/comments/${cid}`, { query: { file_type: fileType } });
      return printResult(g);
    }
    case 'resolve': {
      const [target, cid] = positional;
      if (!target || !cid) return fail('用法: resolve <doc_url|token> <comment_id>');
      const { fileToken, fileType } = await resolveTarget(target, wikiFlag);
      const r = await api('PATCH', `/drive/v1/files/${fileToken}/comments/${cid}`, { query: { file_type: fileType }, body: { is_solved: true } });
      return printResult({ resolved: cid, result: r ?? 'ok' });
    }
    default:
      console.log('用法: node feishu-comment.mjs <create|list|get|resolve> <doc_url|token> ...');
      console.log('注:开放 API 只能建「全文评论」;局部评论(锚定文字)建不了,回复不支持。');
      process.exit(1);
  }
}

main().catch(fail);
