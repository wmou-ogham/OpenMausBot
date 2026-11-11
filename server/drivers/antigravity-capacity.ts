// Antigravity already retries one model call until the server answers
// OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST. That flag only stops further
// retries of the same request. A later OpenMausBot turn is a new request,
// so the host can wait and send the person's message again.

export const ANTIGRAVITY_CAPACITY_REASON = "antigravity_capacity";

/** Waits before each new request. Four pauses, then the turn is shown as failed. */
export const ANTIGRAVITY_CAPACITY_DELAYS_MS = [20_000, 40_000, 60_000, 60_000] as const;

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
