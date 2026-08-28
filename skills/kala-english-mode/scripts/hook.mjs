#!/usr/bin/env node
// kala-english-mode 的 hook 入口——Claude Code 和 Codex 共用同一份实现。
// 由宿主工具在 UserPromptSubmit / SessionStart 时以子进程方式调用，JSON 从 stdin 输入，
// JSON 从 stdout 输出（两端都用 { hookSpecificOutput: { hookEventName, additionalContext } } 这个形状）。
import { getOrInitState, writeState, detectToggle, buildReminder } from './lib.mjs';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function emit(hookEventName, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // 输入不是合法 JSON：按文档约定，不阻塞、不注入，静默退出
  }

  const eventName = input.hook_event_name;
  const sessionId = input.session_id;
  if (!sessionId) return;

  if (eventName === 'UserPromptSubmit') {
    const promptText = typeof input.prompt === 'string' ? input.prompt : '';
    let state = getOrInitState(sessionId);
    const toggle = detectToggle(promptText);
    if (toggle) state = writeState(sessionId, { ...state, ...toggle });
    if (state.enabled) emit('UserPromptSubmit', buildReminder(state, promptText));
    return;
  }

  if (eventName === 'SessionStart') {
    // 只在“压缩之后重开”这个时刻补一次提醒；其余启动原因交给下一次 UserPromptSubmit 自然处理。
    const reason = input.startup_reason || input.source;
    if (reason !== 'compact') return;
    const state = getOrInitState(sessionId);
    if (state.enabled) emit('SessionStart', buildReminder(state, ''));
  }
}

main().catch(() => {
  // hook 失败不应该让宿主工具的这一轮卡住——吞掉异常，退出码 0。
});
