import { describe, expect, it } from "vitest";
import { SYSTEM_MESSAGE, SYSTEM_PROMPT } from "./system-prompt";

describe("system prompt", () => {
  it("defines the single shared assistant personality", () => {
    expect(SYSTEM_PROMPT).toContain("setState to choose the character's complete persistent state");
    expect(SYSTEM_PROMPT).toContain("setDecorations to replace the complete decoration set");
    expect(SYSTEM_PROMPT).toContain("performAction (wink, wave, think) sparingly");
    expect(SYSTEM_PROMPT).toContain("<agent_status>");
    expect(SYSTEM_MESSAGE).toEqual({ role: "system", content: SYSTEM_PROMPT });
  });
});
