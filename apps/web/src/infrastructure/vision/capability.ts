import type { LlmSettings, ModelCapabilitySettings } from "@live2d-chat/shared";

export type ImageInspectionCapability =
  | { available: true; route: "remote" | "chrome" }
  | {
      available: false;
      reason: "local-unsupported" | "disabled" | "unknown-model" | "chrome-image-unavailable";
    };

export interface ResolveImageInspectionCapabilityOptions {
  chromeImageInputSupported?: boolean;
}

// This mirrors the selectable cloud catalogue. Models discovered from a
// custom OpenAI-compatible endpoint stay fail-closed unless the user enables
// image support explicitly in settings.
const catalogVisionModels = new Set([
  "gpt-4.1-mini",
  "gpt-4o-mini",
  "gpt-4.1",
  "openai/gpt-4.1-mini",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-2.5-flash",
]);

export function resolveImageInspectionCapability(
  settings: LlmSettings,
  capabilities: ModelCapabilitySettings,
  options: ResolveImageInspectionCapabilityOptions = {},
): ImageInspectionCapability {
  if (settings.transport === "local") {
    return { available: false, reason: "local-unsupported" };
  }
  if (capabilities.vision === "disabled") {
    return { available: false, reason: "disabled" };
  }
  if (settings.transport === "chrome") {
    return options.chromeImageInputSupported
      ? { available: true, route: "chrome" }
      : { available: false, reason: "chrome-image-unavailable" };
  }
  if (capabilities.vision === "enabled" || catalogVisionModels.has(settings.modelId.trim().toLowerCase())) {
    return { available: true, route: "remote" };
  }
  return { available: false, reason: "unknown-model" };
}
