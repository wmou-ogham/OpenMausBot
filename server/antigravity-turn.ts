// Host-side Antigravity choices: which signed-in account runs a turn, and
// which one takes over when that account hits a quota wall. Full access stays
// a property of the thread; this file only picks an instance.
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "./contracts.ts";
import type { Message, Store } from "./store.ts";
import type { RoutineRunOn, RoutineRunTrigger } from "./routines.ts";
import { antigravityInstanceForTurn, dropAntigravityResumeCursor, nextAntigravityAccount, type AntigravityFleet } from "./antigravity-host.ts";
import { antigravityReplyNotice, antigravitySiblingKeepsModel, noteAntigravityAssignment, noteAntigravityReplySwitch } from "./antigravity-pool.ts";
export { clearAntigravityReplySwitch } from "./antigravity-pool.ts";
import { antigravityAffinityForDispatch } from "./drivers/antigravity-session.ts";

export interface AntigravityTurnDeps {
  registry: {
    instances(): Array<{ instanceId: string; driverKind: string }>;
    get(instanceId: string): ProviderInstance | null;
    lastSnapshot(instanceId: string): { authenticated?: boolean } | undefined;
  };
  changing: ReadonlySet<string>;
  store: Store;
  runningInstanceId(threadId: string): string | undefined;
  routine(threadId: string): { runOn: RoutineRunOn; triggerSource?: RoutineRunTrigger; manual: boolean } | null;
  startTurn(botId: string, text: string, opts: {
    threadId: string;
    userMessage: Message;
    replacingTurn: true;
    runOn?: RoutineRunOn;
    automationSource?: RoutineRunTrigger;
    unattended?: true;
  }): Promise<unknown>;
  publish(event: RuntimeEvent): void;
  newId(): string;
}

let bound: AntigravityTurnDeps | null = null;

export function bindAntigravityTurns(deps: AntigravityTurnDeps): void {
  bound = deps;
}

function fleetFrom(registry: AntigravityTurnDeps["registry"]): AntigravityFleet {
  return {
    instances: () => registry.instances(),
    get: (instanceId) => registry.get(instanceId) ?? undefined,
    authenticated: (instanceId) => registry.lastSnapshot(instanceId)?.authenticated === true,
  };
}

/** The instance that runs this turn. A non-Antigravity selection is unchanged. */
export function routeAntigravityInstance(
  registry: AntigravityTurnDeps["registry"],
  changing: ReadonlySet<string>,
  selected: ProviderInstance | null,
  task: { lastInstanceId?: string; resumeCursors: Record<string, unknown> } | null,
  threadId: string,
): ProviderInstance | null {
  if (!selected || selected.driverKind !== "antigravityAgent") return selected;
  const routed = antigravityInstanceForTurn({ fleet: fleetFrom(registry), changing, selected, task, threadId }) ?? selected;
  noteAntigravityAssignment(routed.instanceId);
  return routed;
}

export function antigravityModelForSibling<T extends { model: string }>(
  route: T,
  routed: ProviderInstance,
  selected: { instanceId: string; model: string },
  selectedKind: string | undefined,
): T {
  if (routed.instanceId === selected.instanceId || antigravitySiblingKeepsModel({
    routedKind: routed.driverKind,
    selectedKind,
    model: selected.model,
    optionIds: routed.models.options.map((option) => option.id),
    fallback: routed.models.default,
  })) return route;
  return { ...route, model: routed.models.default, effort: undefined, variant: undefined } as T;
}

export function antigravityTurnFields(
  instance: ProviderInstance,
  input: Parameters<typeof antigravityAffinityForDispatch>[0],
): Pick<SendTurnInput, "antigravityAffinity"> | Record<string, never> {
  if (instance.driverKind !== "antigravityAgent") return {};
  return { antigravityAffinity: antigravityAffinityForDispatch(input) };
}

export function antigravityQuotaCanSwitch(event: RuntimeEvent, limited: boolean): boolean {
  if (!bound || !limited || event.provider !== "antigravityAgent") return false;
  return nextAntigravityAccount({ fleet: fleetFrom(bound.registry), changing: bound.changing, threadId: event.threadId }) !== null;
}

function publishAntigravityUsageLimit(event: RuntimeEvent, notice: string): void {
  if (!bound) return;
  const text = notice.trim() || "Usage Limit Reached\nYou have reached your current quota for this period.";
  const turnId = event.turnId ?? bound.newId();
  const stamped = {
    provider: event.provider,
    providerInstanceId: event.providerInstanceId,
    threadId: event.threadId,
    turnId,
    createdAt: new Date().toISOString(),
  };
  bound.publish({ ...stamped, eventId: bound.newId(), type: "item.completed", itemType: "assistant_text", text });
  bound.publish({ ...stamped, eventId: bound.newId(), type: "turn.completed", ok: true, stopReason: null, cost: null });
}

/** Run the same user message on the next account. False when none is free. */
export function rerunAntigravityOnNextAccount(botId: string, event: RuntimeEvent): boolean {
  if (!bound) return false;
  const blockedId = event.providerInstanceId ?? bound.runningInstanceId(event.threadId);
  const quotaText = antigravityReplyNotice(event.threadId) ?? (event.type === "runtime.error" ? event.message : "");
  const user = [...bound.store.messagesFor(event.threadId)].reverse().find((message) =>
    message.role === "user" && message.kind === "text" && Boolean(message.text?.trim()));
  if (blockedId) {
    // Exclude this account before the next pick. The turn that follows notes
    // whoever it actually runs, so the least-recently-used order stays honest.
    noteAntigravityReplySwitch(event.threadId, blockedId, quotaText);
    dropAntigravityResumeCursor(bound.store, botId, event.threadId, blockedId);
  }
  const next = nextAntigravityAccount({ fleet: fleetFrom(bound.registry), changing: bound.changing, threadId: event.threadId });
  if (!next || !bound.registry.get(next.instanceId) || !user?.text) {
    console.error(`[antigravity-pool] thread=${event.threadId} account=${blockedId ?? "unknown"} usage limit; no other account available`);
    return false;
  }
  const run = bound.routine(event.threadId);
  console.error(`[antigravity-pool] thread=${event.threadId} account=${blockedId} usage limit; switching to ${next.instanceId}`);
  void bound.startTurn(botId, user.text, {
    threadId: event.threadId,
    userMessage: user,
    replacingTurn: true,
    ...(run ? {
      runOn: run.runOn,
      automationSource: run.triggerSource ?? (run.manual ? "manual" : "schedule"),
      unattended: true as const,
    } : {}),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[antigravity-pool] thread=${event.threadId} switch failed: ${message}`);
    publishAntigravityUsageLimit(event, quotaText || message);
  });
  return true;
}

/** The quota banner already streamed. Publish it only when no other account can take the turn. */
export function handleAntigravityQuotaRetry(botId: string | undefined, event: RuntimeEvent): void {
  if (botId && rerunAntigravityOnNextAccount(botId, event)) return;
  publishAntigravityUsageLimit(event, antigravityReplyNotice(event.threadId) ?? "");
}
