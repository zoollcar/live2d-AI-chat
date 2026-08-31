import { createChromeSceneTools } from "./tools";

export type ChromePromptApiAvailability = Availability | "unsupported";

export async function getChromePromptApiAvailability(
  options: { inspectImage?: boolean } = {},
): Promise<ChromePromptApiAvailability> {
  if (typeof LanguageModel === "undefined") return "unsupported";
  try {
    return await LanguageModel.availability({
      ...(options.inspectImage ? {
        expectedInputs: [{ type: "image" as const }, { type: "text" as const }],
      } : {}),
      tools: createChromeSceneTools(async () => ({ ok: true }), {
        inspectImage: options.inspectImage ?? false,
      }),
    });
  } catch {
    return "unsupported";
  }
}

export function isChromePromptApiSupported(availability: ChromePromptApiAvailability): boolean {
  return availability !== "unsupported" && availability !== "unavailable";
}
