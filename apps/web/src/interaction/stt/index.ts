import type { SttSettings } from "@live2d-chat/shared";
import { OpenAiSpeechRecognitionProvider } from "./openai-stt";
import type { SpeechRecognitionProvider } from "./types";
import { WebSpeechRecognitionProvider } from "./web-speech";

export function createSttProvider(settings: SttSettings): SpeechRecognitionProvider {
  return settings.provider === "openai-compatible"
    ? new OpenAiSpeechRecognitionProvider(settings)
    : new WebSpeechRecognitionProvider(settings);
}

export type { RecognitionCallbacks, SpeechRecognitionProvider } from "./types";
