import { beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance, RuntimeEvent } from "./contracts.ts";
import { antigravityReplySwitchExclude, resetAntigravityPoolForTests } from "./antigravity-pool.ts";
import {
  antigravityQuotaCanSwitch,
  bindAntigravityTurns,
  handleAntigravityQuotaRetry,
  rerunAntigravityOnNextAccount,
  routeAntigravityInstance,
  type AntigravityTurnDeps,
} from "./antigravity-turn.ts";

function instance(instanceId: string): ProviderInstance {
  return { instanceId, driverKind: "antigravityAgent", models: { default: "gemini", options: [{ id: "gemini", name: "Gemini" }] } } as unknown as ProviderInstance;
}

function registry(ids: string[]): AntigravityTurnDeps["registry"] {
  return {
    instances: () => ids.map((instanceId) => ({ instanceId, driverKind: "antigravityAgent" })),
    get: (instanceId) => ids.includes(instanceId) ? instance(instanceId) : null,
    lastSnapshot: () => ({ authenticated: true }),
  };
}

function quotaEvent(threadId: string, providerInstanceId: string): RuntimeEvent {
  return {
    type: "turn.retrying",
    reason: "antigravity_quota",
    provider: "antigravityAgent",
    providerInstanceId,
    threadId,
    turnId: "turn",
    eventId: "event",
    createdAt: "2026-11-25T00:00:00.000Z",
    attempt: 1,
    delayMs: 0,
  };
}

describe("antigravity turn routing", () => {
  beforeEach(() => resetAntigravityPoolForTests());

  it("keeps a thread on the account that can still resume it", () => {
    const accounts = registry(["a", "b"]);
    const routed = routeAntigravityInstance(accounts, new Set(), accounts.get("a"), {
      lastInstanceId: "b",
      resumeCursors: { b: "session" },
    }, "thread");
    expect(routed?.instanceId).toBe("b");
  });

  it("sends the same user message to the next account and leaves the blocked one out", async () => {
    const started: Array<{ text: string; replacingTurn?: boolean }> = [];
    const accounts = registry(["a", "b"]);
    bindAntigravityTurns({
      registry: accounts,
      changing: new Set(),
      store: { messagesFor: () => [{ role: "user", kind: "text", text: "hello", id: "m", at: 1 }], taskByThread: () => null } as unknown as AntigravityTurnDeps["store"],
      runningInstanceId: () => "a",
      routine: () => null,
      startTurn: async (_botId, text, opts) => { started.push({ text, replacingTurn: opts.replacingTurn }); },
      publish: () => undefined,
      newId: () => "id",
    });
    expect(rerunAntigravityOnNextAccount("bot", quotaEvent("thread", "a"))).toBe(true);
    expect(started).toEqual([{ text: "hello", replacingTurn: true }]);
    expect(antigravityReplySwitchExclude("thread").has("a")).toBe(true);
    expect(antigravityQuotaCanSwitch(quotaEvent("thread", "a"), true)).toBe(true);
  });

  it("publishes the quota banner when no other account is signed in", () => {
    const published: RuntimeEvent[] = [];
    bindAntigravityTurns({
      registry: registry(["a"]),
      changing: new Set(),
      store: { messagesFor: () => [{ role: "user", kind: "text", text: "hello", id: "m", at: 1 }], taskByThread: () => null } as unknown as AntigravityTurnDeps["store"],
      runningInstanceId: () => "a",
      routine: () => null,
      startTurn: async () => { throw new Error("no other account should run"); },
      publish: (event) => published.push(event),
      newId: () => "id",
    });
    handleAntigravityQuotaRetry("bot", quotaEvent("alone", "a"));
    expect(published.map((event) => event.type)).toEqual(["item.completed", "turn.completed"]);
    expect(published[0]).toMatchObject({ text: expect.stringContaining("Usage Limit Reached") });
    expect(published[1]).toMatchObject({ ok: true });
  });
});
