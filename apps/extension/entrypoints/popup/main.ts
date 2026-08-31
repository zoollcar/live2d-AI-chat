import { browser } from "wxt/browser";
import {
  readConnectedSitePatterns,
  sitePatternFromUrl,
  syncSiteBridgeRegistration,
  writeConnectedSitePatterns,
} from "../../src/site-registration";
import { commonHostPermissions, SITE_BRIDGE_SCRIPT_PATH } from "../../src/constants";
import "./style.css";

const siteOrigin = document.querySelector<HTMLParagraphElement>("#site-origin")!;
const siteStatus = document.querySelector<HTMLParagraphElement>("#site-status")!;
const siteToggle = document.querySelector<HTMLButtonElement>("#site-toggle")!;
const apiOrigin = document.querySelector<HTMLInputElement>("#api-origin")!;
const grantOrigin = document.querySelector<HTMLButtonElement>("#grant-origin")!;
const grantStatus = document.querySelector<HTMLParagraphElement>("#grant-status")!;
const grantedOrigins = document.querySelector<HTMLUListElement>("#granted-origins")!;

let activeTabId: number | undefined;
let activeTabUrl: string | undefined;
let activePattern: string | undefined;
let connected = false;

function exactOrigins(patterns: readonly string[]): string[] {
  const result = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*") || pattern.includes("://*")) continue;
    try {
      result.add(new URL(pattern.slice(0, -2)).origin);
    } catch {
      // Ignore browser-internal patterns.
    }
  }
  return [...result].sort();
}

const builtInOrigins = new Set(exactOrigins(commonHostPermissions));

async function revokeOrigin(origin: string): Promise<void> {
  const pattern = `${origin}/*`;
  const connectedPatterns = await readConnectedSitePatterns();
  if (connectedPatterns.includes(pattern)) {
    const next = await writeConnectedSitePatterns(connectedPatterns.filter((candidate) => candidate !== pattern));
    await syncSiteBridgeRegistration(next);
  }
  const removed = await browser.permissions.remove({ origins: [pattern] });
  if (!removed) throw new Error(`Chrome did not revoke ${origin}.`);
  grantStatus.textContent = `Revoked ${origin}.`;
  await Promise.all([refreshSiteState(), renderGrantedOrigins()]);
}

async function renderGrantedOrigins(): Promise<void> {
  const permissions = await browser.permissions.getAll();
  grantedOrigins.replaceChildren();
  const origins = exactOrigins(permissions.origins ?? []);
  if (origins.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No HTTP(S) origins granted.";
    grantedOrigins.append(item);
    return;
  }
  for (const origin of origins) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = origin;
    item.append(label);
    if (builtInOrigins.has(origin)) {
      const badge = document.createElement("span");
      badge.className = "built-in";
      badge.textContent = "Built in";
      item.append(badge);
    } else {
      const revoke = document.createElement("button");
      revoke.className = "revoke";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await revokeOrigin(origin);
        } catch (error) {
          grantStatus.textContent = error instanceof Error ? error.message : "Unable to revoke origin access.";
          revoke.disabled = false;
        }
      });
      item.append(revoke);
    }
    grantedOrigins.append(item);
  }
}

async function refreshSiteState(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id;
  activeTabUrl = tab?.url;
  if (!activeTabUrl || activeTabId === undefined) {
    siteOrigin.textContent = "No active browser tab.";
    siteStatus.textContent = "Open the Live2D AI Chat site first.";
    return;
  }
  try {
    activePattern = sitePatternFromUrl(activeTabUrl);
  } catch (error) {
    siteOrigin.textContent = activeTabUrl;
    siteStatus.textContent = error instanceof Error ? error.message : "This page cannot connect.";
    return;
  }

  siteOrigin.textContent = new URL(activeTabUrl).origin;
  const patterns = await readConnectedSitePatterns();
  const permitted = await browser.permissions.contains({ origins: [activePattern] });
  connected = patterns.includes(activePattern) && permitted;
  siteToggle.disabled = false;
  siteToggle.textContent = connected ? "Disconnect this site" : "Connect this site";
  siteToggle.classList.toggle("danger", connected);
  siteStatus.textContent = connected
    ? "Connected. Reload the site if it was already open before connecting."
    : "Not connected. The page cannot use extension privileges.";
}

siteToggle.addEventListener("click", async () => {
  if (!activePattern || activeTabId === undefined || !activeTabUrl) return;
  siteToggle.disabled = true;
  siteStatus.textContent = connected ? "Disconnecting…" : "Requesting permission…";
  try {
    if (connected) {
      const patterns = await readConnectedSitePatterns();
      const next = await writeConnectedSitePatterns(patterns.filter((pattern) => pattern !== activePattern));
      await syncSiteBridgeRegistration(next);
      await browser.permissions.remove({ origins: [activePattern] });
    } else {
      // Permission prompts must be the first asynchronous work triggered by
      // the click so Chrome retains the user gesture for the request.
      const granted = await browser.permissions.request({ origins: [activePattern] });
      if (!granted) throw new Error("Permission was not granted.");
      const patterns = await readConnectedSitePatterns();
      const next = await writeConnectedSitePatterns([...patterns, activePattern]);
      await syncSiteBridgeRegistration(next);
      await browser.scripting.executeScript({
        target: { tabId: activeTabId, frameIds: [0] },
        files: [SITE_BRIDGE_SCRIPT_PATH],
      });
    }
    await Promise.all([refreshSiteState(), renderGrantedOrigins()]);
  } catch (error) {
    siteStatus.textContent = error instanceof Error ? error.message : "Unable to change site access.";
    siteToggle.disabled = false;
  }
});

grantOrigin.addEventListener("click", async () => {
  grantOrigin.disabled = true;
  grantStatus.textContent = "Requesting permission…";
  try {
    const pattern = sitePatternFromUrl(apiOrigin.value.trim());
    const granted = await browser.permissions.request({ origins: [pattern] });
    if (!granted) throw new Error("Permission was not granted.");
    grantStatus.textContent = `Granted ${new URL(pattern.slice(0, -2)).origin}.`;
    await renderGrantedOrigins();
  } catch (error) {
    grantStatus.textContent = error instanceof Error ? error.message : "Unable to grant origin access.";
  } finally {
    grantOrigin.disabled = false;
  }
});

void Promise.all([refreshSiteState(), renderGrantedOrigins()]);
