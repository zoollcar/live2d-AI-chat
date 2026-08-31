import {
  BRIDGE_PROTOCOL_VERSION,
  bridgeProtocolMessageSchema,
  type BridgeProtocolMessage,
} from "@live2d-chat/shared";
import { browser, type Browser } from "wxt/browser";
import {
  EXTENSION_MESSAGE_SOURCE,
  SITE_BRIDGE_PORT,
  WEB_MESSAGE_SOURCE,
} from "../src/constants";

type HelloMessage = Extract<BridgeProtocolMessage, { type: "hello" }>;

interface BridgeEnvelope {
  source: string;
  message: BridgeProtocolMessage;
}

type BridgeGlobal = typeof globalThis & {
  __live2dChatBridgeV1?: boolean;
};

const pageToExtensionTypes = new Set<BridgeProtocolMessage["type"]>([
  "hello",
  "request-start",
  "body-chunk",
  "ack",
  "cancel",
  "ping",
]);

const extensionToPageTypes = new Set<BridgeProtocolMessage["type"]>([
  "ready",
  "response-head",
  "response-chunk",
  "ack",
  "end",
  "error",
  "ping",
]);

export default defineUnlistedScript(() => {
  const bridgeGlobal = globalThis as BridgeGlobal;
  if (bridgeGlobal.__live2dChatBridgeV1) return;
  bridgeGlobal.__live2dChatBridgeV1 = true;

  let activeNonce: string | undefined;
  let helloMessage: HelloMessage | undefined;
  let port: Browser.runtime.Port | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const activeRequests = new Set<string>();

  function postToPage(message: BridgeProtocolMessage): void {
    const envelope: BridgeEnvelope = { source: EXTENSION_MESSAGE_SOURCE, message };
    window.postMessage(envelope, window.location.origin);
  }

  function disconnectedError(requestId: string): BridgeProtocolMessage {
    return {
      type: "error",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce: activeNonce!,
      requestId,
      code: "extension-disconnected",
      message: "The extension bridge disconnected while the request was active.",
      retryable: true,
    };
  }

  function disconnectedGlobalError(): BridgeProtocolMessage {
    return {
      type: "error",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce: activeNonce!,
      code: "extension-disconnected",
      message: "The extension bridge disconnected. Reconnecting…",
      retryable: true,
    };
  }

  function handleExtensionMessage(value: unknown): void {
    const parsed = bridgeProtocolMessageSchema.safeParse(value);
    if (!parsed.success || !activeNonce) return;
    const message = parsed.data;
    if (message.nonce !== activeNonce || !extensionToPageTypes.has(message.type)) return;
    if (message.type === "error" && message.code === "site-not-authorized" && message.requestId === undefined) {
      for (const requestId of activeRequests) postToPage({ ...message, requestId });
      activeRequests.clear();
      postToPage(message);
      stopBridge();
      return;
    }
    if (message.type === "end") {
      activeRequests.delete(message.requestId);
    } else if (message.type === "error" && message.requestId !== undefined) {
      activeRequests.delete(message.requestId);
    }
    postToPage(message);
  }

  function scheduleReconnect(): void {
    if (stopped || !helloMessage || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connectPort();
    }, 500);
  }

  function connectPort(): Browser.runtime.Port | undefined {
    if (stopped) return undefined;
    if (port) return port;
    try {
      const nextPort = browser.runtime.connect({ name: SITE_BRIDGE_PORT });
      port = nextPort;
      nextPort.onMessage.addListener(handleExtensionMessage);
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) return;
        port = undefined;
        if (stopped) return;
        for (const requestId of activeRequests) postToPage(disconnectedError(requestId));
        activeRequests.clear();
        if (activeNonce) postToPage(disconnectedGlobalError());
        scheduleReconnect();
      });
      if (helloMessage) nextPort.postMessage(helloMessage);
      return nextPort;
    } catch {
      scheduleReconnect();
      return undefined;
    }
  }

  function handlePageMessage(event: MessageEvent): void {
    if (stopped) return;
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (!event.data || typeof event.data !== "object") return;
    const envelope = event.data as Partial<BridgeEnvelope>;
    if (envelope.source !== WEB_MESSAGE_SOURCE) return;

    const parsed = bridgeProtocolMessageSchema.safeParse(envelope.message);
    if (!parsed.success || !pageToExtensionTypes.has(parsed.data.type)) return;
    const message = parsed.data;

    if (message.type === "hello") {
      if (activeNonce && activeNonce !== message.nonce) return;
      activeNonce = message.nonce;
      helloMessage = message;
    } else if (!activeNonce || message.nonce !== activeNonce) {
      return;
    }

    if (message.type === "request-start") activeRequests.add(message.requestId);
    if (message.type === "cancel") activeRequests.delete(message.requestId);
    connectPort()?.postMessage(message);
  }

  function stopBridge(): void {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    window.removeEventListener("message", handlePageMessage);
    const currentPort = port;
    port = undefined;
    currentPort?.disconnect();
    bridgeGlobal.__live2dChatBridgeV1 = false;
  }

  window.addEventListener("message", handlePageMessage);
});
