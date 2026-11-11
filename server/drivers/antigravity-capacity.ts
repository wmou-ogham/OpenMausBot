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
