import {
  BRIDGE_PROTOCOL_VERSION,
  bridgeOperationIds,
  bridgeProtocolMessageSchema,
  type BridgeProtocolMessage,
} from "@live2d-chat/shared";
import { browser, type Browser } from "wxt/browser";
import { OFFSCREEN_PORT, SITE_BRIDGE_PORT } from "./constants";
import type { BackgroundToOffscreenFrame } from "./internal-protocol";
import { isOffscreenKeepAliveFrame, parseRoutedBridgeFrame } from "./internal-protocol";
import { originPatternFor } from "./operations";
import { readConnectedSitePatterns, sitePatternFromUrl } from "./site-registration";

type HelloMessage = Extract<BridgeProtocolMessage, { type: "hello" }>;
type RequestStartMessage = Extract<BridgeProtocolMessage, { type: "request-start" }>;

interface ClientState {
  id: string;
  port: Browser.runtime.Port;
  nonce?: string;
  authorized: Promise<boolean>;
  serial: Promise<void>;
  requests: Set<string>;
}

function toGrantedOrigins(patterns: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*") || pattern.includes("://*")) continue;
    try {
      origins.add(new URL(pattern.slice(0, -2)).origin);
    } catch {
      // Ignore malformed or browser-specific permission patterns.
    }
  }
  return [...origins].sort();
}

export class OffscreenBroker {
  readonly #clients = new Map<string, ClientState>();
  #offscreenPort: Browser.runtime.Port | undefined;
  #offscreenCreation: Promise<void> | undefined;
  readonly #offscreenWaiters = new Set<(port: Browser.runtime.Port) => void>();

  acceptPort(port: Browser.runtime.Port): void {
    if (port.name === OFFSCREEN_PORT) {
      this.#acceptOffscreenPort(port);
      return;
    }
    if (port.name !== SITE_BRIDGE_PORT) {
      port.disconnect();
      return;
    }
    this.#acceptClientPort(port);
  }

