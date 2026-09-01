// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createExaContentsProvider } from "./exa-contents";
import { ContentProviderError } from "./provider-error";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Exa Contents provider", () => {
  it("uses the Contents endpoint with top-level text options", async () => {
    const directFetch = vi.fn(async () => jsonResponse({
      results: [{
        title: "Example article",
        url: "https://example.com/article",
        text: "# Useful article\n\nExtracted body.",
        author: "A. Writer",
        publishedDate: "2026-08-30T00:00:00.000Z",
      }],
      statuses: [{ id: "https://example.com/article", status: "success" }],
    })) as unknown as typeof fetch;
    const provider = createExaContentsProvider({
      apiKey: "exa-secret",
      directFetch,
      maxCharacters: 8_000,
    });

    const result = await provider.read("https://example.com/article");

    expect(result).toMatchObject({
      provider: "exa",
      sourceUrl: "https://example.com/article",
      resolvedUrl: "https://example.com/article",
      title: "Example article",
      text: "# Useful article\n\nExtracted body.",
      mediaType: "text/markdown",
    });
    const [input, init] = vi.mocked(directFetch).mock.calls[0]!;
    expect(String(input)).toBe("https://api.exa.ai/contents");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("exa-secret");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      urls: ["https://example.com/article"],
      text: { maxCharacters: 8_000, includeHtmlTags: false },
    });
    expect(body).not.toHaveProperty("contents");
  });

  it("checks per-URL crawl status even when the HTTP response succeeds", async () => {
    const provider = createExaContentsProvider({
      apiKey: "secret",
      directFetch: vi.fn(async () => jsonResponse({
        results: [],
        statuses: [{
          id: "https://example.com/private",
          status: "error",
          error: { tag: "SOURCE_NOT_AVAILABLE", httpStatusCode: 403 },
        }],
      })) as unknown as typeof fetch,
    });

    await expect(provider.read("https://example.com/private")).rejects.toMatchObject({
      code: "access-denied",
      provider: "exa",
    });
  });

  it("requires a credential before creating a request", () => {
    expect(() => createExaContentsProvider({ apiKey: "" })).toThrowError(
      expect.objectContaining<Partial<ContentProviderError>>({ code: "missing-credential" }),
    );
  });

  it("does not leak a credential from a thrown transport error", async () => {
    const secret = "exa-never-print-this";
    const provider = createExaContentsProvider({
      apiKey: secret,
      directFetch: vi.fn(async () => {
        throw new Error(`network failed with ${secret}`);
      }) as unknown as typeof fetch,
    });

    let failure: unknown;
    try {
      await provider.read("https://example.com/");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ContentProviderError);
    expect(String(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("honors an already-aborted request without starting fetch", async () => {
    const directFetch = vi.fn();
    const provider = createExaContentsProvider({
      apiKey: "secret",
      directFetch: directFetch as unknown as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort(new Error("sensitive abort reason"));

    await expect(provider.read("https://example.com/", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(directFetch).not.toHaveBeenCalled();
  });
});
