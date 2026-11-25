import { describe, expect, it } from "vitest";

import {
  antigravityAccountBlocked,
  antigravityReplyNeedsAccountSwitch,
  antigravityReplySwitchExclude,
  antigravitySiblingKeepsModel,
  ANTIGRAVITY_QUOTA_COOLDOWN_MS,
  antigravityUsageLimitCooldownMs,
  clearAntigravityReplySwitch,
  noteAntigravityQuota,
  noteAntigravityQuotaFromText,
  noteAntigravityReplySwitch,
  pickAntigravityAccount,
  resetAntigravityPoolForTests,
} from "./antigravity-pool.ts";

const accounts = [
  { instanceId: "antigravity", authenticated: true },
  { instanceId: "antigravity-b", authenticated: true },
  { instanceId: "antigravity-c", authenticated: false },
];

describe("antigravity account pool", () => {
  it("keeps a thread on the account that can still resume", () => {
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity-b",
      preferredCanResume: true,
      now: 10,
      memory: { cooldownUntil: new Map(), lastAssignedAt: new Map([["antigravity", 1]]) },
    })).toEqual({ instanceId: "antigravity-b", reason: "sticky" });
  });

  it("spreads new work to the least recently used signed-in account", () => {
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: false,
      now: 10,
      memory: { cooldownUntil: new Map(), lastAssignedAt: new Map([["antigravity", 5], ["antigravity-b", 1]]) },
    })).toEqual({ instanceId: "antigravity-b", reason: "spread" });
  });

  it("skips an account that is cooling down or already failed this turn", () => {
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      exclude: new Set(["antigravity-b"]),
      now: 10,
      memory: { cooldownUntil: new Map([["antigravity", 50]]), lastAssignedAt: new Map() },
    })).toBeNull();
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      now: 10,
      memory: { cooldownUntil: new Map([["antigravity", 50]]), lastAssignedAt: new Map() },
    })).toEqual({ instanceId: "antigravity-b", reason: "spread" });
  });

  it("treats quota, rate limits, and signed-out profiles as a reason to switch", () => {
    expect(antigravityAccountBlocked(new Error("quota exceeded for this plan"))).toBe(true);
    expect(antigravityAccountBlocked(new Error("HTTP 429: Too Many Requests"))).toBe(true);
    expect(antigravityAccountBlocked(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
    expect(antigravityAccountBlocked(new Error("not logged in"))).toBe(true);
    expect(antigravityAccountBlocked(new Error("tool failed"))).toBe(false);
  });

  it("treats the usage-limit banner as a reason to leave that account", () => {
    const banner = "Usage Limit Reached\nYou have reached your current quota for this period. Your limit will reset in 6 hours, 19 minutes.";
    expect(antigravityReplyNeedsAccountSwitch(banner)).toBe(true);
    expect(antigravityReplyNeedsAccountSwitch("Verify your account to continue.")).toBe(true);
    expect(antigravityReplyNeedsAccountSwitch("the quota looks fine")).toBe(false);
    expect(antigravityReplyNeedsAccountSwitch(`${banner}\n${"x".repeat(800)}`)).toBe(false);
    expect(antigravityUsageLimitCooldownMs(banner)).toBe((6 * 60 + 19) * 60 * 1000);
    expect(antigravityUsageLimitCooldownMs("Your limit will reset in 4 hours, 57 minutes.")).toBe((4 * 60 + 57) * 60 * 1000);
    expect(antigravityUsageLimitCooldownMs("limit reset in 30 minutes")).toBe(30 * 60 * 1000);
    expect(antigravityUsageLimitCooldownMs("quota exceeded")).toBeNull();
    resetAntigravityPoolForTests();
    noteAntigravityReplySwitch("thread-1", "antigravity", banner, 1_000);
    expect(antigravityReplySwitchExclude("thread-1").has("antigravity")).toBe(true);
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      exclude: antigravityReplySwitchExclude("thread-1"),
      now: 1_000,
    })).toEqual({ instanceId: "antigravity-b", reason: "spread" });
    resetAntigravityPoolForTests();
  });

  it("does not park an account for hours after a verification check", () => {
    resetAntigravityPoolForTests();
    noteAntigravityQuota("antigravity", 1_000, 6 * 60 * 60 * 1000);
    noteAntigravityReplySwitch("thread-2", "antigravity-b", "Verify your account to continue.", 1_000);
    clearAntigravityReplySwitch("thread-2");
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      now: 2_000,
    })).toEqual({ instanceId: "antigravity-b", reason: "spread" });
    resetAntigravityPoolForTests();
  });

  it("holds a quota account until the reset time printed in the message", () => {
    const banner = "Usage Limit Reached\nYou have reached your current quota for this period. Your limit will reset in 4 hours, 57 minutes.";
    const resetMs = (4 * 60 + 57) * 60 * 1000;
    resetAntigravityPoolForTests();
    noteAntigravityQuotaFromText("antigravity", banner, 1_000);
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      now: 1_000 + resetMs - 1,
    })).toEqual({ instanceId: "antigravity-b", reason: "spread" });
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      now: 1_000 + resetMs,
    })).toEqual({ instanceId: "antigravity", reason: "sticky" });
    resetAntigravityPoolForTests();
    noteAntigravityQuotaFromText("antigravity", "quota exceeded", 1_000);
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      now: 1_000 + ANTIGRAVITY_QUOTA_COOLDOWN_MS - 1,
    })).toEqual({ instanceId: "antigravity-b", reason: "spread" });
    expect(pickAntigravityAccount({
      accounts,
      preferredId: "antigravity",
      preferredCanResume: true,
      now: 1_000 + ANTIGRAVITY_QUOTA_COOLDOWN_MS,
    })).toEqual({ instanceId: "antigravity", reason: "sticky" });
    resetAntigravityPoolForTests();
  });

  it("keeps the selected model when another signed-in account runs the turn", () => {
    expect(antigravitySiblingKeepsModel({
      routedKind: "antigravityAgent",
      selectedKind: "antigravityAgent",
      model: "gemini-3.8-flash-high",
      optionIds: ["gemini-3.8-flash-high"],
      fallback: "gemini-3.5-flash",
    })).toBe(true);
    expect(antigravitySiblingKeepsModel({
      routedKind: "antigravityAgent",
      selectedKind: "claudeAgent",
      model: "gemini-3.8-flash-high",
      optionIds: ["gemini-3.8-flash-high"],
      fallback: "gemini-3.8-flash-high",
    })).toBe(false);
  });
});
