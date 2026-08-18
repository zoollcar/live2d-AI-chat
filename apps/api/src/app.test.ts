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
