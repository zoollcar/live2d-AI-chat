import { apiError, chatCompletionRequestSchema } from "@live2d-chat/shared";
import type { Context } from "hono";
import { findUpstream, type ProxyConfig, type ProxyUpstream } from "./config";

const responseHeaders = ["content-type", "cache-control", "x-request-id"] as const;

function resolveUpstreamOrError(
  c: Context,
  config: ProxyConfig,
): { upstream: ProxyUpstream } | { response: Response } {
  if (config.upstreams.size === 0) {
    return {
      response: c.json(
        apiError("no_upstreams_configured", "The proxy has no upstreams configured."),
        503,
      ),
    };
  }
  const requested = c.req.header("x-llm-base-url");
  if (!requested) {
    return {
      response: c.json(
        apiError("missing_upstream", "Pass the upstream URL via the X-LLM-Base-URL header."),
        400,
      ),
    };
  }
  const upstream = findUpstream(config, requested);
  if (!upstream) {
    return {
      response: c.json(
        apiError("upstream_not_allowed", `Upstream '${requested}' is not on the proxy allow list.`),
        403,
      ),
    };
  }
  return { upstream };
}

function upstreamHeaders(c: Context): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  const clientAuthorization = c.req.header("authorization");
  if (clientAuthorization) headers.set("authorization", clientAuthorization);
  return headers;
}

async function fetchUpstream(
  c: Context,
  config: ProxyConfig,
  upstream: ProxyUpstream,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(`${upstream.baseUrl}${path}`, {
      ...init,
      headers: upstreamHeaders(c),
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
  const resolved = resolveUpstreamOrError(c, config);
  if ("response" in resolved) return resolved.response;
  return fetchUpstream(c, config, resolved.upstream, "/models", { method: "GET" });
}

export async function proxyChat(c: Context, config: ProxyConfig): Promise<Response> {
  const resolved = resolveUpstreamOrError(c, config);
  if ("response" in resolved) return resolved.response;

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

  return fetchUpstream(c, config, resolved.upstream, "/chat/completions", {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
}
