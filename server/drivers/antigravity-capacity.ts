// Antigravity already retries one model call until the server answers
// OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST. That flag only stops further
// retries of the same request. A later OpenMausBot turn is a new request,
// so the host can wait and send the person's message again.

export const ANTIGRAVITY_CAPACITY_REASON = "antigravity_capacity";

/** Waits before each new request to the same model, used only when the
 * account has no other model to try. Four pauses, then the turn fails. */
export const ANTIGRAVITY_CAPACITY_DELAYS_MS = [20_000, 40_000, 60_000, 60_000] as const;

/** Pause before a different model. That model may have capacity immediately. */
export const ANTIGRAVITY_CAPACITY_SWITCH_DELAY_MS = 5_000;

/** After a fallback model answers, keep using it this long. The exhausted
 * model is unlikely to have capacity again in the next few minutes. */
export const ANTIGRAVITY_CAPACITY_HOLD_MS = 15 * 60 * 1000;

const CAPACITY_MARKERS = [
  /model unreachable/i,
  /MODEL_CAPACITY_EXHAUSTED/,
  /No capacity available for model/i,
  /OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST/,
];

/** The assistant text is Antigravity reporting that the model has no server
 * capacity. Ordinary replies that merely discuss capacity do not match. */
export function antigravityCapacityExhausted(text: string): boolean {
  return CAPACITY_MARKERS.some((pattern) => pattern.test(text));
}

/** `attempt` is how many host retries have already been scheduled for this
 * turn. The first failure is attempt 0 and still gets a wait. */
export function antigravityCapacityDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return ANTIGRAVITY_CAPACITY_DELAYS_MS[attempt] ?? null;
}

const MODEL_ID = "([A-Za-z0-9._-]+)";

/** The model named by a capacity error, when the server included one. */
export function antigravityExhaustedModel(text: string): string | null {
  const tagged = text.match(new RegExp(`\\bmodel:${MODEL_ID}`));
  if (tagged?.[1]) return tagged[1];
  const prose = text.match(new RegExp(`No capacity available for model\\s+${MODEL_ID}`, "i"));
  return prose?.[1] ?? null;
}

const EFFORT_SUFFIX = /-(?:high|medium|low|xhigh|max)$/i;

/** Next model to try. A lighter sibling of the exhausted model comes first,
 * then the rest of the catalog. Models already tried are skipped. */
export function antigravityCapacityFallback(options: readonly string[], tried: readonly string[]): string | null {
  const blocked = new Set(tried);
  const rest = options.filter((id) => id.length > 0 && !blocked.has(id));
  const last = tried[tried.length - 1];
  if (last) {
    const family = last.replace(EFFORT_SUFFIX, "");
    const sibling = rest.find((id) => id.replace(EFFORT_SUFFIX, "") === family);
    if (sibling) return sibling;
  }
  return rest[0] ?? null;
}

export function antigravityCapacityReason(model: string | null): string {
  return model ? `${ANTIGRAVITY_CAPACITY_REASON}:${model}` : ANTIGRAVITY_CAPACITY_REASON;
}

export function antigravityCapacityReasonModel(reason: string): string | null {
  const prefix = `${ANTIGRAVITY_CAPACITY_REASON}:`;
  if (!reason.startsWith(prefix)) return null;
  const model = reason.slice(prefix.length);
  return model || null;
}

export function isAntigravityCapacityReason(reason: string | undefined): boolean {
  return reason === ANTIGRAVITY_CAPACITY_REASON || (reason?.startsWith(`${ANTIGRAVITY_CAPACITY_REASON}:`) ?? false);
}

const ERROR_PREFIX = "agent execution error";

/** What to do with assistant text while it is still streaming.
 * `drop` is a capacity error and must never be shown.
 * `hold` might still become that error, so it stays off the wire.
 * `show` is a normal reply. */
export function antigravityCapacityStream(text: string): "drop" | "hold" | "show" {
  if (antigravityCapacityExhausted(text)) return "drop";
  const trimmed = text.trimStart().toLowerCase();
  if (!trimmed) return "hold";
  if (ERROR_PREFIX.startsWith(trimmed) || trimmed.startsWith(ERROR_PREFIX)) {
    return trimmed.length < 180 ? "hold" : "show";
  }
  return "show";
}

/** Every listed model has already been refused, and there was more than one
 * to try. A single-model catalog is not exhausted here: the host may wait
 * and ask that model again. */
export function antigravityCapacityCatalogExhausted(options: readonly string[], tried: readonly string[]): boolean {
  const ids = options.filter((id) => id.length > 0);
  if (ids.length <= 1) return false;
  const blocked = new Set(tried);
  return ids.every((id) => blocked.has(id));
}

export function antigravityCapacitySwitchedNotice(model: string): string {
  return `已改用 ${model}，接下來 15 分鐘先用這個模型。`;
}

export function antigravityCapacityGaveUpNotice(): string {
  return "這些模型目前都沒有容量，稍後再試。";
}
