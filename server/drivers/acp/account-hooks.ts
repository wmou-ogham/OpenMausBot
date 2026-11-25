import type { SendTurnInput } from "../../contracts.ts";

/** Optional hooks a CLI uses to keep one session, or to leave an account that hit a quota wall. */
export interface AcpAccountHooks {
  /** Compose the session/prompt text. Default prepends the persona. `ctx.replay` is a fresh session after a refused cursor. */
  buildPromptText?(turn: SendTurnInput, ctx?: { resumed: boolean; replay: boolean }): string;
  /** Keep or drop a resume cursor before session/resume. Omit to always honour it. */
  resumeDecision?(turn: SendTurnInput): { resume: boolean; reason: string };
  /** Record provider-reported input tokens for a later resume decision. */
  noteUsage?(threadId: string, inputTokens: unknown): void;
  /** Count text this process actually sent or saw, when the provider reports no usage. */
  noteObserved?(threadId: string, chars: number): void;
  /** Assistant text as it streams, so a later resume decision can count it. */
  noteAssistantDelta?(threadId: string, delta: string, accumulated: string): void;
  /** The finished assistant text is an account limit, not an answer. True drops it and asks the host to retry. */
  abandonAssistantText?(threadId: string, text: string): boolean;
}
