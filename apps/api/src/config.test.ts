import { describe, expect, it } from "vitest";
import { findUpstream, loadProxyConfig } from "./config";

describe("proxy configuration", () => {
  it("parses the upstreams whitelist with id=url pairs", () => {
    const config = loadProxyConfig({
      LLM_PROXY_UPSTREAMS: "openai=https://api.openai.com/v1///, openrouter=https://openrouter.ai/api/v1,minimax-cn=https://api.minimaxi.com/v1",
      CORS_ALLOWED_ORIGINS: "https://chat.example, http://localhost:5173",
    });
    expect([...config.upstreams.values()]).toEqual([
      { id: "openai", baseUrl: "https://api.openai.com/v1" },
      { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      { id: "minimax-cn", baseUrl: "https://api.minimaxi.com/v1" },
    ]);
    expect(config.allowedOrigins).toEqual(["https://chat.example", "http://localhost:5173"]);
  });

  it("skips malformed upstream entries and defaults to an empty whitelist", () => {
    const config = loadProxyConfig({
      LLM_PROXY_UPSTREAMS: "broken-entry,openai=,=https://noop.example/v1,openrouter=https://openrouter.ai/api/v1",
    });
    expect(config.upstreams.size).toBe(1);
    expect(config.upstreams.get("openrouter")?.baseUrl).toBe("https://openrouter.ai/api/v1");
  });

  it("defaults to an empty whitelist when LLM_PROXY_UPSTREAMS is unset", () => {
    const config = loadProxyConfig({});
    expect(config.upstreams.size).toBe(0);
  });

  it("matches the upstream URL after trimming trailing slashes", () => {
    const config = loadProxyConfig({
      LLM_PROXY_UPSTREAMS: "openai=https://api.openai.com/v1",
    });
    expect(findUpstream(config, "https://api.openai.com/v1/")).toEqual({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(findUpstream(config, "https://other.example/v1")).toBeUndefined();
  });
});
