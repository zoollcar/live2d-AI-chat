import { apiError } from "@live2d-chat/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ProxyConfig } from "./config";
import { proxyChat, proxyModels, proxySpeechToText, proxyTextToSpeech } from "./proxy";

export function createApp(config: ProxyConfig) {
  const app = new Hono();
  const allowedOrigins = new Set(config.allowedOrigins);

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (allowedOrigins.has(origin) ? origin : ""),
      allowHeaders: [
        "authorization",
        "content-type",
        "x-llm-base-url",
        "x-stt-base-url",
        "x-tts-base-url",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      service: "live2d-chat-api",
      upstreams: [...config.upstreams.values()].map((upstream) => upstream.id),
    }),
  );

  app.get("/api/llm/upstreams", (c) =>
    c.json({ upstreams: [...config.upstreams.values()] }),
  );

  app.get("/api/llm/v1/models", (c) => proxyModels(c, config));
  app.post("/api/llm/v1/chat/completions", (c) => proxyChat(c, config));
  app.all("/api/llm/*", (c) =>
    c.json(apiError("not_found", "Only upstreams, models, and chat completions are proxied."), 404),
  );

  app.post("/api/stt/v1/audio/transcriptions", (c) => proxySpeechToText(c, config));
  app.all("/api/stt/*", (c) =>
    c.json(apiError("not_found", "Only audio transcriptions are proxied."), 404),
  );

  app.post("/api/tts/v1/audio/speech", (c) => proxyTextToSpeech(c, config));
  app.all("/api/tts/*", (c) =>
    c.json(apiError("not_found", "Only audio speech synthesis is proxied."), 404),
  );

  app.onError((error, c) => {
    console.error(error);
    return c.json(apiError("internal_error", "The proxy failed to process the request."), 500);
  });

  return app;
}
