import { describe, expect, it } from "vitest";
import { defaultSettings, normalizeBaseUrl } from "./defaults";

describe("client configuration", () => {
  it.each([
    ["https://api.openai.com/v1/", "https://api.openai.com/v1"],
    [" /api/llm/v1/// ", "/api/llm/v1"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it("keeps API keys session-only by default", () => {
    expect(defaultSettings.llm.rememberApiKey).toBe(false);
    expect(defaultSettings.stt.rememberApiKey).toBe(false);
    expect(defaultSettings.tts.rememberApiKey).toBe(false);
  });
});
