// @vitest-environment jsdom

import type { SttSettings } from "@live2d-chat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiSpeechRecognitionProvider } from "./openai-stt";

const settings: SttSettings = {
  provider: "openai-compatible",
  transport: "proxy",
  baseUrl: "https://speech.example/v1/",
  apiKey: "secret",
  rememberApiKey: false,
  modelId: "transcribe-model",
  language: "en-US",
  continuous: false,
};

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible speech recognition", () => {
  it("uses the local proxy while preserving the multipart request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ text: "Hello" }));
    const onFinal = vi.fn();
    const provider = new OpenAiSpeechRecognitionProvider(settings);
    Object.assign(provider, {
      callbacks: { onFinal, onError: vi.fn(), onStatus: vi.fn() },
      chunks: [new Blob(["audio"], { type: "audio/webm" })],
    });

    await (provider as unknown as { transcribe(): Promise<void> }).transcribe();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/stt/v1/audio/transcriptions");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.body).toBeInstanceOf(FormData);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-stt-base-url")).toBe("https://speech.example/v1");
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(onFinal).toHaveBeenCalledWith("Hello");
  });
});
