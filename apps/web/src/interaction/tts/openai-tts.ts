import type { TtsSettings } from "@live2d-chat/shared";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { directCorsAwareFetch } from "@/infrastructure/network/direct-fetch";
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
    const upstreamUrl = normalizeBaseUrl(settings.baseUrl);
    const extension = settings.transport === "extension";
    const fetcher = extension
      ? createExtensionFetch({
          operation: "synthesize",
          provider: "openai-compatible",
          baseUrl: upstreamUrl,
          apiKey: settings.apiKey,
          mediaType: "application/json",
        })
      : directCorsAwareFetch;
    const response = await fetcher(
      `${upstreamUrl}/audio/speech`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(!extension && settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: settings.modelId, voice: settings.voice, input: text }),
        signal,
      },
    );
    if (!response.ok) throw new Error(`Speech synthesis failed (${response.status}).`);
    return { kind: "audio", blob: await response.blob() };
  }

  cancel() {}
}
