// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createExtensionReaderProvider } from "./extension-reader";

function pageResponse(body: string, status = 200, contentType = "text/html; charset=utf-8"): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

describe("extension reader provider", () => {
  it("extracts plain main content through the exact-origin extension request", async () => {
    const extensionFetch = vi.fn(async () => pageResponse(`<!doctype html>
      <html><head><title>Readable title</title></head><body>
        <nav>Navigation should disappear</nav>
        <article><h1>Readable title</h1><p>This is the useful article body with enough detail for extraction.</p></article>
        <script>globalThis.stolen = true</script>
      </body></html>`)) as unknown as typeof fetch;
    const extensionFetchFactory = vi.fn(() => extensionFetch);
    const provider = createExtensionReaderProvider({
      transport: "extension",
      extensionFetchFactory,
    });

    const result = await provider.read("https://example.com/article?q=one");

    expect(result).toMatchObject({
      provider: "extension-reader",
      sourceUrl: "https://example.com/article?q=one",
      resolvedUrl: "https://example.com/article?q=one",
      title: "Readable title",
      mediaType: "text/plain",
    });
    expect(result.text).toContain("useful article body");
    expect(result.text).not.toContain("Navigation should disappear");
    expect(result.text).not.toContain("globalThis.stolen");
    expect(extensionFetchFactory).toHaveBeenCalledWith({
      operation: "read-page",
      provider: "extension-reader",
      baseUrl: "https://example.com/article?q=one",
    });
  });

  it("has no direct-mode fallback", () => {
    expect(() => createExtensionReaderProvider({ transport: "direct" })).toThrowError(
      expect.objectContaining({ code: "transport-mismatch", provider: "extension-reader" }),
    );
  });

  it.each([
    "http://localhost/page",
    "http://127.0.0.1/page",
    "http://10.0.0.4/page",
    "http://192.168.1.2/page",
    "http://[::1]/page",
    "http://2130706433/page",
  ])("blocks private target %s before asking for extension access", async (target) => {
    const extensionFetchFactory = vi.fn();
    const provider = createExtensionReaderProvider({ transport: "extension", extensionFetchFactory });

    await expect(provider.read(target)).rejects.toMatchObject({ code: "private-target" });
    expect(extensionFetchFactory).not.toHaveBeenCalled();
  });

  it("rejects login and paywall documents instead of returning their prompts", async () => {
    const pages = [
      '<html><body><form><input type="password"><button>Sign in to continue</button></form></body></html>',
      '<html><body><main><p>Preview</p><div class="article-paywall">Subscribe to continue reading</div></main></body></html>',
    ];
    for (const [index, body] of pages.entries()) {
      const provider = createExtensionReaderProvider({
        transport: "extension",
        extensionFetchFactory: () => vi.fn(async () => pageResponse(body)) as unknown as typeof fetch,
      });
      await expect(provider.read(`https://example.com/article-${index}`)).rejects.toMatchObject({
        code: index === 0 ? "authentication-required" : "paywall",
      });
    }
  });

  it("applies access guards to plain-text responses too", async () => {
    const provider = createExtensionReaderProvider({
      transport: "extension",
      extensionFetchFactory: () => vi.fn(async () => pageResponse(
        "Subscribe to continue reading this article.",
        200,
        "text/plain",
      )) as unknown as typeof fetch,
    });
    await expect(provider.read("https://example.com/article")).rejects.toMatchObject({ code: "paywall" });
  });

  it("maps restricted HTTP responses without exposing upstream content", async () => {
    const provider = createExtensionReaderProvider({
      transport: "extension",
      extensionFetchFactory: () => vi.fn(async () => pageResponse("private details", 403)) as unknown as typeof fetch,
    });

    await expect(provider.read("https://example.com/private")).rejects.toMatchObject({
      code: "access-denied",
      status: 403,
    });
  });
});
