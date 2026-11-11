import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents } from "../testing/events.ts";
import { antigravityProfileDirectory } from "./antigravity-acp.ts";
import { AntigravityDriver } from "./antigravity.ts";
import {
  ANTIGRAVITY_ACTIVE_MS,
  ANTIGRAVITY_CHECKPOINT_ERROR,
  ANTIGRAVITY_IDLE_MS,
  ANTIGRAVITY_LIVE_STATE_PATH,
  ANTIGRAVITY_NEW_AT,
  antigravityAffinityForDispatch,
  antigravityCloseStateForTests,
  antigravityNoteAssistantText,
  antigravityNoteObserved,
  antigravityNoteUsage,
  antigravityPromptText,
  antigravityRecentRecovery,
  antigravityResumeDecision,
  noteTelegramThread,
} from "./antigravity-session.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-acp-cli.ts");

let directory = "";
let statePath = "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omb-antigravity-session-"));
  statePath = join(directory, "antigravity-sessions.json");
  process.env.OMB_ANTIGRAVITY_STATE_PATH = statePath;
  antigravityCloseStateForTests();
});

afterEach(() => {
  antigravityCloseStateForTests();
  delete process.env.OMB_ANTIGRAVITY_STATE_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe("antigravity sticky session", () => {
  it("resumes until a measurement, an idle gap, a checkpoint, or a new-session command", () => {
    expect(antigravityResumeDecision({ threadId: "t" })).toEqual({ resume: true, reason: "no measurement yet" });
    antigravityNoteUsage("t", 1000);
    expect(antigravityResumeDecision({
      threadId: "t",
      antigravityAffinity: { inputTokens: 1000, gapMs: 30_000 },
    })).toEqual({ resume: true, reason: "active 30s" });
    expect(antigravityResumeDecision({
      threadId: "t",
      antigravityAffinity: { inputTokens: ANTIGRAVITY_NEW_AT, gapMs: 1000 },
    }).resume).toBe(false);
    expect(antigravityResumeDecision({
      threadId: "t",
      antigravityAffinity: { inputTokens: 1000, gapMs: ANTIGRAVITY_IDLE_MS },
    })).toEqual({ resume: false, reason: "idle 20min" });
    expect(antigravityResumeDecision({
      threadId: "t",
      antigravityAffinity: { forceNew: true, inputTokens: 10 },
    })).toEqual({ resume: false, reason: "command" });
  });

  it("treats observed text as tokens and remembers a poisoned checkpoint across a reload", () => {
    antigravityNoteObserved("t", ANTIGRAVITY_NEW_AT * 4);
    antigravityCloseStateForTests();
    expect(antigravityResumeDecision({ threadId: "t", antigravityAffinity: { inputTokens: 0 } }).resume).toBe(false);
    antigravityNoteUsage("t", 0);
    antigravityNoteAssistantText("t", `Agent execution error: ${ANTIGRAVITY_CHECKPOINT_ERROR}`, "");
    antigravityCloseStateForTests();
    expect(antigravityResumeDecision({ threadId: "t", antigravityAffinity: { inputTokens: 10 } })).toEqual({
      resume: false,
      reason: "checkpoint",
    });
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    expect(saved.t.poisoned).toBe(true);
    expect(statePath.startsWith(directory)).toBe(true);
  });

  it("keeps the latest 20 replay turns on a fresh session and sends only the new line when resuming", () => {
    const history = ["preamble"];
    for (let i = 1; i <= 25; i += 1) history.push(`User: line ${i}`);
    const recovery = `${history.join("\n")}\n[Now reply to the user's latest message:]\nUser: latest`;
    const trimmed = antigravityRecentRecovery(recovery);
    expect(trimmed).not.toContain("User: line 5\n");
    expect(trimmed).toContain("User: line 6");
    expect(trimmed).toContain("User: line 25");
    expect(antigravityPromptText(
      { text: "latest", system: "You are Moriss.", recoveryText: recovery },
      { resumed: false, replay: true },
    )).toMatch(/^You are Moriss\.\n\npreamble\n/);
    expect(antigravityPromptText(
      { text: "latest", system: "You are Moriss.", recoveryText: recovery },
      { resumed: true, replay: false },
    )).toBe("latest");
  });

  it("marks a Telegram thread and a /new command on the dispatch hint", () => {
    noteTelegramThread("tg");
    const hint = antigravityAffinityForDispatch({
      threadId: "tg",
      userText: "/new please",
      messages: [
        { id: "a", at: 1_000 },
        { id: "b", at: 1_000 + ANTIGRAVITY_IDLE_MS },
      ],
      userMessageId: "b",
      userMessageAt: 1_000 + ANTIGRAVITY_IDLE_MS,
      commsDepth: 0,
      peerAsk: false,
      fromBot: false,
      coordination: false,
      cardContinuation: false,
      contextTokens: 10,
      lastTurnInput: 4,
    });
    expect(hint).toMatchObject({ telegram: true, forceNew: true, gapMs: ANTIGRAVITY_IDLE_MS, inputTokens: 10 });
    expect(antigravityResumeDecision({ threadId: "tg", antigravityAffinity: { ...hint, forceNew: false } })).toEqual({
      resume: false,
      reason: "idle 20min",
    });
    expect(antigravityResumeDecision({
      threadId: "tg",
      antigravityAffinity: { telegram: true, gapMs: 1000, inputTokens: 10 },
    })).toEqual({ resume: true, reason: "telegram" });
  });

  it("applies the installed decision order and the dispatch commands", () => {
    antigravityNoteUsage("poisoned", 10);
    antigravityNoteAssistantText("poisoned", "ok", ANTIGRAVITY_CHECKPOINT_ERROR);
    const poisoned = { threadId: "poisoned", antigravityAffinity: { inputTokens: ANTIGRAVITY_NEW_AT, gapMs: ANTIGRAVITY_IDLE_MS, telegram: true } };
    expect(antigravityResumeDecision({ ...poisoned, antigravityAffinity: { ...poisoned.antigravityAffinity, forceNew: true } }).reason).toBe("command");
    expect(antigravityResumeDecision(poisoned).reason).toBe("checkpoint");
    expect(antigravityResumeDecision({
      threadId: "fresh",
      antigravityAffinity: { inputTokens: ANTIGRAVITY_NEW_AT - 1, gapMs: ANTIGRAVITY_IDLE_MS },
    }).reason).toBe("idle 20min");
    expect(antigravityResumeDecision({
      threadId: "fresh",
      antigravityAffinity: { inputTokens: ANTIGRAVITY_NEW_AT, gapMs: 1_000, telegram: true },
    }).reason).toBe(`context ${ANTIGRAVITY_NEW_AT} >= ${ANTIGRAVITY_NEW_AT} (stay under 100000)`);
    expect(antigravityResumeDecision({
      threadId: "fresh",
      antigravityAffinity: { inputTokens: 10, gapMs: ANTIGRAVITY_IDLE_MS - 1, telegram: true },
    })).toEqual({ resume: true, reason: "telegram" });
    expect(antigravityResumeDecision({
      threadId: "fresh",
      antigravityAffinity: { botReply: true, inputTokens: 10, gapMs: ANTIGRAVITY_ACTIVE_MS },
    })).toEqual({ resume: true, reason: "bot-reply" });
    expect(antigravityResumeDecision({
      threadId: "fresh",
      antigravityAffinity: { inputTokens: 10, gapMs: ANTIGRAVITY_ACTIVE_MS },
    })).toEqual({ resume: true, reason: "under cap (10)" });

    for (const command of ["/break", "/session now", "/NEW"]) {
      expect(antigravityAffinityForDispatch({
        threadId: "cmd",
        userText: command,
        messages: [{ id: "only", at: 5 }],
        userMessageId: "only",
        userMessageAt: 5,
        commsDepth: 1,
        peerAsk: false,
        fromBot: false,
        coordination: false,
        cardContinuation: false,
        contextTokens: 3,
        lastTurnInput: 9,
      })).toMatchObject({ forceNew: true, botReply: true, gapMs: null, inputTokens: 9 });
    }
    expect(antigravityAffinityForDispatch({
      threadId: "cmd",
      userText: "/newer",
      messages: [],
      userMessageId: "m",
      userMessageAt: 1,
      commsDepth: 0,
      peerAsk: true,
      fromBot: false,
      coordination: true,
      cardContinuation: false,
      contextTokens: Number.NaN,
      lastTurnInput: 2,
    }).forceNew).toBe(false);
  });

  it("persists reported usage, ignores bad numbers, and only flushes observed text in chunks", () => {
    antigravityNoteUsage("t", Number.NaN);
    antigravityNoteUsage("t", -1);
    expect(existsSync(statePath)).toBe(false);
    antigravityNoteUsage("t", 42.9);
    antigravityNoteObserved("t", 100);
    antigravityCloseStateForTests();
    const reloaded = JSON.parse(readFileSync(statePath, "utf8"));
    expect(reloaded.t.inputTokens).toBe(42);
    expect(reloaded.t.chars).toBeUndefined();
    antigravityNoteObserved("t", 8_000);
    antigravityCloseStateForTests();
    expect(JSON.parse(readFileSync(statePath, "utf8")).t.chars).toBe(8_000);
    antigravityNoteUsage("t", 0);
    expect(antigravityResumeDecision({ threadId: "t", antigravityAffinity: { inputTokens: 1 } })).toEqual({
      resume: true,
      reason: "under cap (1)",
    });
  });

  it("keeps a checkpoint poison when a zero usage report cleared the streamed mark", () => {
    antigravityNoteAssistantText("t", `Agent execution error: ${ANTIGRAVITY_CHECKPOINT_ERROR}`, "");
    antigravityNoteUsage("t", 0);
    expect(antigravityResumeDecision({ threadId: "t", antigravityAffinity: { inputTokens: 1 } }).resume).toBe(true);
    antigravityNoteAssistantText("t", "", ANTIGRAVITY_CHECKPOINT_ERROR);
    expect(antigravityResumeDecision({ threadId: "t", antigravityAffinity: { inputTokens: 1 } })).toEqual({
      resume: false,
      reason: "checkpoint",
    });
  });

  it("does not read or write the live session file when vitest has no override", () => {
    delete process.env.OMB_ANTIGRAVITY_STATE_PATH;
    antigravityCloseStateForTests();
    expect(antigravityResumeDecision({ threadId: "t", antigravityAffinity: { forceNew: true } })).toEqual({
      resume: true,
      reason: "tracking off",
    });
    process.env.OMB_ANTIGRAVITY_STATE_PATH = ANTIGRAVITY_LIVE_STATE_PATH;
    antigravityCloseStateForTests();
    expect(() => antigravityNoteUsage("t", 1)).toThrow(/live Antigravity session file/);
  });
});

describe("antigravity sticky session through the ACP driver", () => {
  const drivers: ProviderInstance[] = [];
  const scratch: string[] = [];

  function fakeRuntime(): { directory: string; executable: string } {
    const directory = mkdtempSync(join(tmpdir(), "omb-antigravity-driver-"));
    const executable = join(directory, "fake-antigravity.ts");
    const harness = join(directory, "localharness_external");
    copyFileSync(FAKE_ACP, executable);
    copyFileSync(FAKE_ACP, harness);
    chmodSync(executable, 0o755);
    chmodSync(harness, 0o755);
    scratch.push(directory);
    return { directory, executable };
  }

  async function createDriver(executable: string, dump: string, mode?: string): Promise<ProviderInstance> {
    // Vitest redirects HOME before this file loads, so DATA_DIR is a throwaway
    // ~/.openmausbot, not the account that the running service uses.
    if (!DATA_DIR.startsWith(tmpdir())) throw new Error(`Refusing driver tests outside a temp data dir (${DATA_DIR})`);
    ensureDirs();
    const instanceId = `sticky-${scratch.length}-${dump.split("/").at(-2)}`;
    const tokenDirectory = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokenDirectory, { recursive: true });
    writeFileSync(join(tokenDirectory, "acp_token.json"), "{}", { mode: 0o600 });
    const instance = await AntigravityDriver.create({
      instanceId,
      displayName: "Sticky",
      environment: {
        FAKE_ACP_AUTH_METHOD: "oauth-personal",
        FAKE_ACP_MODELS: "gemini-3.8-flash-high,gemini-3.8-flash-low",
        FAKE_ACP_MODES: "default,yolo,auto_edit",
        FAKE_ACP_DUMP: dump,
        FAKE_ACP_DUMP_PROMPT: "1",
        ...(mode ? { FAKE_ACP_MODE: mode } : {}),
      },
      enabled: true,
      config: { cli: executable, fullAuto: false },
    });
    drivers.push(instance);
    return instance;
  }

  async function send(instance: ProviderInstance, turn: SendTurnInput): Promise<void> {
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn(turn);
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true });
  }

  function sessionId(dump: string): string {
    const calls = JSON.parse(readFileSync(`${dump}.config.json`, "utf8")) as Array<{ params: { sessionId: string } }>;
    return calls[0].params.sessionId;
  }

  function promptText(dump: string): string {
    const prompt = JSON.parse(readFileSync(`${dump}.prompt.json`, "utf8")) as Array<{ text?: string }>;
    return String(prompt[0]?.text ?? "");
  }

  afterEach(async () => {
    while (drivers.length) await drivers.pop()!.dispose();
    while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
  });

  it("resumes the prior ACP session and sends only the new line", async () => {
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const instance = await createDriver(fake.executable, dump);
    await send(instance, {
      threadId: "resume-me",
      text: "hello",
      system: "You are Moriss.",
      approvalMode: "ask",
      model: "gemini-3.8-flash-low",
      resumeCursor: "prior-session",
      antigravityAffinity: { inputTokens: 10, gapMs: 1_000 },
      cwd: fake.directory,
    });
    expect(sessionId(dump)).toBe("prior-session");
    expect(promptText(dump)).toBe("hello");
    antigravityCloseStateForTests();
    expect(JSON.parse(readFileSync(statePath, "utf8"))["resume-me"].inputTokens).toBe(10);
  });

  it("opens a new session at the context cap and replays the trimmed recovery", async () => {
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const instance = await createDriver(fake.executable, dump);
    const history = ["preamble"];
    for (let i = 1; i <= 25; i += 1) history.push(`User: line ${i}`);
    const recovery = `${history.join("\n")}\n[Now reply to the user's latest message:]\nUser: latest`;
    await send(instance, {
      threadId: "capped",
      text: "latest",
      system: "You are Moriss.",
      approvalMode: "ask",
      model: "gemini-3.8-flash-low",
      resumeCursor: "prior-session",
      recoveryText: recovery,
      antigravityAffinity: { inputTokens: ANTIGRAVITY_NEW_AT, gapMs: 1_000 },
      cwd: fake.directory,
    });
    expect(sessionId(dump)).toBe("fake-acp-session");
    const opened = promptText(dump);
    expect(opened.startsWith("You are Moriss.\n\npreamble\n")).toBe(true);
    expect(opened).toContain("User: line 6");
    expect(opened).not.toContain("User: line 5\n");
  });

  it("opens a new session for a forced break and after a checkpoint error", async () => {
    const fake = fakeRuntime();
    const dump = join(fake.directory, "dump.json");
    const instance = await createDriver(fake.executable, dump, "echo-gated");
    const history = ["preamble"];
    for (let i = 1; i <= 25; i += 1) history.push(`User: line ${i}`);
    const recovery = `${history.join("\n")}\n[Now reply to the user's latest message:]\nUser: latest`;
    await send(instance, {
      threadId: "break-me",
      text: "latest",
      system: "You are Moriss.",
      approvalMode: "ask",
      model: "gemini-3.8-flash-low",
      resumeCursor: "prior-session",
      recoveryText: recovery,
      antigravityAffinity: { forceNew: true, inputTokens: 10 },
      cwd: fake.directory,
    });
    expect(sessionId(dump)).toBe("fake-acp-session");
    const opened = promptText(dump);
    expect(opened.startsWith("You are Moriss.\n\npreamble\n")).toBe(true);
    expect(opened).toContain("User: line 6");
    expect(opened).not.toContain("User: line 5\n");

    {
      const recorder = recordEvents(instance.adapter);
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "poison-me",
        text: `please note ${ANTIGRAVITY_CHECKPOINT_ERROR}`,
        system: "You are Moriss.",
        approvalMode: "ask",
        model: "gemini-3.8-flash-low",
        resumeCursor: "prior-session",
        antigravityAffinity: { inputTokens: 10, gapMs: 1_000 },
        cwd: fake.directory,
      });
      const retry = await recorder.until((event) => event.type === "turn.retrying" && event.turnId === turnId);
      expect(retry).toMatchObject({ reason: "antigravity_checkpoint", attempt: 1, delayMs: 0 });
      expect(recorder.events.some((event) => event.type === "turn.completed" || event.type === "item.completed")).toBe(false);
    }
    expect(sessionId(dump)).toBe("prior-session");
    expect(antigravityResumeDecision({ threadId: "poison-me", antigravityAffinity: { inputTokens: 10 } })).toEqual({
      resume: false,
      reason: "checkpoint",
    });
    await send(instance, {
      threadId: "poison-me",
      text: "again",
      system: "You are Moriss.",
      approvalMode: "ask",
      model: "gemini-3.8-flash-low",
      resumeCursor: "prior-session",
      recoveryText: "User: again",
      antigravityAffinity: { inputTokens: 10, gapMs: 1_000 },
      cwd: fake.directory,
    });
    expect(sessionId(dump)).toBe("fake-acp-session");
    expect(promptText(dump).startsWith("You are Moriss.\n\n")).toBe(true);
  });

  it("drops a model-capacity reply so the host can send a new request", async () => {
    const fake = fakeRuntime();
    const dump = join(fake.directory, "capacity.json");
    const instance = await createDriver(fake.executable, dump, "echo-gated");
    const recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "capacity-me",
      text: "Agent execution error: model unreachable: Error 503, No capacity available for model gemini-3.8-flash-high, reason:MODEL_CAPACITY_EXHAUSTED",
      system: "You are Moriss.",
      approvalMode: "ask",
      model: "gemini-3.8-flash-high",
      antigravityAffinity: { inputTokens: 10, gapMs: 1_000 },
      cwd: fake.directory,
    });
    const retry = await recorder.until((event) => event.type === "turn.retrying" && event.turnId === turnId);
    expect(retry).toMatchObject({ reason: "antigravity_capacity:gemini-3.8-flash-high", attempt: 1, delayMs: 0 });
    expect(recorder.events.some((event) => event.type === "turn.completed" || event.type === "item.completed")).toBe(false);
    expect(recorder.events.some((event) => event.type === "content.delta" && event.streamKind === "assistant_text")).toBe(false);
    expect(antigravityResumeDecision({ threadId: "capacity-me", antigravityAffinity: { inputTokens: 10 } }).resume).toBe(true);
  });
});
