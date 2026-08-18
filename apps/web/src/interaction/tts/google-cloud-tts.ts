import type { TtsSettings } from "@live2d-chat/shared";
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

export async function fetchGoogleCloudVoices(apiKey: string, languageCode: string, signal: AbortSignal): Promise<GoogleCloudVoice[]> {
  const url = new URL(GOOGLE_CLOUD_VOICES_URL);
  url.searchParams.set("languageCode", toGoogleLanguageCode(languageCode));
  const response = await fetch(url, {
    headers: { "x-goog-api-key": apiKey.trim() },
    signal,
  });
  const result = await response.json() as GoogleCloudVoicesResponse;
  if (!response.ok) throw new Error(result.error?.message || `Unable to load Google Cloud voices (${response.status}).`);
  return (result.voices || []).sort((left, right) => left.name.localeCompare(right.name));
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
    if (!settings.apiKey.trim()) throw new Error("A Google Cloud API key is required for speech synthesis.");

    const response = await fetch(GOOGLE_CLOUD_TTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": settings.apiKey.trim(),
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
