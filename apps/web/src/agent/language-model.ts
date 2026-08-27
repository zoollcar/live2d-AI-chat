import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LlmSettings } from "@live2d-chat/shared";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";

export function createRemoteLanguageModel(settings: LlmSettings) {
  const upstreamUrl = normalizeBaseUrl(settings.baseUrl);
  const viaProxy = settings.transport === "proxy";
  const provider = createOpenAICompatible({
    name: "live2d-chat",
    // AI SDK 7 resolves request paths through URL(), which requires an
    // absolute base URL even when the endpoint is same-origin.
    baseURL: viaProxy ? new URL("/api/llm/v1", window.location.origin).toString() : upstreamUrl,
    apiKey: settings.apiKey || "not-required",
    headers: viaProxy ? { "X-LLM-Base-URL": upstreamUrl } : undefined,
  });
  return provider(settings.modelId);
}
