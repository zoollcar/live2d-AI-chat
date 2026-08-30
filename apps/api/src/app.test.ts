import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { ProxyConfig } from "./config";

const config: ProxyConfig = {
  upstreams: new Map([
    ["openai", { id: "openai", baseUrl: "https://upstream.example/v1" }],
  ]),
  allowedOrigins: ["http://localhost:5173"],
  timeoutMs: 5_000,
};

afterEach(() => vi.restoreAllMocks());

describe("Hono LLM proxy", () => {
  it("reports health and exposes the upstream whitelist", async () => {
    const app = createApp(config);
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "ok", upstreams: ["openai"] });

    const list = await app.request("/api/llm/upstreams");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      upstreams: [{ id: "openai", baseUrl: "https://upstream.example/v1" }],
    });
  });

  it("rejects requests that omit the X-LLM-Base-URL header", async () => {
    const response = await createApp(config).request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chat-model", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects upstreams that are not on the allow list", async () => {
    const response = await createApp(config).request("/api/llm/v1/models", {
      headers: { "x-llm-base-url": "https://other.example/v1" },
    });
    expect(response.status).toBe(403);
  });

  it("rejects malformed requests before contacting upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await createApp(config).request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-llm-base-url": "https://upstream.example/v1",
      },
      body: "{broken",
    });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the upstream response using the client's authorization header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: hello\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const response = await createApp(config).request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer client-secret",
        "x-llm-base-url": "https://upstream.example/v1/",
      },
      body: JSON.stringify({
        model: "chat-model",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(await response.text()).toBe("data: hello\n\n");
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://upstream.example/v1/chat/completions");
    expect(new Headers(request?.[1]?.headers).get("authorization")).toBe("Bearer client-secret");
  });

  it("forwards a validated chat request without reserializing it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "response" }));
    const body = '{\n  "messages": [{"content": "Hi", "role": "user"}],\n  "model": "chat-model"\n}';
    const response = await createApp(config).request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-llm-base-url": "https://upstream.example/v1",
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(body);
  });

  it("stops the upstream request when the client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const client = new AbortController();
    const request = new Request("http://localhost/api/llm/v1/models", {
      headers: { "x-llm-base-url": "https://upstream.example/v1" },
      signal: client.signal,
    });
    const responsePromise = Promise.resolve(createApp(config).request(request));
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    client.abort();
    await responsePromise.catch(() => undefined);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("proxies STT multipart bodies and TTS JSON bodies to allow-listed upstreams", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ text: "hello" }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      }));
    const form = new FormData();
    form.append("file", new Blob(["audio"]), "speech.webm");
    form.append("model", "transcribe-model");
    const sttResponse = await createApp(config).request("/api/stt/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: "Bearer speech-secret",
        "x-stt-base-url": "https://upstream.example/v1",
      },
      body: form,
    });
    expect(await sttResponse.json()).toEqual({ text: "hello" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://upstream.example/v1/audio/transcriptions");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("content-type"))
      .toContain("multipart/form-data; boundary=");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer speech-secret");

    const ttsResponse = await createApp(config).request("/api/tts/v1/audio/speech", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tts-base-url": "https://upstream.example/v1",
      },
      body: JSON.stringify({ model: "tts-model", voice: "alloy", input: "Hello" }),
    });
    expect(await ttsResponse.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://upstream.example/v1/audio/speech");
  });

  it("forwards the upstream model list verbatim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      object: "list",
      data: [{ id: "chat-model" }, { id: "private-model" }],
    }));
    const response = await createApp(config).request("/api/llm/v1/models", {
      headers: { "x-llm-base-url": "https://upstream.example/v1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "list",
      data: [{ id: "chat-model" }, { id: "private-model" }],
    });
  });

  it("returns 503 when the proxy has no upstreams configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await createApp({ ...config, upstreams: new Map() }).request(
      "/api/llm/v1/models",
      { headers: { "x-llm-base-url": "https://upstream.example/v1" } },
    );
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes upstream failures to the shared error envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const response = await createApp(config).request("/api/llm/v1/models", {
      headers: { "x-llm-base-url": "https://upstream.example/v1" },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "upstream_unavailable", message: "connection refused" },
    });
  });

  it("does not expose unrelated LLM proxy routes", async () => {
    const response = await createApp(config).request("/api/llm/v1/audio/speech", { method: "POST" });
    expect(response.status).toBe(404);
  });
});
