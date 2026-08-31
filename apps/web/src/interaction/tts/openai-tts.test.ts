// @vitest-environment jsdom

import type { TtsSettings } from "@live2d-chat/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { OpenAiSpeechSynthesisProvider } from "./openai-tts";

const bridgeMocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/infrastructure/extension/bridge-client", () => ({
  createExtensionFetch: vi.fn(() => bridgeMocks.fetch),
}));

const settings: TtsSettings = {
  provider: "openai-compatible",
  transport: "extension",
  baseUrl: "https://speech.example/v1/",
  apiKey: "secret",
  rememberApiKey: false,
  modelId: "tts-model",
  voice: "alloy",
  language: "en-US",
  rate: 1,
  pitch: 1,
};

beforeEach(() => {
  bridgeMocks.fetch.mockReset();
  vi.mocked(createExtensionFetch).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible speech synthesis", () => {
  it("uses the extension bridge without putting credentials in request headers", async () => {
    bridgeMocks.fetch.mockResolvedValue(
      new Response(new Blob(["audio"]), { headers: { "content-type": "audio/mpeg" } }),
    );
    await new OpenAiSpeechSynthesisProvider().synthesize(
      "Hello",
      settings,
      new AbortController().signal,
    );
    expect(createExtensionFetch).toHaveBeenCalledWith({
      operation: "synthesize",
      provider: "openai-compatible",
      baseUrl: "https://speech.example/v1",
      apiKey: "secret",
      mediaType: "application/json",
    });
    expect(bridgeMocks.fetch.mock.calls[0]?.[0]).toBe("https://speech.example/v1/audio/speech");
    const init = bridgeMocks.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });

  it("can still call the upstream directly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob()));
    await new OpenAiSpeechSynthesisProvider().synthesize(
      "Hello",
      { ...settings, transport: "direct" },
      new AbortController().signal,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://speech.example/v1/audio/speech");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("x-tts-base-url")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer secret");
  });
});
