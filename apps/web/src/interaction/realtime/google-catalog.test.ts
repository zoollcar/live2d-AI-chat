import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleRealtimeModels } from "./google-catalog";

describe("fetchGoogleRealtimeModels", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the API key header, follows pagination, and returns only Live API models", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            {
              name: "models/gemini-live-a",
              displayName: "Gemini Live A",
              supportedGenerationMethods: ["bidiGenerateContent"],
            },
            {
              name: "models/gemini-text",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
          nextPageToken: "next page",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{
            baseModelId: "gemini-live-b",
            displayName: "Gemini Live B",
            supportedGenerationMethods: ["BidiGenerateContent"],
          }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchGoogleRealtimeModels(" secret-key ")).resolves.toEqual([
      { id: "gemini-live-a", label: "Gemini Live A" },
      { id: "gemini-live-b", label: "Gemini Live B" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(firstUrl.searchParams.get("pageSize")).toBe("1000");
    expect(firstUrl.searchParams.has("key")).toBe(false);
    expect(secondUrl.searchParams.get("pageToken")).toBe("next page");
    expect(firstInit.headers).toEqual({ "x-goog-api-key": "secret-key" });
  });

  it("surfaces the API error without including the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "API key is not authorized." } }),
    })));

    await expect(fetchGoogleRealtimeModels("private-key")).rejects.toThrow("API key is not authorized.");
  });
});
