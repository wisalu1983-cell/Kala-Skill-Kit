/**
 * feishu-cli.mjs —— 表格类脚本的 CLI 公共件:参数解析 + 破坏性操作闸门。
 *
 * 单独一个模块的理由同 feishu-csv.mjs:feishu-sheets 和 feishu-bitable 是平级能力,
 * 不该其中一个 import 另一个。
 */

/** 带值的 flag(其余 flag 视为布尔),这样 `--out a.csv` 不会把 a.csv 误当位置参数。 */
const VALUE_FLAGS = new Set(['out', 'limit', 'offset', 'start', 'page-token']);

export function parseArgv(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
    else flags[key] = true;
  }
  return { flags, pos };
}

/**
 * 破坏性操作的闸门:没带 --yes 就打印「要删什么 + 当前内容预览」到 stderr 后退出 1。
 * 预览走 stderr,把 stdout 留给结构化结果,方便调用方直接 JSON.parse。
 *
 * 这是 SKILL.md 那条铁律的代码化:任何删除前先把待删对象列清单给用户、取得确认再执行。
 */
export async function confirmDestructive(flags, desc, previewFn) {
  if (flags.yes) return;
  console.error(`⚠️  即将${desc} —— 不可逆操作。`);
  if (previewFn) {
    try {
      console.error('当前内容预览:');
      console.error(JSON.stringify(await previewFn(), null, 2));
    } catch (e) {
      console.error(`(预览取不到: ${e.message})`);
    }
  }
  console.error('核对无误后,重跑本命令并加 --yes 才会执行。');
  process.exit(1);
}
