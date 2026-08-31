// @vitest-environment jsdom

import type { TtsSettings } from "@live2d-chat/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { DIRECT_CORS_GUIDANCE } from "@/infrastructure/network/direct-fetch";
import {
  fetchGoogleCloudVoices,
  GoogleCloudSpeechSynthesisProvider,
} from "./google-cloud-tts";

const bridgeMocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/infrastructure/extension/bridge-client", () => ({
  createExtensionFetch: vi.fn(() => bridgeMocks.fetch),
}));

const settings: TtsSettings = {
  provider: "google-cloud",
  transport: "direct",
  baseUrl: "https://unused.example/v1",
  apiKey: " google-secret ",
  rememberApiKey: false,
  modelId: "unused",
  voice: "cmn-CN-Chirp3-HD-Achernar",
  language: "zh-CN",
  rate: 1.2,
  pitch: 2,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  bridgeMocks.fetch.mockReset();
  vi.mocked(createExtensionFetch).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Google Cloud speech synthesis transport", () => {
  it("loads and filters voices directly with the Google API key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      voices: [
        {
          languageCodes: ["en-US"],
          name: "en-US-Chirp3-HD-Achernar",
          ssmlGender: "FEMALE",
          naturalSampleRateHertz: 24_000,
        },
        {
          languageCodes: ["cmn-CN"],
          name: "cmn-CN-Chirp3-HD-Zephyr",
          ssmlGender: "FEMALE",
          naturalSampleRateHertz: 24_000,
        },
        {
          languageCodes: ["cmn-CN"],
          name: "cmn-CN-Chirp3-HD-Achernar",
          ssmlGender: "MALE",
          naturalSampleRateHertz: 24_000,
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const voices = await fetchGoogleCloudVoices(settings, new AbortController().signal);

    expect(voices.map((voice) => voice.name)).toEqual([
      "cmn-CN-Chirp3-HD-Achernar",
      "cmn-CN-Chirp3-HD-Zephyr",
    ]);
    const [input, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(input.toString()).toBe("https://texttospeech.googleapis.com/v1/voices?languageCode=cmn-CN");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("google-secret");
    expect(createExtensionFetch).not.toHaveBeenCalled();
  });

  it("loads voices only through the fixed extension operation when selected", async () => {
    bridgeMocks.fetch.mockResolvedValue(jsonResponse({
      voices: [{
        languageCodes: ["cmn-CN"],
        name: "cmn-CN-Wavenet-A",
        ssmlGender: "FEMALE",
        naturalSampleRateHertz: 24_000,
      }],
    }));
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);

    const voices = await fetchGoogleCloudVoices(
      { ...settings, transport: "extension" },
      new AbortController().signal,
    );

    expect(voices).toHaveLength(1);
    expect(createExtensionFetch).toHaveBeenCalledWith({
      operation: "models",
      provider: "google-cloud",
      apiKey: "google-secret",
    });
    const [input, init] = bridgeMocks.fetch.mock.calls[0] as [URL, RequestInit];
    expect(input.toString()).toContain("/v1/voices?languageCode=cmn-CN");
    expect(new Headers(init.headers).has("x-goog-api-key")).toBe(false);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("synthesizes directly with a fixed URL and no authorization bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ audioContent: btoa("audio") }));
    vi.stubGlobal("fetch", fetchMock);

    const output = await new GoogleCloudSpeechSynthesisProvider().synthesize(
      "你好",
      settings,
      new AbortController().signal,
    );

    expect(output.kind).toBe("audio");
    if (output.kind !== "audio") throw new Error("Expected an audio output.");
    expect(output.blob.type).toBe("audio/mpeg");
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    const headers = new Headers(init.headers);
    expect(headers.get("x-goog-api-key")).toBe("google-secret");
    expect(headers.has("authorization")).toBe(false);
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: { text: "你好" },
      voice: { languageCode: "cmn-CN", name: settings.voice },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.2, pitch: 12 },
    });
    expect(createExtensionFetch).not.toHaveBeenCalled();
  });

  it("does not replay a failed extension synthesis directly", async () => {
    bridgeMocks.fetch.mockRejectedValue(new Error("Extension unavailable"));
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);

    await expect(new GoogleCloudSpeechSynthesisProvider().synthesize(
      "Hello",
      { ...settings, transport: "extension" },
      new AbortController().signal,
    )).rejects.toThrow("Extension unavailable");

    expect(createExtensionFetch).toHaveBeenCalledWith({
      operation: "synthesize",
      provider: "google-cloud",
      apiKey: "google-secret",
      mediaType: "application/json",
    });
    const [input, init] = bridgeMocks.fetch.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(new Headers(init.headers).has("x-goog-api-key")).toBe(false);
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("surfaces direct CORS guidance without falling back to the extension", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(new GoogleCloudSpeechSynthesisProvider().synthesize(
      "Hello",
      settings,
      new AbortController().signal,
    )).rejects.toThrow(DIRECT_CORS_GUIDANCE);
    expect(createExtensionFetch).not.toHaveBeenCalled();
  });
});
