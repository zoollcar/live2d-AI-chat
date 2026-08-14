import type { TtsSettings } from "@live2d-chat/shared";
import type { SpeechOutput, SpeechSynthesisProvider } from "./types";

export class BrowserSpeechSynthesisProvider implements SpeechSynthesisProvider {
  readonly id = "browser-speech";
  readonly supportsLipSync = false;

  isSupported() {
    return "speechSynthesis" in window;
  }

  async listVoices() {
    return speechSynthesis.getVoices().map((voice) => voice.voiceURI);
  }

  async synthesize(text: string, settings: TtsSettings, signal: AbortSignal): Promise<SpeechOutput> {
    if (!this.isSupported()) throw new Error("Browser speech synthesis is unavailable.");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = settings.language;
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    utterance.voice = speechSynthesis.getVoices().find((voice) =>
      voice.voiceURI === settings.voice || voice.name === settings.voice) || null;
    signal.addEventListener("abort", () => speechSynthesis.cancel(), { once: true });
    return { kind: "native", utterance };
  }

  cancel() {
    speechSynthesis.cancel();
  }
}
