import type { AppSettings } from "@live2d-chat/shared";

export const defaultSettings: AppSettings = {
  version: 2,
  llm: {
    transport: "proxy",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    rememberApiKey: false,
    modelId: "gpt-4.1-mini",
  },
  stt: {
    provider: "web-speech",
    transport: "direct",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    rememberApiKey: false,
    modelId: "gpt-4o-mini-transcribe",
    language: "en-US",
    continuous: false,
  },
  tts: {
    provider: "vits-local",
    transport: "direct",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    rememberApiKey: false,
    modelId: "gpt-4o-mini-tts",
    voice: "en_US-hfc_female-medium",
    language: "en-US",
    rate: 1,
    pitch: 1,
  },
  subtitlesEnabled: true,
};

export function normalizeBaseUrl(input: string): string {
  const value = input.trim().replace(/\/+$/, "");
  if (value.startsWith("/")) return value;
  if (!/^https?:\/\//i.test(value)) return `http://${value}`;
  return value;
}
