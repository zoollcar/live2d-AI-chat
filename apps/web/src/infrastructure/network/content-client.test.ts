// @vitest-environment jsdom

import type { ContentProviderSettings } from "@live2d-chat/shared";
import { describe, expect, it, vi } from "vitest";
import { createContentNetworkClient } from "./content-client";

const settings: ContentProviderSettings = {
  webProvider: "extension-reader",
  webTransport: "direct",
  videoTranscriptProvider: "supadata",
  videoTransport: "direct",
  exa: { apiKey: "exa-key", rememberApiKey: false },
  supadata: { apiKey: "supadata-key", rememberApiKey: false },
};

describe("content network client", () => {
  it("does not fall back when the selected provider and transport are incompatible", async () => {
    const directFetch = vi.fn();
    const extensionFetchFactory = vi.fn();
    const client = createContentNetworkClient(settings, {
      directFetch: directFetch as unknown as typeof fetch,
      extensionFetchFactory,
    });

    await expect(client.readWebPage("https://example.com/")).rejects.toMatchObject({
      code: "transport-mismatch",
      provider: "extension-reader",
    });
    expect(directFetch).not.toHaveBeenCalled();
    expect(extensionFetchFactory).not.toHaveBeenCalled();
  });
});
