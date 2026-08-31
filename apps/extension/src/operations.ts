import type { BridgeProtocolMessage, BridgeProvider } from "@live2d-chat/shared";
import { z } from "zod";

type RequestStartMessage = Extract<BridgeProtocolMessage, { type: "request-start" }>;

export interface ResolvedOperationRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

const providerBaseUrls: Partial<Record<BridgeProvider, string>> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  minimax: "https://api.minimaxi.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  "google-cloud": "https://texttospeech.googleapis.com/v1",
  exa: "https://api.exa.ai",
  supadata: "https://api.supadata.ai/v1",
};

const operationProviders: Record<RequestStartMessage["operation"], readonly BridgeProvider[]> = {
  models: ["openai-compatible", "openai", "openrouter", "minimax", "google", "google-cloud"],
  chat: ["openai-compatible", "openai", "openrouter", "minimax", "google"],
  transcribe: ["openai-compatible", "openai", "minimax"],
  synthesize: ["openai-compatible", "openai", "minimax", "google-cloud"],
  vision: ["openai-compatible", "openai", "openrouter", "minimax", "google"],
  exa: ["exa"],
  supadata: ["supadata"],
  "read-page": ["extension-reader"],
};

const httpUrlSchema = z.url().max(2_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "URL must use HTTP or HTTPS.");

const exaContentsRequestSchema = z.object({
  urls: z.array(httpUrlSchema).length(1),
  text: z.literal(true),
}).strict();

const supadataRequestSchema = z.union([
  z.object({
    url: z.url().max(2_000),
    lang: z.string().trim().min(2).max(35).optional(),
    text: z.boolean().optional(),
    mode: z.enum(["native", "auto", "generate"]).optional(),
    chunkSize: z.number().int().min(50).max(10_000).optional(),
  }).strict(),
  z.object({
    jobId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/),
  }).strict(),
]);

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error(`${label} cannot contain credentials, a query, or a fragment.`);
  }
  return url;
}

