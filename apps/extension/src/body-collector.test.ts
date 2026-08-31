import {
  BRIDGE_CHUNK_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeProtocolMessage,
} from "@live2d-chat/shared";
import { describe, expect, it } from "vitest";
import { encodeBase64 } from "./base64";
import { RequestBodyCollector } from "./body-collector";

type RequestStartMessage = Extract<BridgeProtocolMessage, { type: "request-start" }>;
type BodyChunkMessage = Extract<BridgeProtocolMessage, { type: "body-chunk" }>;

const nonce = "AAAAAAAAAAAAAAAAAAAAAA";

function start(overrides: Partial<RequestStartMessage> = {}): RequestStartMessage {
  return {
    type: "request-start",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    nonce,
    requestId: "request-1",
    operation: "chat",
    provider: "openai-compatible",
    baseUrl: "https://example.com/v1",
    bodyKind: "json",
    totalBytes: 4,
    ...overrides,
  };
}

function chunk(sequence: number, value: string, final: boolean): BodyChunkMessage {
  return {
    type: "body-chunk",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    nonce,
    requestId: "request-1",
    sequence,
    data: value,
    encoding: "utf8",
    final,
  };
}

describe("RequestBodyCollector", () => {
  it("assembles sequential acknowledged chunks", () => {
    const collector = new RequestBodyCollector(start());
    expect(collector.append(chunk(0, "ab", false))).toEqual({ final: false, sequence: 0 });
    expect(collector.append(chunk(1, "cd", true))).toEqual({ final: true, sequence: 1 });
    expect(new TextDecoder().decode(collector.toBytes())).toBe("abcd");
  });

  it("rejects a sequence gap", () => {
    const collector = new RequestBodyCollector(start());
    expect(() => collector.append(chunk(1, "ab", false))).toThrow("Expected body chunk 0");
  });

  it("rejects a final body whose declared length does not match", () => {
    const collector = new RequestBodyCollector(start({ totalBytes: 5 }));
    expect(() => collector.append(chunk(0, "abcd", true))).toThrow("does not match");
  });

  it("accepts binary base64 up to the protocol chunk limit", () => {
    const bytes = new Uint8Array(BRIDGE_CHUNK_BYTES);
    bytes[0] = 7;
    bytes[bytes.length - 1] = 9;
    const collector = new RequestBodyCollector(start({ bodyKind: "binary", totalBytes: bytes.length }));
    collector.append({ ...chunk(0, encodeBase64(bytes), true), encoding: "base64" });
    const result = collector.toBytes();
    expect(result).toHaveLength(bytes.length);
    expect(result[0]).toBe(7);
    expect(result[result.length - 1]).toBe(9);
  });

  it("does not accept chunks for a body-less request", () => {
    const collector = new RequestBodyCollector(start({ bodyKind: "none", totalBytes: 0 }));
    expect(() => collector.append(chunk(0, "", true))).toThrow("body-less");
    expect(collector.finishBodyless()).toHaveLength(0);
  });

  it("rejects a declared body length for a body-less request", () => {
    expect(() => new RequestBodyCollector(start({ bodyKind: "none", totalBytes: 1 })))
      .toThrow("cannot declare body bytes");
  });
});