  async reconcileClients(): Promise<void> {
    const connectedPatterns = new Set(await readConnectedSitePatterns());
    await Promise.all([...this.#clients.values()].map(async (client) => {
      const permitted = await this.#isClientAuthorized(client.port, connectedPatterns);
      if (permitted) return;
      try {
        if (client.nonce) {
          client.port.postMessage(this.#error(
            client.nonce,
            "site-not-authorized",
            "This site is no longer connected to the extension.",
            undefined,
            false,
          ));
        }
      } finally {
        client.port.disconnect();
      }
    }));
  }

  #acceptOffscreenPort(port: Browser.runtime.Port): void {
    const expectedUrl = browser.runtime.getURL("/offscreen.html");
    if (port.sender?.url !== expectedUrl) {
      port.disconnect();
      return;
    }
    this.#offscreenPort?.disconnect();
    this.#offscreenPort = port;
    for (const resolve of this.#offscreenWaiters) resolve(port);
    this.#offscreenWaiters.clear();

    port.onMessage.addListener((value: unknown) => {
      if (isOffscreenKeepAliveFrame(value)) return;
      const routed = parseRoutedBridgeFrame(value);
      if (!routed) return;
      const client = this.#clients.get(routed.clientId);
      if (!client?.nonce || routed.message.nonce !== client.nonce) return;
      if (routed.message.type === "end") {
        client.requests.delete(routed.message.requestId);
      } else if (routed.message.type === "error" && routed.message.requestId !== undefined) {
        client.requests.delete(routed.message.requestId);
      }
      client.port.postMessage(routed.message);
    });
    port.onDisconnect.addListener(() => {
      if (this.#offscreenPort !== port) return;
      this.#offscreenPort = undefined;
      for (const client of this.#clients.values()) {
        if (!client.nonce) continue;
        for (const requestId of client.requests) {
          try {
            client.port.postMessage(this.#error(client.nonce, "offscreen-disconnected", "The request executor disconnected.", requestId, true));
          } catch {
            break;
          }
        }
        client.requests.clear();
      }
    });
  }

  #acceptClientPort(port: Browser.runtime.Port): void {
    const clientId = crypto.randomUUID().replaceAll("-", "");
    const client: ClientState = {
      id: clientId,
      port,
      authorized: this.#authorizeClient(port),
      serial: Promise.resolve(),
      requests: new Set(),
    };
    this.#clients.set(clientId, client);

    port.onMessage.addListener((value: unknown) => {
      client.serial = client.serial
        .then(() => this.#handleClientMessage(client, value))
        .catch(() => port.disconnect());
    });
    port.onDisconnect.addListener(() => {
      this.#clients.delete(clientId);
      const frame: BackgroundToOffscreenFrame = { clientId, disconnected: true };
      this.#offscreenPort?.postMessage(frame);
    });
  }

  async #authorizeClient(port: Browser.runtime.Port): Promise<boolean> {
    return this.#isClientAuthorized(port, new Set(await readConnectedSitePatterns()));
  }

  async #isClientAuthorized(port: Browser.runtime.Port, connectedPatterns: ReadonlySet<string>): Promise<boolean> {
    const senderUrl = port.sender?.url;
    if (!senderUrl || port.sender?.frameId !== 0 || port.sender?.tab?.id === undefined) return false;
    let pattern: string;
    try {
      pattern = sitePatternFromUrl(senderUrl);
    } catch {
      return false;
    }
    const permitted = await browser.permissions.contains({ origins: [pattern] });
    return connectedPatterns.has(pattern) && permitted;
  }

  async #handleClientMessage(client: ClientState, value: unknown): Promise<void> {
    const parsed = bridgeProtocolMessageSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    if (!await client.authorized) {
      if (message.type === "hello") {
        client.port.postMessage(this.#error(
          message.nonce,
          "site-not-authorized",
          "Connect this site from the extension popup before using the bridge.",
          undefined,
          false,
        ));
      }
      setTimeout(() => client.port.disconnect(), 0);
      return;
    }

    if (message.type === "hello") {
      await this.#handleHello(client, message);
      return;
    }
    if (!client.nonce || message.nonce !== client.nonce) return;
    if (message.type === "ping") {
      // Receipt itself keeps the MV3 worker active. Do not echo this frame: the
      // web client treats extension-originated pings as challenges and replies.
      return;
    }
    if (message.type === "request-start") {
      await this.#handleRequestStart(client, message);
      return;
    }
    if (message.type === "body-chunk") {
      if (client.requests.has(message.requestId)) await this.#forward(client.id, message);
      return;
    }
    if (message.type === "ack") {
      if (message.channel === "response" && client.requests.has(message.requestId)) {
        await this.#forward(client.id, message);
      }
      return;
    }
    if (message.type === "cancel") {
      if (client.requests.delete(message.requestId)) await this.#forward(client.id, message);
    }
  }

  async #handleHello(client: ClientState, message: HelloMessage): Promise<void> {
    if (client.nonce && client.nonce !== message.nonce) return;
    client.nonce = message.nonce;
    const permissions = await browser.permissions.getAll();
    client.port.postMessage({
      type: "ready",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce: message.nonce,
      extensionVersion: browser.runtime.getManifest().version,
      capabilities: [...bridgeOperationIds],
      grantedOrigins: toGrantedOrigins(permissions.origins ?? []),
    } satisfies BridgeProtocolMessage);
  }

  async #handleRequestStart(client: ClientState, message: RequestStartMessage): Promise<void> {
    if (client.requests.has(message.requestId)) {
      client.port.postMessage(this.#error(message.nonce, "duplicate-request", "Request ID is already active.", message.requestId, false));
      return;
    }

    let requiredPattern: string;
    try {
      requiredPattern = originPatternFor(message);
    } catch (error) {
      client.port.postMessage(this.#error(
        message.nonce,
        "operation-rejected",
        error instanceof Error ? error.message : "Operation is not permitted.",
        message.requestId,
        false,
      ));
      return;
    }
    if (!await browser.permissions.contains({ origins: [requiredPattern] })) {
      client.port.postMessage(this.#error(
        message.nonce,
        "permission_required",
        `Grant access to ${new URL(requiredPattern.slice(0, -2)).origin} from the extension popup.`,
        message.requestId,
        true,
      ));
      return;
    }

    client.requests.add(message.requestId);
    try {
      await this.#forward(client.id, message);
    } catch {
      client.requests.delete(message.requestId);
      client.port.postMessage(this.#error(message.nonce, "executor-unavailable", "The request executor is unavailable.", message.requestId, true));
    }
  }

  async #forward(clientId: string, message: BridgeProtocolMessage): Promise<void> {
    const port = await this.#ensureOffscreenPort();
    port.postMessage({ clientId, message } satisfies BackgroundToOffscreenFrame);
  }

  async #ensureOffscreenPort(): Promise<Browser.runtime.Port> {
    if (this.#offscreenPort) return this.#offscreenPort;
    if (!this.#offscreenCreation) {
      this.#offscreenCreation = (async () => {
        const offscreenUrl = browser.runtime.getURL("/offscreen.html");
        const contexts = await browser.runtime.getContexts({
          contextTypes: ["OFFSCREEN_DOCUMENT" as Browser.runtime.ContextType],
          documentUrls: [offscreenUrl],
        });
        if (contexts.length === 0) {
          await browser.offscreen.createDocument({
            url: offscreenUrl,
            reasons: ["BLOBS"],
            justification: "Create binary request bodies and stream user-authorized response bytes.",
          });
        }
      })().finally(() => {
        this.#offscreenCreation = undefined;
      });
    }
    await this.#offscreenCreation;
    if (this.#offscreenPort) return this.#offscreenPort;

    return new Promise<Browser.runtime.Port>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#offscreenWaiters.delete(onPort);
        reject(new Error("Timed out waiting for the offscreen document."));
      }, 5_000);
      const onPort = (port: Browser.runtime.Port) => {
        clearTimeout(timeout);
        resolve(port);
      };
      this.#offscreenWaiters.add(onPort);
    });
  }

  #error(
    nonce: string,
    code: string,
    message: string,
    requestId: string | undefined,
    retryable: boolean,
  ): BridgeProtocolMessage {
    return {
      type: "error",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce,
      requestId,
      code,
      message,
      retryable,
    };
  }
}
