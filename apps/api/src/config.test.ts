import { describe, expect, it } from "vitest";
import { loadProxyConfig } from "./config";

describe("proxy configuration", () => {
  it("normalizes URLs and parses allow lists", () => {
    const config = loadProxyConfig({
      LLM_BASE_URL: "https://llm.example/v1///",
      LLM_ALLOWED_MODELS: "qwen, gpt-test, qwen",
      LLM_ALLOW_CLIENT_KEY: "true",
      CORS_ALLOWED_ORIGINS: "https://chat.example, http://localhost:5173",
    });
    expect(config.baseUrl).toBe("https://llm.example/v1");
    expect([...config.allowedModels]).toEqual(["qwen", "gpt-test"]);
    expect(config.allowClientKey).toBe(true);
    expect(config.allowedOrigins).toEqual(["https://chat.example", "http://localhost:5173"]);
  });

  it("defaults to a local OpenAI-compatible endpoint", () => {
    const config = loadProxyConfig({});
    expect(config.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(config.allowedModels.size).toBe(0);
    expect(config.allowClientKey).toBe(false);
  });
});
