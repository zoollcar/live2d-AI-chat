import { createChromeSceneTools } from "./tools";

export type ChromePromptApiAvailability = Availability | "unsupported";

export async function getChromePromptApiAvailability(): Promise<ChromePromptApiAvailability> {
  if (typeof LanguageModel === "undefined") return "unsupported";
  try {
    return await LanguageModel.availability({
      tools: createChromeSceneTools(async () => ({ ok: true })),
    });
  } catch {
    return "unsupported";
  }
}

export function isChromePromptApiSupported(availability: ChromePromptApiAvailability): boolean {
  return availability !== "unsupported" && availability !== "unavailable";
}
