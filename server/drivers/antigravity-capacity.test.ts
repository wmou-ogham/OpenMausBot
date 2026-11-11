import { describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_CAPACITY_DELAYS_MS,
  antigravityCapacityDelay,
  antigravityCapacityExhausted,
  antigravityCapacityFallback,
  antigravityCapacityReason,
  antigravityExhaustedModel,
} from "./antigravity-capacity.ts";

const CAPACITY_ERROR = [
  "Agent execution error: model unreachable: Error 503, Message: No capacity available for model gemini-3.8-flash-high on the server, Status: UNAVAILABLE, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudcode-pa.googleapis.com metadata:map[OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST:true error_number:2010 model:gemini-3.8-flash-high] reason:MODEL_CAPACITY_EXHAUSTED]]",
].join("");

describe("antigravity capacity exhaustion", () => {
  it("recognises the server capacity error and ignores an ordinary reply", () => {
    expect(antigravityCapacityExhausted(CAPACITY_ERROR)).toBe(true);
    expect(antigravityCapacityExhausted("model unreachable")).toBe(true);
    expect(antigravityCapacityExhausted("reason:MODEL_CAPACITY_EXHAUSTED")).toBe(true);
    expect(antigravityCapacityExhausted("The queue has spare capacity for this job.")).toBe(false);
    expect(antigravityCapacityExhausted("")).toBe(false);
  });

  it("names the exhausted model and tries a lighter sibling before another provider", () => {
    expect(antigravityExhaustedModel(CAPACITY_ERROR)).toBe("gemini-3.8-flash-high");
    const catalog = [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "claude-sonnet-4-6",
    ];
    expect(antigravityCapacityFallback(catalog, ["gemini-3.8-flash-high"])).toBe("gemini-3.8-flash-medium");
    expect(antigravityCapacityFallback(catalog, [
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
    ])).toBe("claude-sonnet-4-6");
    expect(antigravityCapacityFallback(catalog, [...catalog])).toBeNull();
    expect(antigravityCapacityReason("gemini-3.8-flash-high")).toBe("antigravity_capacity:gemini-3.8-flash-high");
  });

  it("waits longer between new requests and then stops", () => {
    expect(ANTIGRAVITY_CAPACITY_DELAYS_MS.map((_, attempt) => antigravityCapacityDelay(attempt)))
      .toEqual([20_000, 40_000, 60_000, 60_000]);
    expect(antigravityCapacityDelay(ANTIGRAVITY_CAPACITY_DELAYS_MS.length)).toBeNull();
    expect(antigravityCapacityDelay(-1)).toBeNull();
  });
});
