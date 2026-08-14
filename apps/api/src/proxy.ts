import { apiError, chatCompletionRequestSchema } from "@live2d-chat/shared";
import type { Context } from "hono";
import type { ProxyConfig } from "./config";

const responseHeaders = ["content-type", "cache-control", "x-request-id"] as const;

function upstreamHeaders(c: Context, config: ProxyConfig): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  const clientAuthorization = c.req.header("authorization");
  if (config.apiKey) {
    headers.set("authorization", `Bearer ${config.apiKey}`);
  } else if (config.allowClientKey && clientAuthorization) {
    headers.set("authorization", clientAuthorization);
  }
  return headers;
}

async function fetchUpstream(
  c: Context,
  config: ProxyConfig,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: upstreamHeaders(c, config),
      signal: timeout,
    });
    const headers = new Headers();
    for (const name of responseHeaders) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    headers.set("x-content-type-options", "nosniff");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upstream error";
    return c.json(apiError("upstream_unavailable", message), 502);
  }
}

export async function proxyModels(c: Context, config: ProxyConfig): Promise<Response> {
  const response = await fetchUpstream(c, config, "/models", { method: "GET" });
  if (!response.ok || config.allowedModels.size === 0) return response;

  const payload = (await response.json()) as { data?: Array<{ id?: string }> };
  payload.data = payload.data?.filter(
    (model) => typeof model.id === "string" && config.allowedModels.has(model.id),
  );
  return c.json(payload);
}

export async function proxyChat(c: Context, config: ProxyConfig): Promise<Response> {
  let input: unknown;
  try {
    input = await c.req.json();
  } catch {
    return c.json(apiError("invalid_json", "Request body must be valid JSON."), 400);
  }

  const parsed = chatCompletionRequestSchema.safeParse(input);
  if (!parsed.success) {
    return c.json(apiError("invalid_request", parsed.error.issues[0]?.message || "Invalid request."), 400);
  }
  if (config.allowedModels.size > 0 && !config.allowedModels.has(parsed.data.model)) {
    return c.json(apiError("model_not_allowed", `Model '${parsed.data.model}' is not allowed.`), 403);
  }

  return fetchUpstream(c, config, "/chat/completions", {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
}
