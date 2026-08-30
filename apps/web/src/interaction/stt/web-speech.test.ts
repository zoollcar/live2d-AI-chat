// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SttSettings } from "@live2d-chat/shared";
import { WebSpeechRecognitionProvider } from "./web-speech";

const settings: SttSettings = {
  provider: "web-speech",
  transport: "direct",
  baseUrl: "https://example.test/v1",
  apiKey: "",
  rememberApiKey: false,
  modelId: "unused",
  language: "en-US",
  continuous: true,
};

class FakeRecognition extends EventTarget implements SpeechRecognition {
  static latest?: FakeRecognition;
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onaudiostart: (() => void) | null = null;
  onaudioend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  onnomatch: (() => void) | null = null;

  constructor() {
    super();
    FakeRecognition.latest = this;
  }

  start(): void { this.onstart?.(); }
  stop(): void { this.onend?.(); }
  abort(): void { /* test fake */ }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecognition.latest = undefined;
});

describe("WebSpeechRecognitionProvider", () => {
  it("surfaces speech-start before a final transcript so Classic can interrupt playback early", async () => {
    vi.stubGlobal("SpeechRecognition", FakeRecognition);
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: FakeRecognition,
    });
    const onSpeechStart = vi.fn();
    const provider = new WebSpeechRecognitionProvider(settings);

    await provider.start({
      onSpeechStart,
      onInterim: vi.fn(),
      onFinal: vi.fn(),
      onStatus: vi.fn(),
      onError: vi.fn(),
    });
    FakeRecognition.latest?.onspeechstart?.();

    expect(onSpeechStart).toHaveBeenCalledOnce();
  });
});
