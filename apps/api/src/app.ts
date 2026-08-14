import { apiError } from "@live2d-chat/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ProxyConfig } from "./config";
import { proxyChat, proxyModels } from "./proxy";

export function createApp(config: ProxyConfig) {
  const app = new Hono();
  const allowedOrigins = new Set(config.allowedOrigins);

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : ""),
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/api/health", (c) =>
    c.json({ status: "ok", service: "live2d-chat-api", upstream: config.baseUrl }),
  );
  app.get("/api/llm/v1/models", (c) => proxyModels(c, config));
  app.post("/api/llm/v1/chat/completions", (c) => proxyChat(c, config));
  app.all("/api/llm/*", (c) =>
    c.json(apiError("not_found", "Only models and chat completions are proxied."), 404),
  );

  app.onError((error, c) => {
    console.error(error);
    return c.json(apiError("internal_error", "The proxy failed to process the request."), 500);
  });

  return app;
}
