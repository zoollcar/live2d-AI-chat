import { browser } from "wxt/browser";
import {
  CONNECTED_SITE_PATTERNS_KEY,
  SITE_BRIDGE_SCRIPT_ID,
  SITE_BRIDGE_SCRIPT_PATH,
} from "./constants";

function isExactOriginPattern(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("/*")) return false;
  try {
    const url = new URL(value.slice(0, -2));
    return (url.protocol === "https:" || url.protocol === "http:")
      && url.origin === value.slice(0, -2)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function sitePatternFromUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS pages can connect to the extension.");
  }
  return `${url.origin}/*`;
}

export async function readConnectedSitePatterns(): Promise<string[]> {
  const stored = await browser.storage.local.get(CONNECTED_SITE_PATTERNS_KEY);
  const value = stored[CONNECTED_SITE_PATTERNS_KEY];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isExactOriginPattern))].sort();
}

export async function writeConnectedSitePatterns(patterns: readonly string[]): Promise<string[]> {
  const normalized = [...new Set(patterns.filter(isExactOriginPattern))].sort();
  await browser.storage.local.set({ [CONNECTED_SITE_PATTERNS_KEY]: normalized });
  return normalized;
}

export async function syncSiteBridgeRegistration(patterns: readonly string[]): Promise<void> {
  const normalized = [...new Set(patterns.filter(isExactOriginPattern))].sort();
  const registered = await browser.scripting.getRegisteredContentScripts({ ids: [SITE_BRIDGE_SCRIPT_ID] });
  const exists = registered.length > 0;

  if (normalized.length === 0) {
    if (exists) await browser.scripting.unregisterContentScripts({ ids: [SITE_BRIDGE_SCRIPT_ID] });
    return;
  }

  const definition = {
    id: SITE_BRIDGE_SCRIPT_ID,
    js: [SITE_BRIDGE_SCRIPT_PATH],
    matches: normalized,
    allFrames: false,
    persistAcrossSessions: true,
    runAt: "document_start" as const,
    world: "ISOLATED" as const,
  };
  if (exists) await browser.scripting.updateContentScripts([definition]);
  else await browser.scripting.registerContentScripts([definition]);
}

export async function reconcileSiteBridgeRegistration(): Promise<void> {
  const patterns = await readConnectedSitePatterns();
  const granted: string[] = [];
  for (const pattern of patterns) {
    if (await browser.permissions.contains({ origins: [pattern] })) granted.push(pattern);
  }
  if (granted.length !== patterns.length) await writeConnectedSitePatterns(granted);
  await syncSiteBridgeRegistration(granted);
}
