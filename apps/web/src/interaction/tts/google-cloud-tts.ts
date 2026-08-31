import type { TtsSettings } from "@live2d-chat/shared";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { directCorsAwareFetch } from "@/infrastructure/network/direct-fetch";
import type { SpeechOutput, SpeechSynthesisProvider } from "./types";

const GOOGLE_CLOUD_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
const GOOGLE_CLOUD_VOICES_URL = "https://texttospeech.googleapis.com/v1/voices";

export interface GoogleCloudVoice {
  languageCodes: string[];
  name: string;
  ssmlGender: string;
  naturalSampleRateHertz: number;
}

interface GoogleCloudTtsResponse {
  audioContent?: string;
  error?: {
    message?: string;
  };
}

interface GoogleCloudVoicesResponse {
  voices?: GoogleCloudVoice[];
  error?: {
    message?: string;
  };
}

function toGoogleLanguageCode(languageCode: string): string {
  return languageCode.toLowerCase() === "zh-cn" ? "cmn-CN" : languageCode;
}

export async function fetchGoogleCloudVoices(
  settings: Pick<TtsSettings, "apiKey" | "language" | "transport">,
  signal: AbortSignal,
): Promise<GoogleCloudVoice[]> {
  const apiKey = settings.apiKey.trim();
  if (!apiKey) throw new Error("A Google Cloud API key is required to load voices.");
  const languageCode = toGoogleLanguageCode(settings.language);
  const url = new URL(GOOGLE_CLOUD_VOICES_URL);
  url.searchParams.set("languageCode", languageCode);
  const extension = settings.transport === "extension";
  const fetcher = extension
    ? createExtensionFetch({
        operation: "models",
        provider: "google-cloud",
        apiKey,
      })
    : directCorsAwareFetch;
  const response = await fetcher(url, {
    headers: extension ? {} : { "x-goog-api-key": apiKey },
    signal,
  });
  const result = await response.json() as GoogleCloudVoicesResponse;
  if (!response.ok) throw new Error(result.error?.message || `Unable to load Google Cloud voices (${response.status}).`);
  const normalizedLanguage = languageCode.toLowerCase();
  // The extension intentionally maps `models` to the fixed /v1/voices URL
  // without forwarding caller-controlled query parameters, so filter both
  // direct and bridged responses locally.
  return (result.voices || [])
    .filter((voice) => voice.languageCodes.some((candidate) => candidate.toLowerCase() === normalizedLanguage))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function decodeBase64Audio(audioContent: string): Blob {
  const binary = atob(audioContent);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: "audio/mpeg" });
}

function toGooglePitch(pitchMultiplier: number): number {
  if (pitchMultiplier <= 0) return 0;
  return Math.max(-20, Math.min(20, 12 * Math.log2(pitchMultiplier)));
}

export class GoogleCloudSpeechSynthesisProvider implements SpeechSynthesisProvider {
  readonly id = "google-cloud";
  readonly supportsLipSync = true;

  isSupported() {
    return typeof fetch !== "undefined" && typeof atob !== "undefined" && typeof Audio !== "undefined";
  }

  async listVoices() {
    return [];
  }

  async synthesize(text: string, settings: TtsSettings, signal: AbortSignal): Promise<SpeechOutput> {
    const apiKey = settings.apiKey.trim();
    if (!apiKey) throw new Error("A Google Cloud API key is required for speech synthesis.");
    const extension = settings.transport === "extension";
    const fetcher = extension
      ? createExtensionFetch({
          operation: "synthesize",
          provider: "google-cloud",
          apiKey,
          mediaType: "application/json",
        })
      : directCorsAwareFetch;

    const response = await fetcher(GOOGLE_CLOUD_TTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(!extension ? { "x-goog-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        input: { text },
        voice: {
          languageCode: toGoogleLanguageCode(settings.language),
          ...(settings.voice.trim() ? { name: settings.voice.trim() } : {}),
        },
        audioConfig: {
          audioEncoding: "MP3",
          speakingRate: settings.rate,
          pitch: toGooglePitch(settings.pitch),
        },
      }),
      signal,
    });

    const result = await response.json() as GoogleCloudTtsResponse;
    if (!response.ok) {
      throw new Error(result.error?.message || `Google Cloud speech synthesis failed (${response.status}).`);
    }
    if (!result.audioContent) throw new Error("Google Cloud speech synthesis returned no audio.");
    return { kind: "audio", blob: decodeBase64Audio(result.audioContent) };
  }

  cancel() {}
}
