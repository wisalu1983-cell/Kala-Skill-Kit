/**
 * write-md-to-feishu.mjs —— 把 Markdown 文件写入飞书文档的 CLI 薄封装。
 *
 * 目标可以是:
 *   - docx 文档 token 或链接 (https://xxx.feishu.cn/docx/XXXX)
 *   - 知识库节点链接 (https://xxx.feishu.cn/wiki/XXXX) 或裸 node_token(加 --wiki)
 *     → 自动解析成底层 obj_token 再写入(填掉「wiki token 直接喂写入器会失败」的坑)
 *
 * 用法:
 *   node write-md-to-feishu.mjs <doc_token|url> <markdown_file> [--patch|--append] [--wiki]
 *     (默认)      全量重写正文:清空 + 按 Markdown 重建
 *     --patch      增量更新:只改变了的那几块(小改首选;先看计划再执行)
 *     --append     追加到文末
 *     --wiki       强制把目标当作知识库 node_token 解析(URL 含 /wiki/ 时会自动识别,无需此参)
 *
 *   --patch 专用:
 *     --dry-run      只打印改动计划,不动文档
 *     --yes          计划里有删除/替换时必须带,否则只打印计划并退出 1
 *     --force-images 图片一律重传(默认同位置的图片视为未变,因为 URL 和 file_token 无从比对)
 *     --keep-foreign 画板/电子表格这类 Markdown 生成不出来的块原地保留,不进删除清单
 */
import { readFileSync } from 'fs';
import { FeishuDocWriter } from './feishu-doc-writer.mjs';
import { patchDoc, applyPatch, describePlan } from './feishu-doc-patch.mjs';
import { getNode } from './feishu-wiki.mjs';
import { autoSelectAccount } from './feishu-route.mjs';

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
    console.error('用法: node write-md-to-feishu.mjs <doc_token|url> <markdown_file> [--patch|--append] [--wiki]');
    console.error('      --patch 增量更新(可加 --dry-run / --yes / --force-images / --keep-foreign)');
    process.exit(1);
  }
  if (flags.has('patch') && flags.has('append')) {
    console.error('--patch 和 --append 只能二选一');
    process.exit(1);
  }

  const markdown = readFileSync(mdFile, 'utf-8');
  let { token: docToken, isWiki } = extractTarget(target);
  if (flags.has('wiki')) isWiki = true;

  // 多账号时按目标 URL 的租户自动选对账号(显式 KALA_FEISHU_ACCOUNT 优先)
  await autoSelectAccount({ url: target, wikiToken: isWiki ? docToken : undefined, docToken: isWiki ? undefined : docToken });

  if (isWiki) {
    const node = await getNode(docToken);
    if (!node?.obj_token) throw new Error(`知识库节点解析失败,拿不到 obj_token: ${docToken}`);
    console.log(`知识库节点 ${docToken} → obj_token ${node.obj_token} (${node.obj_type})`);
    docToken = node.obj_token;
  }

  const w = new FeishuDocWriter();
  await w.init();

  if (flags.has('patch')) {
    console.log(`增量更新文档: ${docToken}`);
    const dryRun = flags.has('dry-run');
    const r = await patchDoc(w, docToken, markdown, {
      dryRun: true,
      forceImages: flags.has('force-images'),
      keepForeign: flags.has('keep-foreign'),
    });
    if (r.tooLarge) {
      console.error(`文档 ${r.oldCount} 块 × 新内容 ${r.newCount} 块,差异计算不划算。请去掉 --patch 走全量重写。`);
      process.exit(1);
    }
    console.log(describePlan(r.plan));
    if (dryRun) {
      console.log('(--dry-run:未改动文档)');
      return;
    }
    if (r.plan.stats.update + r.plan.stats.replace + r.plan.stats.insert + r.plan.stats.delete === 0) {
      console.log('内容一致,无需改动。');
      return;
    }
    if (r.plan.destructive && !flags.has('yes')) {
      console.error('⚠️  计划里有删除/替换 —— 不可逆。核对上面的清单后,重跑本命令并加 --yes 才会执行。');
      process.exit(1);
    }
    // 执行的就是上面打印的那份计划,不重新读一遍文档,免得中间被人改过对不上
    const done = await applyPatch(w, docToken, r.plan, { onLog: (line) => console.log('  ' + line) });
    console.log('完成:', JSON.stringify(done, null, 2));
    return;
  }

  const mode = flags.has('append') ? 'append' : 'write';
  console.log(`${mode === 'append' ? '追加到' : '写入'}文档: ${docToken}`);
  const result = mode === 'append' ? await w.append(docToken, markdown) : await w.write(docToken, markdown);
  console.log('完成:', JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
