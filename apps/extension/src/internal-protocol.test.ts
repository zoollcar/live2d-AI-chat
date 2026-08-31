import { BRIDGE_PROTOCOL_VERSION } from "@live2d-chat/shared";
import { describe, expect, it } from "vitest";
import {
  isOffscreenKeepAliveFrame,
  parseBackgroundToOffscreenFrame,
  parseRoutedBridgeFrame,
} from "./internal-protocol";

const hello = {
  type: "hello",
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  webVersion: "1.0.0",
};

describe("internal routing envelope", () => {
  it("accepts a valid client ID and shared protocol message", () => {
    expect(parseRoutedBridgeFrame({ clientId: "client_123", message: hello }))
      .toEqual({ clientId: "client_123", message: hello });
  });

  it("rejects malformed messages before they reach the offscreen executor", () => {
    expect(parseRoutedBridgeFrame({ clientId: "client_123", message: { ...hello, nonce: "short" } })).toBeUndefined();
    expect(parseRoutedBridgeFrame({ clientId: "bad id", message: hello })).toBeUndefined();
  });

  it("accepts only the explicit client disconnect control frame", () => {
    expect(parseBackgroundToOffscreenFrame({ clientId: "client_123", disconnected: true }))
      .toEqual({ clientId: "client_123", disconnected: true });
    expect(parseBackgroundToOffscreenFrame({ clientId: "client_123", disconnected: false })).toBeUndefined();
  });

  it("accepts only the exact offscreen keep-alive control frame", () => {
    expect(isOffscreenKeepAliveFrame({ keepAlive: true })).toBe(true);
    expect(isOffscreenKeepAliveFrame({ keepAlive: true, message: hello })).toBe(false);
  });
});
