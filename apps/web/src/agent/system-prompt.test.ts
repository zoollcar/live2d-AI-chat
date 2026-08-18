import { describe, expect, it } from "vitest";
import { SYSTEM_MESSAGE, SYSTEM_PROMPT } from "./system-prompt";

describe("system prompt", () => {
  it("defines the single shared assistant personality", () => {
    expect(SYSTEM_PROMPT).toContain("setMood to set a persistent facial expression");
    expect(SYSTEM_PROMPT).toContain("setState to set the character's persistent behavioral state");
    expect(SYSTEM_PROMPT).toContain("performAction (wink, wave, think) sparingly");
    expect(SYSTEM_PROMPT).toContain("blink to force a single natural blink");
    expect(SYSTEM_MESSAGE).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });
});