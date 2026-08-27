import { describe, expect, it } from "vitest";
import type { ChatCompletionMessage } from "@wllama/wllama";
import {
  hasContextForNextLocalStep,
  LOCAL_CONTEXT_TOKENS,
  LOCAL_MAX_OUTPUT_TOKENS,
} from "./local-context";

const toolResult: ChatCompletionMessage = {
  role: "tool",
  tool_call_id: "wave-1",
  content: JSON.stringify({ ok: true, action: "wave" }),
};

describe("local agent context budget", () => {
  it("uses an 8192-token context with a full reply reserve", () => {
    expect(LOCAL_CONTEXT_TOKENS).toBe(8_192);
    expect(LOCAL_MAX_OUTPUT_TOKENS).toBe(600);
    expect(hasContextForNextLocalStep(7_000, [toolResult])).toBe(true);
  });

  it("stops after completed tools when another full reply cannot fit", () => {
    expect(hasContextForNextLocalStep(7_580, [toolResult])).toBe(false);
  });

  it("continues when a streaming backend omits usage metadata", () => {
    expect(hasContextForNextLocalStep(undefined, [toolResult])).toBe(true);
  });
});
