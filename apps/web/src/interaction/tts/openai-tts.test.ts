// @vitest-environment jsdom

import type { TtsSettings } from "@live2d-chat/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiSpeechSynthesisProvider } from "./openai-tts";

const settings: TtsSettings = {
  provider: "openai-compatible",
  transport: "proxy",
  baseUrl: "https://speech.example/v1/",
  apiKey: "secret",
  rememberApiKey: false,
  modelId: "tts-model",
  voice: "alloy",
  language: "en-US",
  rate: 1,
  pitch: 1,
};

afterEach(() => vi.restoreAllMocks());

describe("OpenAI-compatible speech synthesis", () => {
  it("uses the local proxy while preserving the selected upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Blob(["audio"]), { headers: { "content-type": "audio/mpeg" } }),
    );
    await new OpenAiSpeechSynthesisProvider().synthesize(
      "Hello",
      settings,
      new AbortController().signal,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tts/v1/audio/speech");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-tts-base-url")).toBe("https://speech.example/v1");
    expect(headers.get("authorization")).toBe("Bearer secret");
  });

  it("can still call the upstream directly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob()));
    await new OpenAiSpeechSynthesisProvider().synthesize(
      "Hello",
      { ...settings, transport: "direct" },
      new AbortController().signal,
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://speech.example/v1/audio/speech");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has("x-tts-base-url")).toBe(false);
  });
});
