import { describe, expect, it } from "vitest";
import { SYSTEM_MESSAGE, SYSTEM_PROMPT } from "./system-prompt";

describe("system prompt", () => {
  it("defines the single shared assistant personality", () => {
    expect(SYSTEM_PROMPT).toContain("Use mood and decoration tools only when they meaningfully fit");
    expect(SYSTEM_PROMPT).toContain("Use wink, wave, and think as occasional one-shot gestures");
    expect(SYSTEM_MESSAGE).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });
});
