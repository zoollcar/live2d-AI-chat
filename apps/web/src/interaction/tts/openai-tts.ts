import type { TtsSettings } from "@live2d-chat/shared";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import type { SpeechOutput, SpeechSynthesisProvider } from "./types";

export class OpenAiSpeechSynthesisProvider implements SpeechSynthesisProvider {
  readonly id = "openai-compatible";
  readonly supportsLipSync = true;

  isSupported() {
    return typeof fetch !== "undefined" && typeof Audio !== "undefined";
  }

  async listVoices() {
    return ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];
  }

  async synthesize(text: string, settings: TtsSettings, signal: AbortSignal): Promise<SpeechOutput> {
    const response = await fetch(`${normalizeBaseUrl(settings.baseUrl)}/audio/speech`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: settings.modelId, voice: settings.voice, input: text }),
      signal,
    });
    if (!response.ok) throw new Error(`Speech synthesis failed (${response.status}).`);
    return { kind: "audio", blob: await response.blob() };
  }

  cancel() {}
}
