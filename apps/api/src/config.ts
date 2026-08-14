export interface ProxyConfig {
  baseUrl: string;
  apiKey?: string;
  allowedModels: ReadonlySet<string>;
  allowClientKey: boolean;
  allowedOrigins: readonly string[];
  timeoutMs: number;
}

type Environment = Record<string, string | undefined>;

export function loadProxyConfig(env: Environment): ProxyConfig {
  const baseUrl = (env.LLM_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
  const allowedModels = new Set(
    (env.LLM_ALLOWED_MODELS || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
  );

  return {
    baseUrl,
    apiKey: env.LLM_API_KEY || undefined,
    allowedModels,
    allowClientKey: env.LLM_ALLOW_CLIENT_KEY === "true",
    allowedOrigins: (env.CORS_ALLOWED_ORIGINS || "http://localhost:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    timeoutMs: Number(env.LLM_PROXY_TIMEOUT_MS || 120_000),
  };
}
