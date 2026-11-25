// Picks which signed-in Antigravity account runs a turn, and which one takes
// over when the current account prints a quota wall. The Google profiles stay
// where the driver put them; this only chooses an instance id.
import type { ProviderInstance } from "./contracts.ts";
import { antigravityAccountLoggedIn, antigravityReplySwitchExclude, pickAntigravityAccount, type AntigravityPoolAccount } from "./antigravity-pool.ts";
import type { Store } from "./store.ts";

export interface AntigravityFleet {
  instances(): Array<{ instanceId: string; driverKind: string }>;
  get(instanceId: string): ProviderInstance | undefined;
  authenticated(instanceId: string): boolean;
}

export function antigravityPoolAccounts(fleet: AntigravityFleet, changing: ReadonlySet<string>): AntigravityPoolAccount[] {
  return fleet.instances()
    .filter((candidate) => candidate.driverKind === "antigravityAgent")
    .map((candidate) => ({
      instanceId: candidate.instanceId,
      authenticated: antigravityAccountLoggedIn(candidate.instanceId) || fleet.authenticated(candidate.instanceId),
      changing: changing.has(candidate.instanceId),
    }));
}

/** The account that should run this turn. Null keeps the bot's selected instance. */
export function antigravityInstanceForTurn(input: {
  fleet: AntigravityFleet;
  changing: ReadonlySet<string>;
  selected: ProviderInstance;
  task: { lastInstanceId?: string; resumeCursors: Record<string, unknown> } | null;
  threadId: string;
  now?: number;
}): ProviderInstance | null {
  if (input.selected.driverKind !== "antigravityAgent") return null;
  const preferredId = input.task?.lastInstanceId;
  const preferredInPool = preferredId !== undefined && input.fleet.get(preferredId)?.driverKind === "antigravityAgent";
  const picked = pickAntigravityAccount({
    accounts: antigravityPoolAccounts(input.fleet, input.changing),
    preferredId: preferredInPool ? preferredId : undefined,
    preferredCanResume: Boolean(preferredInPool && preferredId && input.task?.resumeCursors[preferredId] !== undefined),
    exclude: antigravityReplySwitchExclude(input.threadId),
    now: input.now ?? Date.now(),
  });
  if (!picked) return null;
  return input.fleet.get(picked.instanceId) ?? null;
}

export function dropAntigravityResumeCursor(store: Store, botId: string, threadId: string, instanceId: string): void {
  const task = store.taskByThread(botId, threadId);
  if (!task || task.resumeCursors[instanceId] === undefined) return;
  const resumeCursors = { ...task.resumeCursors };
  delete resumeCursors[instanceId];
  store.patchTask(botId, threadId, { resumeCursors });
}

/** Another signed-in account that has not already failed this quota wall. */
export function nextAntigravityAccount(input: {
  fleet: AntigravityFleet;
  changing: ReadonlySet<string>;
  threadId: string;
  now?: number;
}): { instanceId: string } | null {
  return pickAntigravityAccount({
    accounts: antigravityPoolAccounts(input.fleet, input.changing),
    exclude: antigravityReplySwitchExclude(input.threadId),
    now: input.now ?? Date.now(),
  });
}
