import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.unknown(),
}).passthrough();

export const chatCompletionRequestSchema = z.object({
  model: z.string().trim().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export type LlmTransport = "proxy" | "direct" | "local";

export interface LlmSettings {
  transport: LlmTransport;
  baseUrl: string;
  apiKey: string;
  rememberApiKey: boolean;
  modelId: string;
}

export type SttProviderId = "web-speech" | "openai-compatible";
export type SpeechServiceTransport = "proxy" | "direct";
export interface SttSettings {
  provider: SttProviderId;
  transport: SpeechServiceTransport;
  baseUrl: string;
  apiKey: string;
  rememberApiKey: boolean;
  modelId: string;
  language: string;
  continuous: boolean;
}

export type TtsProviderId = "vits-local" | "browser-speech" | "openai-compatible" | "google-cloud";
export interface TtsSettings {
  provider: TtsProviderId;
  transport: SpeechServiceTransport;
  baseUrl: string;
  apiKey: string;
  rememberApiKey: boolean;
  modelId: string;
  voice: string;
  language: string;
  rate: number;
  pitch: number;
}

export interface AppSettings {
  version: 2;
  llm: LlmSettings;
  stt: SttSettings;
  tts: TtsSettings;
  subtitlesEnabled: boolean;
}

export const stageLayoutIds = [
  "half-body-left",
  "half-body-right",
  "full-body-center",
  "half-body-center",
] as const;
export type StageLayoutId = (typeof stageLayoutIds)[number];

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}
