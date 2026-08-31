import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LlmSettings } from "@live2d-chat/shared";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { directCorsAwareFetch } from "@/infrastructure/network/direct-fetch";

function providerForBaseUrl(baseUrl: string) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host === "api.openai.com") return "openai" as const;
  if (host.endsWith("openrouter.ai")) return "openrouter" as const;
  if (host.includes("minimax")) return "minimax" as const;
  if (host.endsWith("googleapis.com")) return "google" as const;
  return "openai-compatible" as const;
}

export function createRemoteLanguageModel(
  settings: LlmSettings,
  options: { operation?: "chat" | "vision" } = {},
) {
  const upstreamUrl = normalizeBaseUrl(settings.baseUrl);
  if (settings.transport !== "direct" && settings.transport !== "extension") {
    throw new Error(`Remote language model cannot use the ${settings.transport} transport.`);
  }
  const extension = settings.transport === "extension";
  const provider = createOpenAICompatible({
    name: "live2d-chat",
    baseURL: upstreamUrl,
    // Extension mode moves the credential into the nonce-bound bridge frame;
    // the provider never places the real key into an HTTP header in the page.
    apiKey: extension ? "extension-managed" : settings.apiKey || "not-required",
    fetch: extension
      ? createExtensionFetch({
          operation: options.operation ?? "chat",
          provider: providerForBaseUrl(upstreamUrl),
          baseUrl: upstreamUrl,
          apiKey: settings.apiKey,
          mediaType: "application/json",
        })
      : directCorsAwareFetch,
  });
  return provider(settings.modelId);
}
