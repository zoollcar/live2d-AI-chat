export const WEB_MESSAGE_SOURCE = "live2d-chat-web";
export const EXTENSION_MESSAGE_SOURCE = "live2d-chat-extension";

export const SITE_BRIDGE_PORT = "live2d-network-v1";
export const OFFSCREEN_PORT = "live2d-offscreen-v1";
export const SITE_BRIDGE_SCRIPT_ID = "live2d-site-bridge";
export const SITE_BRIDGE_SCRIPT_PATH = "/site-bridge.js";
export const CONNECTED_SITE_PATTERNS_KEY = "connectedSitePatterns";

export const commonHostPermissions = [
  "https://api.openai.com/*",
  "https://openrouter.ai/*",
  "https://api.minimaxi.com/*",
  "https://generativelanguage.googleapis.com/*",
  "https://texttospeech.googleapis.com/*",
  "https://api.exa.ai/*",
  "https://api.supadata.ai/*",
] as const;

export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;
export const ACK_TIMEOUT_MS = 30_000;
