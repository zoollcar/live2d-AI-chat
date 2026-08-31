// @vitest-environment jsdom

import type { SttSettings } from "@live2d-chat/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { OpenAiSpeechRecognitionProvider } from "./openai-stt";

const bridgeMocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/infrastructure/extension/bridge-client", () => ({
  createExtensionFetch: vi.fn(() => bridgeMocks.fetch),
}));

const settings: SttSettings = {
  provider: "openai-compatible",
  transport: "extension",
  baseUrl: "https://speech.example/v1/",
  apiKey: "secret",
  rememberApiKey: false,
  modelId: "transcribe-model",
  language: "en-US",
  continuous: false,
};

beforeEach(() => {
  bridgeMocks.fetch.mockReset();
  vi.mocked(createExtensionFetch).mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible speech recognition", () => {
  it("uses the extension bridge without putting credentials in request headers", async () => {
    bridgeMocks.fetch.mockResolvedValue(Response.json({ text: "Hello" }));
    const onFinal = vi.fn();
    const provider = new OpenAiSpeechRecognitionProvider(settings);
    Object.assign(provider, {
      callbacks: { onFinal, onError: vi.fn(), onStatus: vi.fn() },
      chunks: [new Blob(["audio"], { type: "audio/webm" })],
    });

    await (provider as unknown as { transcribe(): Promise<void> }).transcribe();

    expect(createExtensionFetch).toHaveBeenCalledWith({
      operation: "transcribe",
      provider: "openai-compatible",
      baseUrl: "https://speech.example/v1",
      apiKey: "secret",
    });
    expect(bridgeMocks.fetch.mock.calls[0]?.[0]).toBe("https://speech.example/v1/audio/transcriptions");
    const init = bridgeMocks.fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBeInstanceOf(FormData);
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(onFinal).toHaveBeenCalledWith("Hello");
  });
});
