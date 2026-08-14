import { describe, expect, it } from "vitest";
import { SYSTEM_MESSAGE, SYSTEM_PROMPT } from "./system-prompt";

describe("system prompt", () => {
  it("defines the single shared assistant personality", () => {
    expect(SYSTEM_PROMPT).toBe(
      "You're a prototype AI secretary. Answer questions truthfully and to the best of your ability. Be helpful, engaging, and entertaining while keeping your responses natural and concise.",
    );
    expect(SYSTEM_MESSAGE).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });
});
