// Sticky Antigravity ACP sessions. The installed 0.1.84 bundle grew this in
// dist-server/index.js; this module is the same policy in source so a local
// build can compile it. The running service keeps reading the installed
// bundle until that build is deliberately installed.
//
// One ACP session is resumed until the last prompt is near Antigravity's
// checkpoint (~100k tokens), the thread has been idle 20 minutes, the
// session already died with "could not find doneCh for checkpoint", or the
// user asks for a new one (/new, /break, /session). A forced new session
// replays only the latest 20 turns. When that checkpoint error is the
// reply, the host reruns the same turn on a fresh session; a second death
// in that retry is shown instead of looping.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const ANTIGRAVITY_TOKEN_CAP = 100_000;
export const ANTIGRAVITY_NEW_AT = 90_000;
export const ANTIGRAVITY_ACTIVE_MS = 5 * 60 * 1000;
export const ANTIGRAVITY_IDLE_MS = 20 * 60 * 1000;
export const ANTIGRAVITY_RECOVERY_TURNS = 20;
export const ANTIGRAVITY_CHECKPOINT_ERROR = "could not find doneCh for checkpoint";

/** Live harness state. Tests must set OMB_ANTIGRAVITY_STATE_PATH; vitest
 * without that variable keeps the map in memory and never opens this file. */
export const ANTIGRAVITY_LIVE_STATE_PATH = join(homedir(), ".openmausbot", "antigravity-sessions.json");

const OBSERVED_SAVE_EVERY = 8_000;
const RECOVERY_MARKER = "\n[Now reply to the user's latest message:]";

export interface AntigravityAffinity {
  telegram?: boolean;
  botReply?: boolean;
  gapMs?: number | null;
  inputTokens?: number;
  forceNew?: boolean;
}

interface SessionRow {
  inputTokens?: number;
  chars?: number;
  poisoned?: boolean;
  at?: number;
  savedChars?: number;
}

const sessions = new Map<string, SessionRow>();
const telegramThreads = new Set<string>();
let loadedPath: string | undefined;

export function antigravitySessionTracking(): boolean {
  if (process.env.VITEST && !process.env.OMB_ANTIGRAVITY_STATE_PATH) return false;
  return true;
}

function statePath(): string {
  const override = process.env.OMB_ANTIGRAVITY_STATE_PATH;
  if (override) {
    const path = isAbsolute(override) ? override : resolve(override);
    if (process.env.VITEST && path === ANTIGRAVITY_LIVE_STATE_PATH) {
      throw new Error("tests must not use the live Antigravity session file");
    }
    return path;
  }
  if (process.env.VITEST) return join(tmpdir(), "omb-antigravity-vitest-unused.json");
  return ANTIGRAVITY_LIVE_STATE_PATH;
}

function loadState(): void {
  if (!antigravitySessionTracking()) return;
  const path = statePath();
  if (loadedPath === path) return;
  sessions.clear();
  loadedPath = path;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!data || typeof data !== "object") return;
    for (const [id, row] of Object.entries(data)) {
      if (row && typeof row === "object") sessions.set(id, row as SessionRow);
    }
  } catch {
    // a missing file is a fresh map
  }
}

function saveState(): void {
  const path = statePath();
  writeFileSync(path, JSON.stringify(Object.fromEntries(sessions)));
}

/** Drop the in-memory map so the next call re-reads the state file. */
export function antigravityCloseStateForTests(): void {
  sessions.clear();
  loadedPath = undefined;
  telegramThreads.clear();
}

export function noteTelegramThread(threadId: string): void {
  telegramThreads.add(threadId);
}

export function isTelegramThread(threadId: string): boolean {
  return telegramThreads.has(threadId);
}

export function antigravityAffinityForDispatch(input: {
  threadId: string;
  userText: string;
  messages: Array<{ id: string; at?: number }>;
  userMessageId: string;
  userMessageAt: number;
  commsDepth: number;
  peerAsk: boolean;
  fromBot: boolean;
  coordination: boolean;
  cardContinuation: boolean;
  contextTokens: number;
  lastTurnInput: number;
}): AntigravityAffinity {
  const prev = [...input.messages].reverse().find((message) => message.id !== input.userMessageId && typeof message.at === "number");
  return {
    telegram: isTelegramThread(input.threadId),
    botReply: input.commsDepth > 0 || input.peerAsk || input.fromBot || input.coordination || input.cardContinuation,
    gapMs: prev && typeof prev.at === "number" ? input.userMessageAt - prev.at : null,
    inputTokens: Math.max(Number(input.contextTokens) || 0, Number(input.lastTurnInput) || 0),
    forceNew: /^\/(new|break|session)\b/i.test(input.userText.trim()),
  };
}

function estimate(row: SessionRow | undefined): number {
  const reported = Number(row?.inputTokens) || 0;
  const observed = Math.trunc((Number(row?.chars) || 0) / 4);
  return Math.max(reported, observed);
}

