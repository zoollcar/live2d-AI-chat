import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import type { ProxyConfig } from "./config";

const config: ProxyConfig = {
  baseUrl: "https://upstream.example/v1",
  apiKey: "server-secret",
  allowedModels: new Set(["chat-model"]),
  allowClientKey: false,
  allowedOrigins: ["http://localhost:5173"],
  timeoutMs: 5_000,
};

afterEach(() => vi.restoreAllMocks());

describe("Hono LLM proxy", () => {
  it("reports health without contacting the upstream", async () => {
    const response = await createApp(config).request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  it("rejects models outside the allow list", async () => {
    const response = await createApp(config).request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "other", messages: [{ role: "user", content: "Hi" }] }),
    });
    expect(response.status).toBe(403);
  });

  it("rejects malformed requests before contacting upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await createApp(config).request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the upstream response and uses the server key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("data: hello\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const response = await createApp(config).request("/api/llm/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chat-model",
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    expect(await response.text()).toBe("data: hello\n\n");
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe("https://upstream.example/v1/chat/completions");
    expect(new Headers(request?.[1]?.headers).get("authorization")).toBe("Bearer server-secret");
  });

  it("filters the upstream model list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      object: "list",
      data: [{ id: "chat-model" }, { id: "private-model" }],
    }));
    const response = await createApp(config).request("/api/llm/v1/models");
    expect(await response.json()).toMatchObject({ data: [{ id: "chat-model" }] });
  });

  it("uses a client key only when explicitly enabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [] }));
    const response = await createApp({ ...config, apiKey: undefined, allowClientKey: true })
      .request("/api/llm/v1/models", { headers: { authorization: "Bearer client-secret" } });
    expect(response.status).toBe(200);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("authorization"))
      .toBe("Bearer client-secret");
  });

  it("normalizes upstream failures to the shared error envelope", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const response = await createApp(config).request("/api/llm/v1/models");
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
