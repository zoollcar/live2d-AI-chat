import type { LlmSettings } from "@live2d-chat/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createExtensionFetch: vi.fn(() => vi.fn()),
}));

vi.mock("@/infrastructure/extension/bridge-client", () => ({
  createExtensionFetch: mocks.createExtensionFetch,
}));

import { createRemoteLanguageModel } from "./language-model";

const settings: LlmSettings = {
  transport: "extension",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "session-only-secret",
  rememberApiKey: false,
  modelId: "gpt-4.1-mini",
};

describe("createRemoteLanguageModel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes multimodal inspection through the bridge vision allowlist operation", () => {
    createRemoteLanguageModel(settings, { operation: "vision" });

    expect(mocks.createExtensionFetch).toHaveBeenCalledWith({
      operation: "vision",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "session-only-secret",
      mediaType: "application/json",
    });
  });

  it("keeps ordinary language-model calls on the chat operation", () => {
    createRemoteLanguageModel(settings);
    expect(mocks.createExtensionFetch).toHaveBeenCalledWith(expect.objectContaining({ operation: "chat" }));
  });
});
