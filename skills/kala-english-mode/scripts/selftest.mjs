#!/usr/bin/env node
// kala-english-mode 的离线自检——纯本地逻辑，不依赖网络/真实 Claude Code / Codex。
// 覆盖 lib.mjs 的纯函数和 hook.mjs 的 stdin/stdout 契约。跑法：node scripts/selftest.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, 'hook.mjs');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

function runHook(payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  try {
    const out = execFileSync('node', [HOOK], { input, encoding: 'utf8', timeout: 10_000 });
    return out.trim();
  } catch (err) {
    return { error: err.message };
  }
}

// 每个测试用独立临时目录隔离状态/偏好，不污染这台机器的真实运行期文件。
const scratch = mkdtempSync(join(tmpdir(), 'kala-english-mode-selftest-'));
process.env.HOME = scratch; // homedir() 读这个；tmpdir() 走系统真实临时目录，session id 天然隔离不冲突

const { detectToggle, hasChineseNaturalLanguage, buildReminder, getOrInitState, writePreferences } = await import(
  './lib.mjs'
);

// ---- 开关 / 切档识别 ----
check('开关识别·打开', JSON.stringify(detectToggle('打开英语学习模式')) === JSON.stringify({ enabled: true, tier: 'basic' }));
check('开关识别·关闭', JSON.stringify(detectToggle('关闭英语学习模式')) === JSON.stringify({ enabled: false }));
check(
  '开关识别·打开+切挑战档一步到位',
  JSON.stringify(detectToggle('打开英语学习模式,用全英文回答')) === JSON.stringify({ enabled: true, tier: 'challenge' })
);
check('开关识别·无匹配返回 null', detectToggle('随便聊聊') === null);
check('开关识别·空输入返回 null', detectToggle('') === null);

// ---- 中文自然语言检测 ----
check('中文检测·纯中文', hasChineseNaturalLanguage('帮我看看这个函数') === true);
check('中文检测·纯英文', hasChineseNaturalLanguage('help me fix this bug') === false);
check('中文检测·中英混杂', hasChineseNaturalLanguage('I want to 提交 this PR') === true);
check('中文检测·代码块内中文被排除', hasChineseNaturalLanguage('```\n// 这是注释\nconsole.log(1)\n```') === false);
check('中文检测·行内代码中文被排除', hasChineseNaturalLanguage('跑一下 `打印中文的函数()` 就行') === true); // 代码外仍有中文
check('中文检测·纯行内代码中文被排除', hasChineseNaturalLanguage('`中文变量名`') === false);
check(
  '中文检测·引用块(以 > 开头的行)中文被排除',
  hasChineseNaturalLanguage('> 【回答】\n> TL;DR (EN): something\n\nis this correct?') === false
);
check(
  '中文检测·引用块之外仍有中文时照常检测',
  hasChineseNaturalLanguage('> 【回答】\n\n这句是我自己打的中文') === true
);

// ---- buildReminder：基础档/挑战档的完整输出契约必须写进提醒里，不能只说"两段式" ----
const basicReminder = buildReminder({ enabled: true, tier: 'basic' }, 'hello');
const challengeReminder = buildReminder({ enabled: true, tier: 'challenge' }, 'hello');
check(
  '机械提醒·基础档要求英文摘要在前、中文在后',
  /英文摘要/.test(basicReminder) && /空一行/.test(basicReminder) && /中文/.test(basicReminder),
  `实际内容:${JSON.stringify(basicReminder)}`
);
check(
  '机械提醒·基础档明确说不强制字面标签(避免和示例样式冲突)',
  /不要求/.test(basicReminder) && /标签/.test(basicReminder),
  `实际内容:${JSON.stringify(basicReminder)}`
);
check(
  '机械提醒·挑战档要求全英文',
  /全部用英语|全英语|全英文/.test(challengeReminder),
  `实际内容:${JSON.stringify(challengeReminder)}`
);
check('机械提醒·挑战档不应出现"英文摘要"这类基础档专属措辞', !/英文摘要/.test(challengeReminder));

// ---- 个人偏好默认值 ----
writePreferences({ defaultEnabled: true, defaultTier: 'challenge' });
const freshState = getOrInitState(`selftest-fresh-${Date.now()}-${Math.random()}`);
check(
  '个人偏好·新 session 按偏好初始化',
  freshState.enabled === true && freshState.tier === 'challenge',
  JSON.stringify(freshState)
);

