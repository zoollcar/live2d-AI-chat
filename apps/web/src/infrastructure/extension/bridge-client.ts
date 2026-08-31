import {
  BRIDGE_CHUNK_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  bridgeProtocolMessageSchema,
  type BridgeOperation,
  type BridgeProtocolMessage,
  type BridgeProvider,
} from "@live2d-chat/shared";
import { useExtensionStore } from "./store";

const WEB_SOURCE = "live2d-chat-web";
const EXTENSION_SOURCE = "live2d-chat-extension";
const HANDSHAKE_TIMEOUT_MS = 2_500;
const REQUEST_ACK_TIMEOUT_MS = 5_000;

class BridgeConnectionError extends Error {
  readonly status: "not-detected" | "outdated" | "permission-denied" | "disconnected" | "error";

  constructor(
    status: BridgeConnectionError["status"],
    message: string,
  ) {
    super(message);
    this.name = "BridgeConnectionError";
    this.status = status;
  }
}

interface PendingRequest {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  response: Deferred<Response>;
  head?: Extract<BridgeProtocolMessage, { type: "response-head" }>;
  expectedSequence: number;
  requestAcks: Map<number, Deferred<void>>;
  cleanup(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

export interface ExtensionFetchOptions {
  operation: BridgeOperation;
  provider: BridgeProvider;
  baseUrl?: string;
  apiKey?: string;
  mediaType?: string;
}

function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createRequestId(): string {
  return crypto.randomUUID?.() ?? `request-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class ExtensionBridgeClient {
  private readonly nonce = createNonce();
  private ready?: Extract<BridgeProtocolMessage, { type: "ready" }>;
  private handshake?: Promise<Extract<BridgeProtocolMessage, { type: "ready" }>>;
  private handshakeResolver?: Deferred<Extract<BridgeProtocolMessage, { type: "ready" }>>;
  private handshakeTimer?: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor() {
    window.addEventListener("message", this.handleWindowMessage);
  }

  async connect(): Promise<Extract<BridgeProtocolMessage, { type: "ready" }>> {
    if (this.ready) return this.ready;
    if (this.handshake) return this.handshake;

    const resolver = deferred<Extract<BridgeProtocolMessage, { type: "ready" }>>();
    this.handshakeResolver = resolver;
    this.handshakeTimer = window.setTimeout(() => {
      resolver.reject(new BridgeConnectionError(
        "not-detected",
        "The Live2D companion extension did not answer. Connect this site from the extension popup, then retry.",
      ));
    }, HANDSHAKE_TIMEOUT_MS);
    const handshake: Promise<Extract<BridgeProtocolMessage, { type: "ready" }>> = resolver.promise.catch((error) => {
      const bridgeError = error instanceof BridgeConnectionError
        ? error
        : new BridgeConnectionError("error", error instanceof Error ? error.message : String(error));
      useExtensionStore.getState().setStatus(bridgeError.status, bridgeError.message);
      if (this.handshake === handshake) {
        this.clearHandshakeTimer();
        this.handshake = undefined;
      }
      if (this.handshakeResolver === resolver) this.handshakeResolver = undefined;
      throw bridgeError;
    });
    this.handshake = handshake;

    this.post({
      type: "hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce: this.nonce,
      webVersion: typeof __APP_VERSION__ === "undefined" ? "development" : __APP_VERSION__,
    });
    return this.handshake;
  }

  async fetch(input: RequestInfo | URL, init: RequestInit | undefined, options: ExtensionFetchOptions): Promise<Response> {
    await this.connect();
    const request = new Request(input, init);
    const bytes = request.method === "GET" || request.method === "HEAD"
      ? new Uint8Array()
      : new Uint8Array(await request.clone().arrayBuffer());
    const requestId = createRequestId();
    const responseResolver = deferred<Response>();
    const cleanupAbort = () => request.signal.removeEventListener("abort", onAbort);
    const pending: PendingRequest = {
      response: responseResolver,
      expectedSequence: 0,
      requestAcks: new Map(),
      cleanup: cleanupAbort,
    };
    this.pending.set(requestId, pending);

    const onAbort = () => {
      this.post({
        type: "cancel",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        nonce: this.nonce,
        requestId,
      });
      const error = request.signal.reason instanceof Error ? request.signal.reason : new DOMException("The request was aborted.", "AbortError");
      responseResolver.reject(error);
      pending.controller?.error(error);
      this.finish(requestId);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) {
      onAbort();
      return responseResolver.promise;
    }

    const bodyKind = bytes.byteLength === 0
      ? "none"
      : request.headers.get("content-type")?.includes("json")
        ? "json"
        : options.mediaType?.startsWith("text/") ? "text" : "binary";
    this.post({
      type: "request-start",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce: this.nonce,
      requestId,
      operation: options.operation,
      provider: options.provider,
      baseUrl: options.baseUrl,
      credential: options.apiKey ? { value: options.apiKey } : undefined,
      bodyKind,
      mediaType: options.mediaType ?? request.headers.get("content-type") ?? undefined,
      totalBytes: bytes.byteLength,
    });

    try {
      if (bytes.byteLength === 0) {
        await this.sendBodyChunk(pending, requestId, 0, new Uint8Array(), true);
      } else {
        let sequence = 0;
        for (let offset = 0; offset < bytes.byteLength; offset += BRIDGE_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, Math.min(offset + BRIDGE_CHUNK_BYTES, bytes.byteLength));
          await this.sendBodyChunk(pending, requestId, sequence, chunk, offset + chunk.byteLength === bytes.byteLength);
          sequence += 1;
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("The extension stopped accepting request data.");
      this.post({
        type: "cancel",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        nonce: this.nonce,
        requestId,
      });
      this.fail(requestId, failure);
      return responseResolver.promise;
    }

    return responseResolver.promise;
  }

  disconnect(): void {
    this.invalidateConnection(new BridgeConnectionError(
      "disconnected",
      "The companion extension disconnected.",
    ));
  }

  dispose(): void {
    window.removeEventListener("message", this.handleWindowMessage);
    this.disconnect();
  }

  private async sendBodyChunk(
    pending: PendingRequest,
    requestId: string,
    sequence: number,
    bytes: Uint8Array,
    final: boolean,
  ): Promise<void> {
    const ack = deferred<void>();
    pending.requestAcks.set(sequence, ack);
    const timeout = window.setTimeout(() => {
      ack.reject(new Error("Timed out waiting for the extension to acknowledge request data."));
    }, REQUEST_ACK_TIMEOUT_MS);
    this.post({
      type: "body-chunk",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce: this.nonce,
      requestId,
      sequence,
      data: encodeBase64(bytes),
      encoding: "base64",
      final,
    });
    try {
      await ack.promise;
    } finally {
      window.clearTimeout(timeout);
      pending.requestAcks.delete(sequence);
    }
  }

  private readonly handleWindowMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const envelope = event.data as { source?: unknown; message?: unknown } | null;
    if (!envelope || envelope.source !== EXTENSION_SOURCE) return;
    const rawMessage = envelope.message as { type?: unknown; nonce?: unknown; protocolVersion?: unknown } | null;
    if (rawMessage?.type === "ready"
      && rawMessage.nonce === this.nonce
      && rawMessage.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      this.invalidateConnection(new BridgeConnectionError(
        "outdated",
        "The companion extension uses an incompatible bridge protocol. Update or reload the extension.",
      ));
      return;
    }
    const parsed = bridgeProtocolMessageSchema.safeParse(envelope.message);
    if (!parsed.success || parsed.data.nonce !== this.nonce) return;
    const message = parsed.data;

    if (message.type === "ready") {
      this.ready = message;
      this.clearHandshakeTimer();
      this.handshakeResolver?.resolve(message);
      this.handshakeResolver = undefined;
      useExtensionStore.getState().replace({
        status: "ready",
        extensionVersion: message.extensionVersion,
        protocolVersion: message.protocolVersion,
        capabilities: message.capabilities,
        grantedOrigins: message.grantedOrigins,
      });
      return;
    }
    if (message.type === "ping") {
      this.post(message);
      return;
    }
    if (message.type === "error" && !message.requestId) {
      this.invalidateConnection(new BridgeConnectionError(
        message.code === "site-not-authorized" ? "permission-denied" : "disconnected",
        message.message,
      ));
      return;
    }
    if (!("requestId" in message) || !message.requestId) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    if (message.type === "ack" && message.channel === "request") {
      pending.requestAcks.get(message.sequence)?.resolve();
      pending.requestAcks.delete(message.sequence);
      return;
    }
    if (message.type === "response-head") {
      pending.head = message;
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          pending.controller = controller;
        },
        cancel: () => {
          this.post({
            type: "cancel",
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            nonce: this.nonce,
            requestId: message.requestId,
          });
        },
      });
      pending.response.resolve(new Response(body, {
        status: message.status,
        statusText: message.statusText,
        headers: {
          ...(message.mediaType ? { "content-type": message.mediaType } : {}),
          ...(message.contentLength === undefined ? {} : { "content-length": String(message.contentLength) }),
        },
      }));
      return;
    }
    if (message.type === "response-chunk") {
      if (message.sequence !== pending.expectedSequence) {
        this.fail(message.requestId, new Error("The extension response arrived out of order."));
        return;
      }
      const bytes = message.encoding === "base64"
        ? decodeBase64(message.data)
        : new TextEncoder().encode(message.data);
      pending.controller?.enqueue(bytes);
      pending.expectedSequence += 1;
      this.post({
        type: "ack",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        nonce: this.nonce,
        requestId: message.requestId,
        channel: "response",
        sequence: message.sequence,
      });
      return;
    }
    if (message.type === "end") {
      if (!pending.head) {
        this.fail(message.requestId, new Error("The extension ended the request before sending response metadata."));
        return;
      }
      pending.controller?.close();
      this.finish(message.requestId);
      return;
    }
    if (message.type === "error") {
      if (message.code === "permission_required") {
        useExtensionStore.getState().setStatus("permission-required", message.message);
      }
      this.fail(message.requestId, new Error(message.message));
      if (message.code === "extension-disconnected" || message.code === "offscreen-disconnected") {
        this.invalidateConnection(new BridgeConnectionError("disconnected", message.message));
      }
    }
  };

  private post(message: BridgeProtocolMessage): void {
    window.postMessage({ source: WEB_SOURCE, message }, window.location.origin);
  }

  private finish(requestId: string): void {
    const pending = this.pending.get(requestId);
    pending?.cleanup();
    this.pending.delete(requestId);
  }

  private fail(requestId: string, error: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    pending.response.reject(error);
    pending.controller?.error(error);
    for (const ack of pending.requestAcks.values()) ack.reject(error);
    pending.requestAcks.clear();
    this.finish(requestId);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === undefined) return;
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private invalidateConnection(error: BridgeConnectionError): void {
    this.ready = undefined;
    this.clearHandshakeTimer();
    const resolver = this.handshakeResolver;
    this.handshakeResolver = undefined;
    this.handshake = undefined;
    resolver?.reject(error);
    for (const requestId of [...this.pending.keys()]) this.fail(requestId, error);
    useExtensionStore.getState().setStatus(error.status, error.message);
  }
}

declare const __APP_VERSION__: string;

export const extensionBridge = new ExtensionBridgeClient();

export function createExtensionFetch(options: ExtensionFetchOptions): typeof fetch {
  return (input, init) => extensionBridge.fetch(input, init, options);
}
