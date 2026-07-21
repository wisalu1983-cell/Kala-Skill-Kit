/**
 * write-md-to-feishu.mjs —— 把 Markdown 文件写入飞书文档的 CLI 薄封装。
 *
 * 目标可以是:
 *   - docx 文档 token 或链接 (https://xxx.feishu.cn/docx/XXXX)
 *   - 知识库节点链接 (https://xxx.feishu.cn/wiki/XXXX) 或裸 node_token(加 --wiki)
 *     → 自动解析成底层 obj_token 再写入(填掉「wiki token 直接喂写入器会失败」的坑)
 *
 * 用法:
 *   node write-md-to-feishu.mjs <doc_token|url> <markdown_file> [--append] [--wiki]
 *     --append  追加到文末(默认为全量重写正文)
 *     --wiki    强制把目标当作知识库 node_token 解析(URL 含 /wiki/ 时会自动识别,无需此参)
 */
import { readFileSync } from 'fs';
import { FeishuDocWriter } from './feishu-doc-writer.mjs';
import { getNode } from './feishu-wiki.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a.slice(2));
    else positional.push(a);
  }
  return { positional, flags };
}

function extractTarget(input) {
  const docm = input.match(/\/docx\/([A-Za-z0-9]+)/);
  if (docm) return { token: docm[1], isWiki: false };
  const wikim = input.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikim) return { token: wikim[1], isWiki: true };
  return { token: input.split(/[?#]/)[0].trim(), isWiki: false };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [target, mdFile] = positional;
  if (!target || !mdFile) {
    console.error('用法: node write-md-to-feishu.mjs <doc_token|url> <markdown_file> [--append] [--wiki]');
    process.exit(1);
  }

  const markdown = readFileSync(mdFile, 'utf-8');
  let { token: docToken, isWiki } = extractTarget(target);
  if (flags.has('wiki')) isWiki = true;

  if (isWiki) {
    const node = await getNode(docToken);
    if (!node?.obj_token) throw new Error(`知识库节点解析失败,拿不到 obj_token: ${docToken}`);
    console.log(`知识库节点 ${docToken} → obj_token ${node.obj_token} (${node.obj_type})`);
    docToken = node.obj_token;
  }

  const w = new FeishuDocWriter();
  await w.init();
  const mode = flags.has('append') ? 'append' : 'write';
  console.log(`${mode === 'append' ? '追加到' : '写入'}文档: ${docToken}`);
  const result = mode === 'append' ? await w.append(docToken, markdown) : await w.write(docToken, markdown);
  console.log('完成:', JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
