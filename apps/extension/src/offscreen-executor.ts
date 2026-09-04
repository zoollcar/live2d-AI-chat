import {
  BRIDGE_CHUNK_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  bridgeProtocolMessageSchema,
  type BridgeProtocolMessage,
} from "@live2d-chat/shared";
import type { Browser } from "wxt/browser";
import { encodeBase64 } from "./base64";
import { RequestBodyCollector } from "./body-collector";
import { ACK_TIMEOUT_MS, MAX_TRANSFER_BYTES } from "./constants";
import {
  parseBackgroundToOffscreenFrame,
  type OffscreenKeepAliveFrame,
  type RoutedBridgeFrame,
} from "./internal-protocol";
import { resolveOperationRequest } from "./operations";

type RequestStartMessage = Extract<BridgeProtocolMessage, { type: "request-start" }>;
type AckMessage = Extract<BridgeProtocolMessage, { type: "ack" }>;

interface PendingAck {
  sequence: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RequestState {
  clientId: string;
  start: RequestStartMessage;
  collector: RequestBodyCollector;
  controller: AbortController;
  pendingAck?: PendingAck;
  running: boolean;
  silent: boolean;
  cancelled: boolean;
  bodylessChunkAcknowledged: boolean;
  responseReader?: ReadableStreamDefaultReader<Uint8Array>;
}

const KEEP_ALIVE_INTERVAL_MS = 20_000;

function requestKey(clientId: string, requestId: string): string {
  return `${clientId}:${requestId}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "Request was cancelled.";
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return "The request failed.";
}

function responseMediaType(response: Response): string | undefined {
  const value = response.headers.get("content-type")?.trim();
  return value ? value.slice(0, 200) : undefined;
}

function responseContentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export class OffscreenExecutor {
  readonly #port: Browser.runtime.Port;
  readonly #requests = new Map<string, RequestState>();
  #keepAliveTimer: ReturnType<typeof setInterval> | undefined;

  constructor(port: Browser.runtime.Port) {
    this.#port = port;
    port.onMessage.addListener((value: unknown) => this.#handle(value));
  }

  dispose(): void {
    for (const state of this.#requests.values()) this.#abort(state, true);
    this.#requests.clear();
    this.#updateKeepAlive();
  }

  #handle(value: unknown): void {
    const frame = parseBackgroundToOffscreenFrame(value);
    if (!frame) return;
    if ("disconnected" in frame) {
      for (const [key, state] of this.#requests) {
        if (state.clientId !== frame.clientId) continue;
        this.#abort(state, true);
        this.#requests.delete(key);
      }
      this.#updateKeepAlive();
      return;
    }
    this.#handleRouted(frame);
  }

  #handleRouted(frame: RoutedBridgeFrame): void {
    const message = frame.message;
    if (message.type === "request-start") {
      this.#start(frame.clientId, message);
      return;
    }
    if (!("requestId" in message) || typeof message.requestId !== "string") return;
    const key = requestKey(frame.clientId, message.requestId);
    const state = this.#requests.get(key);
    if (!state || state.start.nonce !== message.nonce) return;

    if (message.type === "body-chunk") {
      try {
        if (state.start.bodyKind === "none") {
          if (state.bodylessChunkAcknowledged
            || message.sequence !== 0
            || message.data !== ""
            || !message.final) {
            throw new Error("A body-less request only accepts an empty terminal chunk.");
          }
          state.bodylessChunkAcknowledged = true;
          this.#sendRequestAck(state, message.sequence);
          return;
        }
        const result = state.collector.append(message);
        this.#sendRequestAck(state, result.sequence);
        if (result.final) void this.#execute(key, state);
      } catch (error) {
        this.#failAndDelete(key, state, "invalid-request-body", safeErrorMessage(error), false);
      }
      return;
    }
    if (message.type === "ack" && message.channel === "response") {
      this.#resolveAck(state, message);
      return;
    }
    if (message.type === "cancel") {
      state.cancelled = true;
      this.#abort(state, false);
      if (!state.running) {
        this.#requests.delete(key);
        this.#updateKeepAlive();
        this.#sendError(state, "cancelled", "Request was cancelled.", false);
      }
    }
  }

  #start(clientId: string, start: RequestStartMessage): void {
    const key = requestKey(clientId, start.requestId);
    if (this.#requests.has(key)) {
      this.#send(clientId, {
        type: "error",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        nonce: start.nonce,
        requestId: start.requestId,
        code: "duplicate-request",
        message: "Request ID is already active in the executor.",
        retryable: false,
      });
      return;
    }
    try {
      const state: RequestState = {
        clientId,
        start,
        collector: new RequestBodyCollector(start),
        controller: new AbortController(),
        running: false,
        silent: false,
        cancelled: false,
        bodylessChunkAcknowledged: false,
      };
      this.#requests.set(key, state);
      this.#updateKeepAlive();
      if (start.bodyKind === "none") {
        state.collector.finishBodyless();
        void this.#execute(key, state);
      }
    } catch (error) {
      this.#send(clientId, {
        type: "error",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        nonce: start.nonce,
        requestId: start.requestId,
        code: "invalid-request",
        message: safeErrorMessage(error),
        retryable: false,
      });
    }
  }

  async #execute(key: string, state: RequestState): Promise<void> {
    if (state.running || state.controller.signal.aborted) return;
    state.running = true;
    try {
      const resolved = resolveOperationRequest(state.start, state.collector.toBytes());
      const body = typeof resolved.body === "string"
        ? resolved.body
        : resolved.body
          ? new Blob([Uint8Array.from(resolved.body).buffer])
          : undefined;
      const response = await fetch(resolved.url, {
        method: resolved.method,
        headers: resolved.headers,
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal: state.controller.signal,
      });
      if (response.status < 100 || (response.status >= 300 && response.status < 400)) {
        throw new Error("Cross-origin redirects are blocked; grant the final origin and use its canonical URL.");
      }

      const contentLength = responseContentLength(response);
      if (contentLength !== undefined && contentLength > MAX_TRANSFER_BYTES) {
        throw new Error("Response exceeds the extension transfer limit.");
      }
      this.#send(state.clientId, {
        type: "response-head",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        nonce: state.start.nonce,
        requestId: state.start.requestId,
        status: response.status,
        statusText: response.statusText.slice(0, 500),
        mediaType: responseMediaType(response),
        contentLength,
      });

      if (response.body) await this.#streamResponse(state, response.body);
      if (!state.silent && !state.controller.signal.aborted) {
        this.#send(state.clientId, {
          type: "end",
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          nonce: state.start.nonce,
          requestId: state.start.requestId,
        });
      }
    } catch (error) {
      if (!state.silent) {
        const cancelled = state.cancelled;
        this.#sendError(
          state,
          cancelled ? "cancelled" : "request-failed",
          cancelled ? "Request was cancelled." : safeErrorMessage(error),
          !cancelled,
        );
      }
    } finally {
      this.#clearPendingAck(state, new Error("Request finished before an acknowledgement arrived."));
      this.#requests.delete(key);
      this.#updateKeepAlive();
    }
  }

  async #streamResponse(state: RequestState, stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    state.responseReader = reader;
    let sequence = 0;
    let transferred = 0;
    try {
      while (true) {
        if (state.controller.signal.aborted) {
          await reader.cancel();
          return;
        }
        const { done, value } = await reader.read();
        if (done) return;
        if (state.controller.signal.aborted) {
          await reader.cancel();
          return;
        }
        for (let offset = 0; offset < value.byteLength; offset += BRIDGE_CHUNK_BYTES) {
          const chunk = value.subarray(offset, Math.min(offset + BRIDGE_CHUNK_BYTES, value.byteLength));
          transferred += chunk.byteLength;
          if (transferred > MAX_TRANSFER_BYTES) throw new Error("Response exceeds the extension transfer limit.");
          const ack = this.#waitForAck(state, sequence);
          try {
            this.#send(state.clientId, {
              type: "response-chunk",
              protocolVersion: BRIDGE_PROTOCOL_VERSION,
              nonce: state.start.nonce,
              requestId: state.start.requestId,
              sequence,
              data: encodeBase64(chunk),
              encoding: "base64",
            });
          } catch (error) {
            this.#clearPendingAck(
              state,
              error instanceof Error ? error : new Error("Unable to send a response chunk."),
            );
          }
          await ack;
          sequence += 1;
        }
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      if (state.responseReader === reader) state.responseReader = undefined;
      reader.releaseLock();
    }
  }

  #waitForAck(state: RequestState, sequence: number): Promise<void> {
    if (state.pendingAck) throw new Error("Only one response chunk may be in flight.");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingAck = undefined;
        reject(new Error("Timed out waiting for a response chunk acknowledgement."));
        state.controller.abort();
      }, ACK_TIMEOUT_MS);
      state.pendingAck = { sequence, resolve, reject, timeout };
    });
  }

  #resolveAck(state: RequestState, message: AckMessage): void {
    const pending = state.pendingAck;
    if (!pending || pending.sequence !== message.sequence) return;
    clearTimeout(pending.timeout);
    state.pendingAck = undefined;
    pending.resolve();
  }

  #clearPendingAck(state: RequestState, error: Error): void {
    const pending = state.pendingAck;
    if (!pending) return;
    clearTimeout(pending.timeout);
    state.pendingAck = undefined;
    pending.reject(error);
  }

  #abort(state: RequestState, silent: boolean): void {
    state.silent ||= silent;
    state.controller.abort();
    void state.responseReader?.cancel().catch(() => undefined);
    this.#clearPendingAck(state, new DOMException("Request was cancelled.", "AbortError"));
  }

  #failAndDelete(key: string, state: RequestState, code: string, message: string, retryable: boolean): void {
    this.#abort(state, true);
    this.#requests.delete(key);
    this.#updateKeepAlive();
    this.#sendError(state, code, message, retryable);
  }

  #sendRequestAck(state: RequestState, sequence: number): void {
    this.#send(state.clientId, {
      type: "ack",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce: state.start.nonce,
      requestId: state.start.requestId,
      channel: "request",
      sequence,
    });
  }

  #updateKeepAlive(): void {
    if (this.#requests.size > 0 && this.#keepAliveTimer === undefined) {
      this.#keepAliveTimer = setInterval(() => {
        try {
          this.#port.postMessage({ keepAlive: true } satisfies OffscreenKeepAliveFrame);
        } catch {
          this.dispose();
        }
      }, KEEP_ALIVE_INTERVAL_MS);
      return;
    }
    if (this.#requests.size === 0 && this.#keepAliveTimer !== undefined) {
      clearInterval(this.#keepAliveTimer);
      this.#keepAliveTimer = undefined;
    }
  }

  #sendError(state: RequestState, code: string, message: string, retryable: boolean): void {
    try {
      this.#send(state.clientId, {
        type: "error",
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        nonce: state.start.nonce,
        requestId: state.start.requestId,
        code,
        message,
        retryable,
      });
    } catch {
      state.silent = true;
    }
  }

  #send(clientId: string, message: BridgeProtocolMessage): void {
    const parsed = bridgeProtocolMessageSchema.parse(message);
    this.#port.postMessage({ clientId, message: parsed });
  }
}
