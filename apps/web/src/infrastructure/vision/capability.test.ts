import { describe, expect, it } from "vitest";
import type { LlmSettings, ModelCapabilitySettings } from "@live2d-chat/shared";
import { resolveImageInspectionCapability } from "./capability";

function settings(overrides: Partial<LlmSettings> = {}): LlmSettings {
  return {
    transport: "direct",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    rememberApiKey: false,
    modelId: "gpt-4.1-mini",
    ...overrides,
  };
}

function capabilities(vision: ModelCapabilitySettings["vision"]): ModelCapabilitySettings {
  return { vision };
}

describe("resolveImageInspectionCapability", () => {
  it("never exposes image inspection for a local model, even with an explicit override", () => {
    expect(resolveImageInspectionCapability(
      settings({ transport: "local", modelId: "local-model" }),
      capabilities("enabled"),
    )).toEqual({ available: false, reason: "local-unsupported" });
  });

  it("honors the disabled setting before built-in model detection", () => {
    expect(resolveImageInspectionCapability(settings(), capabilities("disabled")))
      .toEqual({ available: false, reason: "disabled" });
  });

  it("enables known cloud vision models in auto mode", () => {
    expect(resolveImageInspectionCapability(settings(), capabilities("auto")))
      .toEqual({ available: true, route: "remote" });
    expect(resolveImageInspectionCapability(
      settings({ transport: "extension", modelId: "google/gemini-2.5-flash" }),
      capabilities("auto"),
    )).toEqual({ available: true, route: "remote" });
  });

  it("keeps unknown compatible models fail-closed unless explicitly enabled", () => {
    const custom = settings({ modelId: "vendor/custom-model" });
    expect(resolveImageInspectionCapability(custom, capabilities("auto")))
      .toEqual({ available: false, reason: "unknown-model" });
    expect(resolveImageInspectionCapability(custom, capabilities("enabled")))
      .toEqual({ available: true, route: "remote" });
  });

  it("keeps Chrome image inspection fail-closed until image input is reported available", () => {
    expect(resolveImageInspectionCapability(
      settings({ transport: "chrome", modelId: "gemini-nano" }),
      capabilities("auto"),
    )).toEqual({ available: false, reason: "chrome-image-unavailable" });

    expect(resolveImageInspectionCapability(
      settings({ transport: "chrome", modelId: "gemini-nano" }),
      capabilities("auto"),
      { chromeImageInputSupported: true },
    )).toEqual({ available: true, route: "chrome" });
  });
});
