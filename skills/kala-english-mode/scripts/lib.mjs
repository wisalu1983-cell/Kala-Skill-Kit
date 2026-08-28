// kala-english-mode 的共享逻辑：会话态/个人偏好读写、中文检测、开关识别。
// 被 hook.mjs 和 wire-hooks.mjs 共用；Claude Code 与 Codex 也共用同一份实现。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

export const STATE_DIR = join(tmpdir(), 'kala-english-mode');
export const PREF_DIR = join(homedir(), '.kala', 'english-mode');
export const PREF_FILE = join(PREF_DIR, 'config.json');

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalizeTier(tier) {
  return tier === 'challenge' ? 'challenge' : 'basic';
}

// 个人偏好：是否新 session 默认开启，默认档位。不进 git，只在这台机器生效。
export function readPreferences() {
  try {
    const data = JSON.parse(readFileSync(PREF_FILE, 'utf8'));
    return {
      defaultEnabled: Boolean(data.defaultEnabled),
      defaultTier: normalizeTier(data.defaultTier),
    };
  } catch {
    return { defaultEnabled: false, defaultTier: 'basic' };
  }
}

export function writePreferences(prefs) {
  ensureDir(PREF_DIR);
  const payload = {
    defaultEnabled: Boolean(prefs.defaultEnabled),
    defaultTier: normalizeTier(prefs.defaultTier),
  };
  writeFileSync(PREF_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

function stateFile(sessionId) {
  return join(STATE_DIR, `${sessionId}.json`);
}

// 会话态：本会话是否开启、当前档位。存在系统临时目录下，会话结束后自然过期。
export function readState(sessionId) {
  try {
    const data = JSON.parse(readFileSync(stateFile(sessionId), 'utf8'));
    return { enabled: Boolean(data.enabled), tier: normalizeTier(data.tier) };
  } catch {
    return null;
  }
}

export function writeState(sessionId, state) {
  ensureDir(STATE_DIR);
  const payload = { enabled: Boolean(state.enabled), tier: normalizeTier(state.tier) };
  writeFileSync(stateFile(sessionId), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

// 读会话态；第一次见到这个 session 时按本机个人偏好初始化。
export function getOrInitState(sessionId) {
  const existing = readState(sessionId);
  if (existing) return existing;
  const prefs = readPreferences();
  return writeState(sessionId, { enabled: prefs.defaultEnabled, tier: prefs.defaultTier });
}

// --- 中文自然语言检测 ---

const HAN_RE = /[一-鿿]/;

// 剥离代码块（```...```）、行内代码（`...`）和引用块（以 > 开头的行），只留自然语言部分再判断。
// 引用块要排除是因为客户端"引用回复"会把助手上一条消息（可能含中文）整段带回来，
// 那不是用户这次自己打的话，不该触发中文反馈判断。
export function stripCodeAndQuotes(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

export function hasChineseNaturalLanguage(promptText) {
  if (!promptText) return false;
  return HAN_RE.test(stripCodeAndQuotes(promptText));
}

// --- 开关 / 切档识别（覆盖 SKILL.md 里列出的触发短语，宽松匹配） ---

const OFF_PATTERNS = [/关闭英语学习模式/, /english mode off/i];
const ON_PATTERNS = [
  /打开英语学习模式/,
  /开启英语学习模式/,
  /english mode on/i,
  /练英语/,
  /进入英语练习模式/,
];
const CHALLENGE_PATTERNS = [/第二部分也用英语/, /switch to full english/i, /用全英文回答/];
const BASIC_PATTERNS = [/第二部分换回中文/, /换回中文/];

// 返回 null（无匹配，state 不变）或 { enabled?, tier? }（部分字段，与现有 state 合并）。
export function detectToggle(promptText) {
  if (!promptText) return null;
  if (OFF_PATTERNS.some((re) => re.test(promptText))) return { enabled: false };
  if (ON_PATTERNS.some((re) => re.test(promptText))) {
    return { enabled: true, tier: CHALLENGE_PATTERNS.some((re) => re.test(promptText)) ? 'challenge' : 'basic' };
  }
  if (CHALLENGE_PATTERNS.some((re) => re.test(promptText))) return { tier: 'challenge' };
  if (BASIC_PATTERNS.some((re) => re.test(promptText))) return { tier: 'basic' };
  return null;
}

export function buildReminder(state, promptText) {
  const isChallenge = state.tier === 'challenge';
  const answerContract = isChallenge
    ? '【回答】区块必须全部用英语写，不夹杂中文，不需要单独摘要。'
    : '【回答】区块必须先写 1-2 句自然英语概括本条回答要点（不要求带"TL;DR"这种字面标签，只要是英文句子即可），空一行，再写完整的中文回答——不能跳过这句英文摘要、直接进中文。';
  const lines = [
    `[kala-english-mode 机械提醒] 模式：开启，档位：${isChallenge ? '挑战档' : '基础档'}。`,
    '本条回复必须严格分两段输出：先【English Coach】区块给英语表达反馈，再【回答】区块正常作答。',
    answerContract,
  ];
  if (hasChineseNaturalLanguage(promptText)) {
    lines.push(
      '本条输入检测到中文自然语言片段（代码块/行内代码除外）：【English Coach】必须按"用户用了中文"处理并给出反馈，不能因为其余部分是英文或代码就跳过。'
    );
  }
  return lines.join('\n');
}
