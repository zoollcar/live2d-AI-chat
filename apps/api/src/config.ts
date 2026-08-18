export interface ProxyUpstream {
  id: string;
  baseUrl: string;
}

export interface ProxyConfig {
  upstreams: ReadonlyMap<string, ProxyUpstream>;
  allowedOrigins: readonly string[];
  timeoutMs: number;
}

type Environment = Record<string, string | undefined>;

function parseUpstreams(raw: string | undefined): Map<string, ProxyUpstream> {
  const upstreams = new Map<string, ProxyUpstream>();
  if (!raw) return upstreams;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [id, url] = trimmed.split("=", 2).map((part) => part.trim());
    if (!id || !url) continue;
    upstreams.set(id, { id, baseUrl: url.replace(/\/+$/, "") });
  }
  return upstreams;
}

export function loadProxyConfig(env: Environment): ProxyConfig {
  const upstreams = parseUpstreams(env.LLM_PROXY_UPSTREAMS);
  return {
    upstreams,
    allowedOrigins: (env.CORS_ALLOWED_ORIGINS || "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    timeoutMs: Number(env.LLM_PROXY_TIMEOUT_MS || 120_000),
  };
}

export function findUpstream(config: ProxyConfig, baseUrl: string): ProxyUpstream | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) return undefined;
  for (const upstream of config.upstreams.values()) {
    if (upstream.baseUrl === normalized) return upstream;
  }
  return undefined;
}