function normalizedBase(value: string): URL {
  const url = parseHttpUrl(value, "Base URL");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

function resolveProviderBase(start: RequestStartMessage): URL {
  if (start.provider === "openai-compatible") {
    if (!start.baseUrl) throw new Error("A base URL is required for an OpenAI-compatible provider.");
    return normalizedBase(start.baseUrl);
  }

  const fixedBase = providerBaseUrls[start.provider];
  if (!fixedBase) throw new Error(`Provider ${start.provider} does not use an API base URL.`);
  const expected = normalizedBase(fixedBase);
  if (start.baseUrl) {
    const supplied = normalizedBase(start.baseUrl);
    if (supplied.origin !== expected.origin || supplied.pathname !== expected.pathname) {
      throw new Error(`Provider ${start.provider} only permits its fixed API base URL.`);
    }
  }
  return expected;
}

function appendFixedPath(base: URL, path: string): URL {
  const result = new URL(base.toString());
  result.pathname = `${base.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  result.search = "";
  result.hash = "";
  return result;
}

function requireProvider(start: RequestStartMessage): void {
  if (!operationProviders[start.operation].includes(start.provider)) {
    throw new Error(`Provider ${start.provider} cannot perform ${start.operation}.`);
  }
}

function credentialHeaders(start: RequestStartMessage): Record<string, string> {
  const value = start.credential?.value;
  if (value && [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  })) {
    throw new Error("Credential contains invalid control characters.");
  }

  if (start.provider === "extension-reader") {
    if (value) throw new Error("read-page does not accept credentials.");
    return {};
  }
  if (start.provider === "openai-compatible") {
    return value ? { Authorization: `Bearer ${value}` } : {};
  }
  if (!value) throw new Error(`Provider ${start.provider} requires a credential.`);
  if (start.provider === "google" || start.provider === "google-cloud") return { "x-goog-api-key": value };
  if (start.provider === "exa" || start.provider === "supadata") return { "x-api-key": value };
  return { Authorization: `Bearer ${value}` };
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Request body must be valid UTF-8 JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request JSON body must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function assertBodyKind(start: RequestStartMessage, expected: RequestStartMessage["bodyKind"]): void {
  if (start.bodyKind !== expected) {
    throw new Error(`${start.operation} requires a ${expected} body.`);
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a = 0, b = 0, c = 0] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  if (hostname === "::" || hostname === "::1" || hostname.startsWith("::ffff:")) return true;
  const firstHextet = Number.parseInt(hostname.split(":", 1)[0] ?? "", 16);
  return Number.isFinite(firstHextet)
    && ((firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
      || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
      || firstHextet >= 0xff00
      || hostname.startsWith("2001:db8:"));
}

export function isPrivateReadPageTarget(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || (!hostname.includes(".") && !hostname.includes(":"))
    || isPrivateIpv6(hostname)
    || isPrivateIpv4(hostname);
}

export function resolveOperationTarget(start: RequestStartMessage): URL {
  requireProvider(start);
  if (start.operation === "read-page") {
    if (!start.baseUrl) throw new Error("read-page requires the exact page URL in baseUrl.");
    const target = new URL(start.baseUrl);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("read-page only supports HTTP and HTTPS URLs.");
    }
    if (target.username || target.password || target.hash) {
      throw new Error("read-page URL cannot contain credentials or a fragment.");
    }
    if (isPrivateReadPageTarget(target)) {
      throw new Error("read-page refuses local and private-network targets.");
    }
    return target;
  }

  const base = resolveProviderBase(start);
  switch (start.operation) {
    case "models": return appendFixedPath(base, start.provider === "google-cloud" ? "voices" : "models");
    case "chat":
    case "vision": return appendFixedPath(base, "chat/completions");
    case "transcribe": return appendFixedPath(base, "audio/transcriptions");
    case "synthesize": return appendFixedPath(base, start.provider === "google-cloud" ? "text:synthesize" : "audio/speech");
    case "exa": return appendFixedPath(base, "contents");
    case "supadata": return appendFixedPath(base, "transcript");
    default: throw new Error("Unsupported bridge operation.");
  }
}

export function originPatternFor(start: RequestStartMessage): string {
  return `${resolveOperationTarget(start).origin}/*`;
}

export function resolveOperationRequest(start: RequestStartMessage, bodyBytes: Uint8Array): ResolvedOperationRequest {
  requireProvider(start);
  const headers: Record<string, string> = {
    Accept: start.operation === "read-page"
      ? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1"
      : start.provider === "google-cloud"
        ? "application/json"
        : start.operation === "synthesize"
          ? "audio/*,application/octet-stream;q=0.9,application/json;q=0.5"
          : "application/json",
    ...credentialHeaders(start),
  };

  if (start.operation === "models" || start.operation === "read-page") {
    assertBodyKind(start, "none");
    return { url: resolveOperationTarget(start).toString(), method: "GET", headers };
  }

  if (start.operation === "supadata") {
    assertBodyKind(start, "json");
    const parsed = supadataRequestSchema.parse(parseJsonObject(bodyBytes));
    const target = resolveOperationTarget(start);
    if ("jobId" in parsed) {
      target.pathname = `${target.pathname.replace(/\/+$/, "")}/${encodeURIComponent(parsed.jobId)}`;
    } else {
      const videoUrl = new URL(parsed.url);
      if (videoUrl.protocol !== "https:" && videoUrl.protocol !== "http:") {
        throw new Error("Supadata video URL must use HTTP or HTTPS.");
      }
      target.searchParams.set("url", videoUrl.toString());
      if (parsed.lang) target.searchParams.set("lang", parsed.lang);
      if (parsed.text !== undefined) target.searchParams.set("text", String(parsed.text));
      if (parsed.mode) target.searchParams.set("mode", parsed.mode);
      if (parsed.chunkSize !== undefined) target.searchParams.set("chunkSize", String(parsed.chunkSize));
    }
    return { url: target.toString(), method: "GET", headers };
  }

  if (start.operation === "exa") {
    assertBodyKind(start, "json");
    const parsed = exaContentsRequestSchema.parse(parseJsonObject(bodyBytes));
    headers["Content-Type"] = "application/json";
    return {
      url: resolveOperationTarget(start).toString(),
      method: "POST",
      headers,
      body: JSON.stringify(parsed),
    };
  }

  if (start.operation === "transcribe") {
    assertBodyKind(start, "binary");
    if (!start.mediaType?.toLowerCase().startsWith("multipart/form-data; boundary=")) {
      throw new Error("transcribe requires a multipart/form-data body with an explicit boundary.");
    }
    headers["Content-Type"] = start.mediaType;
    return {
      url: resolveOperationTarget(start).toString(),
      method: "POST",
      headers,
      body: bodyBytes,
    };
  }

  assertBodyKind(start, "json");
  const json = parseJsonObject(bodyBytes);
  headers["Content-Type"] = "application/json";
  return {
    url: resolveOperationTarget(start).toString(),
    method: "POST",
    headers,
    body: JSON.stringify(json),
  };
}