// ---- hook.mjs：stdin/stdout 契约 ----
check('hook·非法 JSON 不崩溃且无输出', runHook('not json') === '');
check('hook·缺 session_id 无输出', runHook({ hook_event_name: 'UserPromptSubmit', prompt: '你好' }) === '');

// hook.mjs 子进程读 homedir() 走的是自己的 process.env.HOME，这里显式给它建好个人偏好文件。
{
  const dir = join(process.env.HOME, '.kala', 'english-mode');
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaultEnabled: true, defaultTier: 'basic' }) + '\n');
}

{
  const sid = `selftest-hook-userprompt-${Date.now()}`;
  const out = runHook({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: '这个 bug 我 fix 了' });
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {}
  check(
    'hook·UserPromptSubmit 输出 hookSpecificOutput.additionalContext 结构',
    parsed?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit' && typeof parsed?.hookSpecificOutput?.additionalContext === 'string',
    out
  );
  check('hook·中英混杂输入触发中文检测提示', /中文自然语言片段/.test(parsed?.hookSpecificOutput?.additionalContext || ''));
}

{
  const sid = `selftest-hook-sessionstart-compact-${Date.now()}`;
  // 先用一条 UserPromptSubmit 把这个 session 初始化成 enabled
  runHook({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  const out = runHook({ session_id: sid, hook_event_name: 'SessionStart', startup_reason: 'compact' });
  let parsed = null;
  try {
    parsed = JSON.parse(out);
  } catch {}
  check(
    'hook·SessionStart(compact)补发提醒',
    parsed?.hookSpecificOutput?.hookEventName === 'SessionStart',
    out
  );
}

{
  const sid = `selftest-hook-sessionstart-startup-${Date.now()}`;
  const out = runHook({ session_id: sid, hook_event_name: 'SessionStart', startup_reason: 'startup' });
  check('hook·SessionStart(startup)不补发提醒', out === '');
}

// ---- wire-hooks.mjs：hook 身份识别必须按固定后缀匹配、原地替换旧路径，不能因为绝对路径
// 不同就当成两条不同的 hook 而重复追加（这正是本机曾经复现过的真实 bug）。----
{
  const WIRE = join(__dirname, 'wire-hooks.mjs');
  const claudeHookInstalled = join(scratch, '.claude', 'skills', 'kala-english-mode', 'scripts', 'hook.mjs');
  const codexHookInstalled = join(scratch, '.agents', 'skills', 'kala-english-mode', 'scripts', 'hook.mjs');
  execFileSync('mkdir', ['-p', dirname(claudeHookInstalled), dirname(codexHookInstalled)]);
  writeFileSync(claudeHookInstalled, '// fake installed hook.mjs for selftest\n');
  writeFileSync(codexHookInstalled, '// fake installed hook.mjs for selftest\n');

  // 预置一条指向"仓库路径"（跟已安装路径不同的绝对路径）的旧条目，模拟本机曾经复现过的场景。
  const claudeSettingsPath = join(scratch, '.claude', 'settings.json');
  writeFileSync(
    claudeSettingsPath,
    JSON.stringify(
      {
        model: 'opus',
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: 'node "/some/other/repo/path/kala-english-mode/scripts/hook.mjs"' }] },
          ],
        },
      },
      null,
      2
    )
  );

  execFileSync('node', [WIRE, '--yes'], { env: { ...process.env, HOME: scratch }, encoding: 'utf8' });

  const after = JSON.parse(execFileSync('cat', [claudeSettingsPath], { encoding: 'utf8' }));
  const entries = after.hooks?.UserPromptSubmit || [];
  check('wire-hooks·同一 skill 的旧条目原地替换，不重复追加', entries.length === 1, `实际条目数:${entries.length}`);
  check(
    'wire-hooks·替换后的 command 指向已安装路径而不是旧路径',
    entries[0]?.hooks?.[0]?.command?.includes(claudeHookInstalled),
    entries[0]?.hooks?.[0]?.command
  );
  check('wire-hooks·config 里原有的其它字段(model)保持不变', after.model === 'opus');

  // 再跑一次，应保持幂等：条目数不变、command 不变。
  execFileSync('node', [WIRE, '--yes'], { env: { ...process.env, HOME: scratch }, encoding: 'utf8' });
  const afterTwice = JSON.parse(execFileSync('cat', [claudeSettingsPath], { encoding: 'utf8' }));
  check(
    'wire-hooks·重跑幂等，不会再产生第二条',
    (afterTwice.hooks?.UserPromptSubmit || []).length === 1
  );
}

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
