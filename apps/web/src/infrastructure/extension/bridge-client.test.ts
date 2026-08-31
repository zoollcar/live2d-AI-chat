// @vitest-environment jsdom

import {
  BRIDGE_PROTOCOL_VERSION,
  bridgeOperationIds,
  bridgeProtocolMessageSchema,
  type BridgeProtocolMessage,
} from "@live2d-chat/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionBridgeClient } from "./bridge-client";
import { useExtensionStore } from "./store";

const EXTENSION_SOURCE = "live2d-chat-extension";

function parsedPostedMessages(spy: ReturnType<typeof vi.spyOn>): BridgeProtocolMessage[] {
  return (spy.mock.calls as unknown[][]).flatMap((call: unknown[]) => {
    const envelope = call[0] as { message?: unknown } | undefined;
    const parsed = bridgeProtocolMessageSchema.safeParse(envelope?.message);
    return parsed.success ? [parsed.data] : [];
  });
}

function dispatchExtensionMessage(message: unknown): void {
  window.dispatchEvent(new MessageEvent("message", {
    data: { source: EXTENSION_SOURCE, message },
    origin: window.location.origin,
    source: window,
  }));
}

function readyMessage(nonce: string): BridgeProtocolMessage {
  return {
    type: "ready",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    nonce,
    extensionVersion: "1.0.0",
    capabilities: [...bridgeOperationIds],
    grantedOrigins: ["https://api.openai.com"],
  };
}

async function connectClient(
  client: ExtensionBridgeClient,
  postMessage: ReturnType<typeof vi.spyOn>,
): Promise<string> {
  const connecting = client.connect();
  const hello = [...parsedPostedMessages(postMessage)].reverse().find((message) => message.type === "hello");
  if (!hello || hello.type !== "hello") throw new Error("Expected a bridge hello frame.");
  dispatchExtensionMessage(readyMessage(hello.nonce));
  await connecting;
  return hello.nonce;
}

describe("ExtensionBridgeClient", () => {
  let client: ExtensionBridgeClient;
  let postMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    useExtensionStore.getState().reset();
    postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    client = new ExtensionBridgeClient();
  });

  afterEach(() => {
    client.dispose();
    postMessage.mockRestore();
    useExtensionStore.getState().reset();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("invalidates cached readiness after site permission is revoked and handshakes again", async () => {
    const nonce = await connectClient(client, postMessage);
    const initialHelloCount = parsedPostedMessages(postMessage).filter((message) => message.type === "hello").length;

    dispatchExtensionMessage({
      type: "error",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      nonce,
      code: "site-not-authorized",
      message: "This site is no longer connected to the extension.",
      retryable: false,
    });
    expect(useExtensionStore.getState().status).toBe("permission-denied");

    const reconnecting = client.connect();
    const messages = parsedPostedMessages(postMessage);
    expect(messages.filter((message) => message.type === "hello")).toHaveLength(initialHelloCount + 1);
    dispatchExtensionMessage(readyMessage(nonce));
    await expect(reconnecting).resolves.toMatchObject({ type: "ready" });
  });

  it("rejects an incompatible ready frame as outdated instead of caching it", async () => {
    const connecting = client.connect();
    const hello = parsedPostedMessages(postMessage).find((message) => message.type === "hello");
    if (!hello || hello.type !== "hello") throw new Error("Expected a bridge hello frame.");
    const rejection = expect(connecting).rejects.toThrow("incompatible bridge protocol");

    dispatchExtensionMessage({ ...readyMessage(hello.nonce), protocolVersion: 2 });

    await rejection;
    expect(useExtensionStore.getState().status).toBe("outdated");
  });

  it("times out request-body ACK waits when the content bridge disappears silently", async () => {
    await connectClient(client, postMessage);
    const fetching = client.fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
    }, {
      operation: "chat",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "session-only-secret",
      mediaType: "application/json",
    });
    const rejection = expect(fetching).rejects.toThrow("acknowledge request data");
    await vi.waitFor(() => {
      expect(parsedPostedMessages(postMessage).some((message) => message.type === "body-chunk")).toBe(true);
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(parsedPostedMessages(postMessage).at(-1)?.type).toBe("cancel");
  });
});
