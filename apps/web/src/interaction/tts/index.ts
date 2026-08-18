import type { TtsSettings } from "@live2d-chat/shared";
import { BrowserSpeechSynthesisProvider } from "./browser-speech";
import { GoogleCloudSpeechSynthesisProvider } from "./google-cloud-tts";
import { OpenAiSpeechSynthesisProvider } from "./openai-tts";
import type { SpeechSynthesisProvider } from "./types";
import { VitsSpeechSynthesisProvider } from "./vits";

export function createTtsProvider(settings: TtsSettings): SpeechSynthesisProvider {
  if (settings.provider === "browser-speech") return new BrowserSpeechSynthesisProvider();
  if (settings.provider === "openai-compatible") return new OpenAiSpeechSynthesisProvider();
  if (settings.provider === "google-cloud") return new GoogleCloudSpeechSynthesisProvider();
  return new VitsSpeechSynthesisProvider();
}

export type { SpeechOutput, SpeechSynthesisProvider } from "./types";
