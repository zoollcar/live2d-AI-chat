import "dotenv/config";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { createApp } from "../app";
import { loadProxyConfig } from "../config";

const api = createApp(loadProxyConfig(process.env));
const server = new Hono();
server.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "credentialless");
});
server.route("/", api);

const webRoot = fileURLToPath(new URL("../../../web/dist/", import.meta.url));
if (existsSync(webRoot)) {
  server.use("/*", serveStatic({ root: webRoot }));
  server.get("*", serveStatic({ root: webRoot, path: "index.html" }));
}

const port = Number(process.env.PORT || 8787);
const instance = serve({ fetch: server.fetch, port }, (info) => {
  console.log(`Live2D AI is running at http://localhost:${info.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => instance.close(() => process.exit(0)));
}
