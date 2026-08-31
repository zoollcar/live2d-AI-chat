import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getChromePromptApiAvailability,
  isChromePromptApiSupported,
} from "./chrome-prompt-api";

describe("Chrome Prompt API capability detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports unsupported when the browser does not expose LanguageModel", async () => {
    vi.stubGlobal("LanguageModel", undefined);
    await expect(getChromePromptApiAvailability()).resolves.toBe("unsupported");
  });

  it.each(["downloadable", "downloading", "available"] as const)(
    "treats %s as a selectable provider",
    async (availability) => {
      vi.stubGlobal("LanguageModel", {
        availability: vi.fn().mockResolvedValue(availability),
      });
      await expect(getChromePromptApiAvailability()).resolves.toBe(availability);
      expect(isChromePromptApiSupported(availability)).toBe(true);
    },
  );

  it("does not offer a provider the device reports as unavailable", async () => {
    vi.stubGlobal("LanguageModel", {
      availability: vi.fn().mockResolvedValue("unavailable"),
    });
    const availability = await getChromePromptApiAvailability();
    expect(isChromePromptApiSupported(availability)).toBe(false);
  });
});
