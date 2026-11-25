// Background assignment for signed-in Antigravity accounts. A thread keeps
// the account that can still resume its session. New work, and any account
// that just returned a quota or rate-limit error, is spread across the
// remaining signed-in accounts. The Google logins stay in their own profile
// directories; this module only chooses an instance id.
import { statSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { classifyError } from "./drivers/retry.ts";
import { antigravityProfileDirectory } from "./drivers/antigravity-acp.ts";

export const ANTIGRAVITY_QUOTA_COOLDOWN_MS = 15 * 60 * 1000;

export interface AntigravityPoolAccount {
  instanceId: string;
  authenticated: boolean;
  changing?: boolean;
}

export interface AntigravityPoolMemory {
  cooldownUntil: ReadonlyMap<string, number>;
  lastAssignedAt: ReadonlyMap<string, number>;
}

const cooldownUntil = new Map<string, number>();
const lastAssignedAt = new Map<string, number>();
const replySwitchTried = new Map<string, Set<string>>();
const replyNotices = new Map<string, string>();

export function resetAntigravityPoolForTests(): void {
  cooldownUntil.clear();
  lastAssignedAt.clear();
  replySwitchTried.clear();
  replyNotices.clear();
}

export function noteAntigravityQuota(instanceId: string, now = Date.now(), cooldownMs = ANTIGRAVITY_QUOTA_COOLDOWN_MS): void {
  cooldownUntil.set(instanceId, now + cooldownMs);
}

/** Antigravity prints its quota wall as a normal assistant reply, then ends
 * the turn. That text is not an answer and must move the thread to another
 * signed-in account. Keep the match short so a real reply that merely
 * mentions quota does not switch. */
export function antigravityReplyNeedsAccountSwitch(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 800) return false;
  return /usage limit reached|you have reached your current quota|verify your account to continue/i.test(trimmed);
}

/** Cooldown is the reset time printed in the quota message, for example
 * "Your limit will reset in 4 hours, 57 minutes." A message with no
 * duration does not invent one. */
export function antigravityUsageLimitCooldownMs(text: string): number | null {
  const match = /reset in\s+(?:(\d+)\s+hours?\b)?(?:(?:,|\s+and)\s+)?(?:(\d+)\s+minutes?\b)?/i.exec(text);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  if (!hours && !minutes) return null;
  return (hours * 60 + minutes) * 60 * 1000;
}

/** A quota failure cools the account until the message's reset time. With
 * no reset time, the short cooldown only stops an immediate retry. */
export function noteAntigravityQuotaFromText(instanceId: string, text: string, now = Date.now()): void {
  noteAntigravityQuota(instanceId, now, antigravityUsageLimitCooldownMs(text) ?? ANTIGRAVITY_QUOTA_COOLDOWN_MS);
}

export function rememberAntigravityReplyNotice(threadId: string, text: string): void {
  replyNotices.set(threadId, text.trim().slice(0, 800));
}

export function antigravityReplyNotice(threadId: string): string | undefined {
  return replyNotices.get(threadId);
}

export function noteAntigravityReplySwitch(threadId: string, instanceId: string, text: string, now = Date.now()): void {
  const tried = replySwitchTried.get(threadId) ?? new Set<string>();
  tried.add(instanceId);
  replySwitchTried.set(threadId, tried);
  // "Verify your account" is a Google check on that one request, not a
  // quota window. Holding the account for hours leaves the other account's
  // usage-limit banner with nowhere to go after the check is finished.
  if (/verify your account to continue/i.test(text)) return;
  noteAntigravityQuotaFromText(instanceId, text, now);
}

export function antigravityReplySwitchExclude(threadId: string): ReadonlySet<string> {
  return replySwitchTried.get(threadId) ?? new Set<string>();
}

export function clearAntigravityReplySwitch(threadId: string): void {
  replySwitchTried.delete(threadId);
  replyNotices.delete(threadId);
}

/** Quota and rate-limit failures are the signal to leave this Google
 * account alone for a while. Auth failures are included so a signed-out
 * profile is not retried on every turn. */
export function antigravityAccountBlocked(error: unknown): boolean {
  const failure = error instanceof Error ? error : new Error(String(error));
  const classified = classifyError(failure);
  if (classified.reason === "quota" || classified.reason === "rate_limited" || classified.reason === "auth") return true;
  return /resource.?exhausted|usage limit|quota exceeded|out of (?:extra )?quota/i.test(failure.message);
}

export function antigravityAccountLoggedIn(instanceId: string, baseDir = DATA_DIR): boolean {
  try {
    const info = statSync(join(antigravityProfileDirectory(instanceId, baseDir), "antigravity-acp", "acp_token.json"));
    return info.isFile() && info.size > 0 && info.size <= 1024 * 1024;
  } catch {
    return false;
  }
}

export function pickAntigravityAccount(input: {
  accounts: readonly AntigravityPoolAccount[];
  preferredId?: string;
  /** Present when this thread can still resume on `preferredId`. */
  preferredCanResume?: boolean;
  exclude?: ReadonlySet<string>;
  now: number;
  memory?: AntigravityPoolMemory;
}): { instanceId: string; reason: "sticky" | "spread" } | null {
  const memory = input.memory ?? { cooldownUntil, lastAssignedAt };
  const exclude = input.exclude ?? new Set<string>();
  const healthy = input.accounts.filter((account) =>
    account.authenticated &&
    !account.changing &&
    !exclude.has(account.instanceId) &&
    (memory.cooldownUntil.get(account.instanceId) ?? 0) <= input.now);
  if (healthy.length === 0) return null;
  if (
    input.preferredCanResume &&
    input.preferredId &&
    healthy.some((account) => account.instanceId === input.preferredId)
  ) {
    return { instanceId: input.preferredId, reason: "sticky" };
  }
  const ranked = [...healthy].sort((left, right) => {
    const used = (memory.lastAssignedAt.get(left.instanceId) ?? 0) - (memory.lastAssignedAt.get(right.instanceId) ?? 0);
    return used || left.instanceId.localeCompare(right.instanceId);
  });
  return { instanceId: ranked[0]!.instanceId, reason: "spread" };
}

export function noteAntigravityAssignment(instanceId: string, now = Date.now()): void {
  lastAssignedAt.set(instanceId, now);
}

export function assignAntigravityAccount(input: Omit<Parameters<typeof pickAntigravityAccount>[0], "memory" | "now"> & { now?: number }): { instanceId: string; reason: "sticky" | "spread" } | null {
  const now = input.now ?? Date.now();
  const picked = pickAntigravityAccount({ ...input, now });
  if (picked) noteAntigravityAssignment(picked.instanceId, now);
  return picked;
}

/** A pooled sibling is still the same engine. Keep the bot's model when that
 * id exists on the account that actually runs the turn. */
export function antigravitySiblingKeepsModel(input: {
  routedKind: string | undefined;
  selectedKind: string | undefined;
  model: string;
  optionIds: readonly string[];
  fallback: string;
}): boolean {
  return input.routedKind === "antigravityAgent"
    && input.selectedKind === "antigravityAgent"
    && (input.optionIds.includes(input.model) || input.fallback === input.model);
}
