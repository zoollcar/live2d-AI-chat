import {
  BRIDGE_CHUNK_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeProtocolMessage,
} from "@live2d-chat/shared";
import type { Browser } from "wxt/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase64, encodeBase64 } from "./base64";
import { OffscreenExecutor } from "./offscreen-executor";

type RequestStartMessage = Extract<BridgeProtocolMessage, { type: "request-start" }>;
type RoutedValue = { clientId: string; message: BridgeProtocolMessage };

const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
const clientId = "client_123";

class FakePort {
  readonly posted: unknown[] = [];
  readonly #listeners = new Set<(value: unknown) => void>();

  readonly onMessage = {
    addListener: (listener: (value: unknown) => void) => this.#listeners.add(listener),
  };

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  emit(message: BridgeProtocolMessage): void {
    for (const listener of this.#listeners) listener({ clientId, message });
  }

  messages(): BridgeProtocolMessage[] {
    return this.posted
      .filter((value): value is RoutedValue => Boolean(value && typeof value === "object" && "message" in value))
      .map((value) => value.message);
  }
}

function start(overrides: Partial<RequestStartMessage> = {}): RequestStartMessage {
  return {
    type: "request-start",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    nonce,
    requestId: "request-1",
    operation: "models",
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    bodyKind: "none",
    totalBytes: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OffscreenExecutor flow control", () => {
  it("acknowledges the web client's empty terminal chunk for a body-less request", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => fetchPromise));

    const port = new FakePort();
    const executor = new OffscreenExecutor(port as unknown as Browser.runtime.Port);
    port.emit(start());
    port.emit({
      type: "body-chunk",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce,
      requestId: "request-1",
      sequence: 0,
      data: "",
      encoding: "base64",
      final: true,
    });

    expect(port.messages()).toContainEqual(expect.objectContaining({
      type: "ack",
      channel: "request",
      sequence: 0,
    }));

    resolveFetch(new Response(null, { status: 204 }));
    await vi.waitFor(() => {
      expect(port.messages()).toContainEqual(expect.objectContaining({ type: "end", requestId: "request-1" }));
    });
    executor.dispose();
  });

  it("keeps at most one 256 KiB response chunk in flight until it is acknowledged", async () => {
    const responseBytes = new Uint8Array(BRIDGE_CHUNK_BYTES + 1);
    responseBytes[0] = 7;
    responseBytes[responseBytes.length - 1] = 9;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      Uint8Array.from(responseBytes).buffer,
      { status: 200, headers: { "content-type": "application/octet-stream" } },
    )));

    const port = new FakePort();
    const executor = new OffscreenExecutor(port as unknown as Browser.runtime.Port);
    const requestBody = new TextEncoder().encode("{}");
    port.emit(start({ operation: "chat", bodyKind: "json", totalBytes: requestBody.byteLength }));
    port.emit({
      type: "body-chunk",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce,
      requestId: "request-1",
      sequence: 0,
      data: encodeBase64(requestBody),
      encoding: "base64",
      final: true,
    });

    await vi.waitFor(() => {
      expect(port.messages().filter((message) => message.type === "response-chunk")).toHaveLength(1);
    });
    const first = port.messages().find((message) => message.type === "response-chunk");
    expect(first?.type === "response-chunk" && decodeBase64(first.data)).toHaveLength(BRIDGE_CHUNK_BYTES);

    port.emit({
      type: "ack",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce,
      requestId: "request-1",
      channel: "response",
      sequence: 0,
    });
    await vi.waitFor(() => {
      expect(port.messages().filter((message) => message.type === "response-chunk")).toHaveLength(2);
    });
    const second = port.messages().filter((message) => message.type === "response-chunk")[1];
    expect(second?.type === "response-chunk" && decodeBase64(second.data)).toEqual(new Uint8Array([9]));

    port.emit({
      type: "ack",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce,
      requestId: "request-1",
      channel: "response",
      sequence: 1,
    });
    await vi.waitFor(() => {
      expect(port.messages()).toContainEqual(expect.objectContaining({ type: "end", requestId: "request-1" }));
    });
    executor.dispose();
  });

  it("cancels the response reader when a streaming request is cancelled", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200 })));

    const port = new FakePort();
    const executor = new OffscreenExecutor(port as unknown as Browser.runtime.Port);
    port.emit(start());

    await vi.waitFor(() => {
      expect(port.messages()).toContainEqual(expect.objectContaining({
        type: "response-chunk",
        requestId: "request-1",
      }));
    });

    port.emit({
      type: "cancel",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce,
      requestId: "request-1",
    });

    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledOnce();
      expect(port.messages()).toContainEqual(expect.objectContaining({
        type: "error",
        code: "cancelled",
        requestId: "request-1",
      }));
    });
    expect(port.messages()).not.toContainEqual(expect.objectContaining({
      type: "end",
      requestId: "request-1",
    }));
    executor.dispose();
  });
});