export function antigravityResumeDecision(turn: {
  threadId: string;
  antigravityAffinity?: AntigravityAffinity;
}): { resume: boolean; reason: string } {
  if (!antigravitySessionTracking()) return { resume: true, reason: "tracking off" };
  loadState();
  const hint = turn.antigravityAffinity ?? {};
  const live = sessions.get(turn.threadId);
  const input = Math.max(Number(hint.inputTokens) || 0, estimate(live));
  const gapMs = typeof hint.gapMs === "number" ? hint.gapMs : null;
  const telegram = hint.telegram === true || isTelegramThread(turn.threadId);
  const botReply = hint.botReply === true;
  const active = gapMs !== null && gapMs >= 0 && gapMs < ANTIGRAVITY_ACTIVE_MS;
  if (hint.forceNew === true) return { resume: false, reason: "command" };
  if (live?.poisoned) return { resume: false, reason: "checkpoint" };
  if (input >= ANTIGRAVITY_NEW_AT) {
    return { resume: false, reason: `context ${input} >= ${ANTIGRAVITY_NEW_AT} (stay under ${ANTIGRAVITY_TOKEN_CAP})` };
  }
  if (gapMs !== null && gapMs >= ANTIGRAVITY_IDLE_MS) {
    return { resume: false, reason: `idle ${Math.round(gapMs / 60_000)}min` };
  }
  if (telegram) return { resume: true, reason: "telegram" };
  if (botReply) return { resume: true, reason: "bot-reply" };
  if (active) return { resume: true, reason: `active ${Math.round(gapMs / 1000)}s` };
  return { resume: true, reason: input ? `under cap (${input})` : "no measurement yet" };
}

export function antigravityNoteUsage(threadId: string, inputTokens: unknown): void {
  if (!antigravitySessionTracking()) return;
  loadState();
  const input = Number(inputTokens);
  if (!Number.isFinite(input) || input < 0) return;
  if (input === 0) {
    sessions.set(threadId, { inputTokens: 0, chars: 0, poisoned: false, at: Date.now(), savedChars: 0 });
    saveState();
    return;
  }
  const prev = sessions.get(threadId) ?? {};
  sessions.set(threadId, { ...prev, inputTokens: Math.trunc(input), at: Date.now() });
  saveState();
}

export function antigravityNoteObserved(threadId: string, chars: number): void {
  const extra = Number(chars);
  if (!Number.isFinite(extra) || extra <= 0) return;
  if (!antigravitySessionTracking()) return;
  loadState();
  const prev = sessions.get(threadId) ?? { inputTokens: 0, chars: 0, poisoned: false, savedChars: 0 };
  const nextChars = (Number(prev.chars) || 0) + Math.trunc(extra);
  const next: SessionRow = { ...prev, chars: nextChars, at: Date.now() };
  sessions.set(threadId, next);
  if (nextChars - (Number(prev.savedChars) || 0) >= OBSERVED_SAVE_EVERY) {
    next.savedChars = nextChars;
    saveState();
  }
}

export function antigravityNotePoison(threadId: string): void {
  if (!antigravitySessionTracking()) return;
  loadState();
  const prev = sessions.get(threadId) ?? { inputTokens: 0, chars: 0 };
  sessions.set(threadId, { ...prev, poisoned: true, at: Date.now() });
  saveState();
  console.error(`[antigravity-session] thread=${threadId} poisoned checkpoint`);
}

export function antigravityNoteAssistantText(threadId: string, delta: string, accumulated: string): void {
  antigravityNoteObserved(threadId, delta.length);
  if (delta.includes(ANTIGRAVITY_CHECKPOINT_ERROR) || accumulated.includes(ANTIGRAVITY_CHECKPOINT_ERROR)) {
    antigravityNotePoison(threadId);
  }
}

export function antigravityRecentRecovery(text: string, limit = ANTIGRAVITY_RECOVERY_TURNS): string {
  const at = text.lastIndexOf(RECOVERY_MARKER);
  if (at < 0) return text;
  const parts = text.slice(0, at).split(/\n(?=(?:User|Assistant): )/u);
  if (parts.length <= 1) return text;
  const kept = parts.slice(1).slice(-limit);
  return `${parts[0]}\n${kept.join("\n")}${text.slice(at)}`;
}

export function antigravityPromptText(
  turn: { text: string; system?: string; recoveryText?: string },
  ctx?: { resumed?: boolean; replay?: boolean },
): string {
  if (ctx?.resumed) return turn.text;
  const body = ctx?.replay && turn.recoveryText
    ? antigravityRecentRecovery(turn.recoveryText, ANTIGRAVITY_RECOVERY_TURNS)
    : turn.text;
  return turn.system ? `${turn.system}\n\n${body}` : body;
}
