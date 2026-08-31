import { ContentProviderError, type ContentProviderId } from "./provider-error";

const MAX_NETWORK_URL_LENGTH = 2_000;

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b, c] = octets;
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
  const first = Number.parseInt(hostname.split(":", 1)[0] ?? "", 16);
  return Number.isFinite(first)
    && ((first >= 0xfc00 && first <= 0xfdff)
      || (first >= 0xfe80 && first <= 0xfebf)
      || first >= 0xff00
      || hostname.startsWith("2001:db8:"));
}

export function isPrivateNetworkTarget(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || (!hostname.includes(".") && !hostname.includes(":"))
    || isPrivateIpv4(hostname)
    || isPrivateIpv6(hostname);
}

export function parsePublicHttpUrl(value: string, provider: ContentProviderId): URL {
  if (!value.trim() || value.length > MAX_NETWORK_URL_LENGTH) {
    throw new ContentProviderError(provider, "invalid-url", "The source URL is invalid or too long.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContentProviderError(provider, "invalid-url", "The source URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ContentProviderError(provider, "invalid-url", "Only HTTP and HTTPS source URLs are supported.");
  }
  if (url.username || url.password || url.hash) {
    throw new ContentProviderError(
      provider,
      "invalid-url",
      "Source URLs cannot contain credentials or fragments.",
    );
  }
  if (isPrivateNetworkTarget(url)) {
    throw new ContentProviderError(
      provider,
      "private-target",
      "Local and private-network sources are not allowed.",
    );
  }
  return url;
}
