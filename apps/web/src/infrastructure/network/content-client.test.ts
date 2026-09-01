// @vitest-environment jsdom

import type { ContentProviderSettings } from "@live2d-chat/shared";
import { describe, expect, it, vi } from "vitest";
import { createContentNetworkClient } from "./content-client";

const settings: ContentProviderSettings = {
  webProvider: "extension-reader",
  videoTranscriptProvider: "supadata",
  exa: { apiKey: "exa-key", rememberApiKey: false },
  supadata: { apiKey: "supadata-key", rememberApiKey: false },
};

describe("content network client", () => {
  it("uses the extension only for the explicitly selected extension reader", async () => {
    const directFetch = vi.fn();
    const extensionFetchFactory = vi.fn();
    const client = createContentNetworkClient(settings, {
      directFetch: directFetch as unknown as typeof fetch,
      extensionFetchFactory,
    });

    await expect(client.readWebPage("https://example.com/")).rejects.toThrow();
    expect(directFetch).not.toHaveBeenCalled();
    expect(extensionFetchFactory).toHaveBeenCalledTimes(1);
  });
});
