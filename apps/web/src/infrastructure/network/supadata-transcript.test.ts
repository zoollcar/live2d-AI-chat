// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { ContentProviderError } from "./provider-error";
import { MAX_TRANSCRIPT_WAIT_MS, createSupadataTranscriptProvider } from "./supadata-transcript";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const completed = {
  content: [
    { text: "Second cue", offset: 2_000, duration: 750, lang: "en" },
    { text: "First cue", offset: 250, duration: 1_000, lang: "en" },
  ],
  lang: "en",
  availableLangs: ["en", "es"],
};

describe("Supadata transcript provider", () => {
  it("returns timestamped cues from an immediate direct response", async () => {
    const directFetch = vi.fn(async () => jsonResponse(completed)) as unknown as typeof fetch;
    const provider = createSupadataTranscriptProvider({
      transport: "direct",
      apiKey: "supadata-secret",
      directFetch,
    });

    const result = await provider.read({ url: "https://youtu.be/video-id", language: "en" });

    expect(result).toMatchObject({
      status: "ready",
      provider: "supadata",
      sourceUrl: "https://youtu.be/video-id",
      language: "en",
      availableLanguages: ["en", "es"],
      text: "First cue\nSecond cue",
      cues: [
        { text: "First cue", startSeconds: 0.25, endSeconds: 1.25, language: "en" },
        { text: "Second cue", startSeconds: 2, endSeconds: 2.75, language: "en" },
      ],
    });
    const [request, init] = vi.mocked(directFetch).mock.calls[0]!;
    const url = new URL(String(request));
    expect(`${url.origin}${url.pathname}`).toBe("https://api.supadata.ai/v1/transcript");
    expect(url.searchParams.get("url")).toBe("https://youtu.be/video-id");
    expect(url.searchParams.get("text")).toBe("false");
    expect(url.searchParams.get("mode")).toBe("auto");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("supadata-secret");
  });

  it("polls a 202 extension job until completion without using direct fetch", async () => {
    const extensionFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId: "job_123" }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", ...completed }));
    const extensionFetchFactory = vi.fn(() => extensionFetch as unknown as typeof fetch);
    const directFetch = vi.fn();
    const sleep = vi.fn(async () => undefined);
    const provider = createSupadataTranscriptProvider({
      transport: "extension",
      apiKey: "extension-secret",
      directFetch: directFetch as unknown as typeof fetch,
      extensionFetchFactory,
      sleep,
      pollIntervalMs: 1,
    });

    const result = await provider.read({ url: "https://www.youtube.com/watch?v=abc", language: "en" });

    expect(result.jobId).toBe("job_123");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(directFetch).not.toHaveBeenCalled();
    expect(extensionFetchFactory).toHaveBeenCalledWith(expect.objectContaining({
      operation: "supadata",
      provider: "supadata",
      apiKey: "extension-secret",
    }));
    const requestBodies = extensionFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as unknown);
    expect(requestBodies).toEqual([
      {
        url: "https://www.youtube.com/watch?v=abc",
        lang: "en",
        text: false,
        mode: "auto",
        chunkSize: 1_000,
      },
      { jobId: "job_123" },
      { jobId: "job_123" },
    ]);
    expect(extensionFetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has("x-api-key"))).toBe(true);
  });

  it("aborts while waiting to poll", async () => {
    const controller = new AbortController();
    let signalSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      signalSleepStarted = resolve;
    });
    const provider = createSupadataTranscriptProvider({
      transport: "direct",
      apiKey: "secret",
      directFetch: vi.fn(async () => jsonResponse({ jobId: "job_abort" }, 202)) as unknown as typeof fetch,
      sleep: (_milliseconds, signal) => new Promise((_resolve, reject) => {
        signalSleepStarted();
        signal.addEventListener("abort", () => reject(new DOMException("raw reason", "AbortError")), { once: true });
      }),
      pollIntervalMs: 1,
    });
    const pending = provider.read({ url: "https://youtu.be/video" }, controller.signal);
    await sleepStarted;
    controller.abort(new Error("secret abort reason"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "The content request was cancelled." });
  });

  it("returns a resumable pending job at the deadline and resumes without replaying the initial request", async () => {
    expect(() => createSupadataTranscriptProvider({
      transport: "direct",
      apiKey: "secret",
      timeoutMs: MAX_TRANSCRIPT_WAIT_MS + 1,
    })).toThrow("between 1 and 90000");

    const directFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId: "job_timeout" }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", ...completed }));
    const provider = createSupadataTranscriptProvider({
      transport: "direct",
      apiKey: "secret",
      directFetch: directFetch as unknown as typeof fetch,
      timeoutMs: 10,
      pollIntervalMs: 1_000,
    });
    const pending = await provider.read({ url: "https://youtu.be/video", language: "en" });
    expect(pending).toEqual({
      status: "processing",
      provider: "supadata",
      sourceUrl: "https://youtu.be/video",
      language: "en",
      jobId: "job_timeout",
    });
    expect(directFetch).toHaveBeenCalledTimes(1);

    if (pending.status !== "processing") throw new Error("Expected a processing result.");
    const resumed = await provider.poll(pending);
    expect(resumed).toMatchObject({ status: "ready", jobId: "job_timeout" });
    expect(directFetch).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(directFetch.mock.calls[0]?.[0]));
    const resumedUrl = new URL(String(directFetch.mock.calls[1]?.[0]));
    expect(firstUrl.searchParams.get("url")).toBe("https://youtu.be/video");
    expect(resumedUrl.toString()).toBe("https://api.supadata.ai/v1/transcript/job_timeout");
    expect(resumedUrl.search).toBe("");
  });

  it("does not leak credentials or raw failed-job details", async () => {
    const secret = "supadata-never-print-this";
    const directFetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ jobId: "job_failed" }, 202))
      .mockResolvedValueOnce(jsonResponse({
        status: "failed",
        error: { error: `auth-${secret}`, message: `upstream echoed ${secret}` },
      }));
    const provider = createSupadataTranscriptProvider({
      transport: "direct",
      apiKey: secret,
      directFetch: directFetch as unknown as typeof fetch,
      sleep: async () => undefined,
      pollIntervalMs: 1,
    });

    let failure: unknown;
    try {
      await provider.read({ url: "https://youtu.be/video" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ContentProviderError);
    expect(failure).toMatchObject({ code: "access-denied" });
    expect(String(failure)).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it("rejects private video targets before spending provider credits", async () => {
    const directFetch = vi.fn();
    const provider = createSupadataTranscriptProvider({
      transport: "direct",
      apiKey: "secret",
      directFetch: directFetch as unknown as typeof fetch,
    });
    await expect(provider.read({ url: "http://127.0.0.1/video.mp4" })).rejects.toMatchObject({
      code: "private-target",
    });
    expect(directFetch).not.toHaveBeenCalled();
  });
});
