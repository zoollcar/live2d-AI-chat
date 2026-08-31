import { BRIDGE_PROTOCOL_VERSION, type BridgeProtocolMessage } from "@live2d-chat/shared";
import { describe, expect, it } from "vitest";
import {
  isPrivateReadPageTarget,
  originPatternFor,
  resolveOperationRequest,
  resolveOperationTarget,
} from "./operations";
import { commonHostPermissions } from "./constants";

type RequestStartMessage = Extract<BridgeProtocolMessage, { type: "request-start" }>;

const nonce = "AAAAAAAAAAAAAAAAAAAAAA";

function start(overrides: Partial<RequestStartMessage> = {}): RequestStartMessage {
  return {
    type: "request-start",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    nonce,
    requestId: "request-1",
    operation: "chat",
    provider: "openai-compatible",
    baseUrl: "https://models.example/v1",
    credential: { value: "secret" },
    bodyKind: "json",
    totalBytes: 2,
    ...overrides,
  };
}

function json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("operation allowlist", () => {
  it("constructs a fixed chat path and injects authorization itself", () => {
    const request = resolveOperationRequest(start(), json({ model: "demo" }));
    expect(request.url).toBe("https://models.example/v1/chat/completions");
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer secret",
      "Content-Type": "application/json",
    });
  });

  it("rejects query and fragment tricks in a custom API base URL", () => {
    expect(() => resolveOperationTarget(start({ baseUrl: "https://models.example/v1?path=/evil" }))).toThrow("query");
    expect(() => resolveOperationTarget(start({ baseUrl: "https://models.example/v1#evil" }))).toThrow("fragment");
  });

  it("pins named providers to their known API origin", () => {
    expect(() => resolveOperationTarget(start({ provider: "openai", baseUrl: "https://evil.example/v1" }))).toThrow("fixed API base URL");
    expect(resolveOperationTarget(start({ provider: "openai", baseUrl: undefined })).toString())
      .toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses the Google API key header for its OpenAI-compatible endpoint", () => {
    const request = resolveOperationRequest(start({ provider: "google", baseUrl: undefined }), json({ model: "gemini" }));
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(request.headers["x-goog-api-key"]).toBe("secret");
    expect(request.headers.Authorization).toBeUndefined();
  });

  it("pins Google Cloud voice discovery and synthesis to the Text-to-Speech API", () => {
    expect(commonHostPermissions).toContain("https://texttospeech.googleapis.com/*");

    const voices = resolveOperationRequest(start({
      operation: "models",
      provider: "google-cloud",
      baseUrl: undefined,
      bodyKind: "none",
      totalBytes: 0,
    }), new Uint8Array());
    expect(voices).toEqual({
      url: "https://texttospeech.googleapis.com/v1/voices",
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-goog-api-key": "secret",
      },
    });

    const synthesize = resolveOperationRequest(start({
      operation: "synthesize",
      provider: "google-cloud",
      baseUrl: undefined,
    }), json({ input: { text: "Hello" } }));
    expect(synthesize.url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(synthesize.method).toBe("POST");
    expect(synthesize.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-goog-api-key": "secret",
    });
    expect(JSON.parse(synthesize.body as string)).toEqual({ input: { text: "Hello" } });
    expect(() => resolveOperationTarget(start({
      operation: "synthesize",
      provider: "google-cloud",
      baseUrl: "https://evil.example/v1",
    }))).toThrow("fixed API base URL");
    expect(() => resolveOperationTarget(start({
      operation: "chat",
      provider: "google-cloud",
      baseUrl: undefined,
    }))).toThrow("cannot perform");
  });

  it("pins Exa Contents and accepts only the known-URL text payload", () => {
    const request = resolveOperationRequest(start({
      operation: "exa",
      provider: "exa",
      baseUrl: undefined,
    }), json({ urls: ["https://example.com/article"], text: true }));
    expect(request.url).toBe("https://api.exa.ai/contents");
    expect(request.method).toBe("POST");
    expect(request.headers["x-api-key"]).toBe("secret");
    expect(request.headers.Authorization).toBeUndefined();
    expect(JSON.parse(request.body as string)).toEqual({
      urls: ["https://example.com/article"],
      text: true,
    });
    expect(() => resolveOperationRequest(start({
      operation: "exa",
      provider: "exa",
      baseUrl: undefined,
    }), json({ query: "Live2D" }))).toThrow();
    expect(() => resolveOperationRequest(start({
      operation: "exa",
      provider: "exa",
      baseUrl: undefined,
    }), json({
      urls: ["https://example.com/one", "https://example.com/two"],
      text: true,
    }))).toThrow();
  });

  it("turns a strict Supadata payload into an encoded transcript URL", () => {
    const request = resolveOperationRequest(start({
      operation: "supadata",
      provider: "supadata",
      baseUrl: undefined,
    }), json({ url: "https://youtu.be/a?x=1", lang: "en", text: true, mode: "auto" }));
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.supadata.ai/v1/transcript");
    expect(url.searchParams.get("url")).toBe("https://youtu.be/a?x=1");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(request.method).toBe("GET");
  });

  it("allows polling only a constrained Supadata transcript job path", () => {
    const request = resolveOperationRequest(start({
      operation: "supadata",
      provider: "supadata",
      baseUrl: undefined,
    }), json({ jobId: "job_123" }));
    expect(request.url).toBe("https://api.supadata.ai/v1/transcript/job_123");
  });

  it("rejects extra Supadata fields instead of turning them into arbitrary query parameters", () => {
    expect(() => resolveOperationRequest(start({
      operation: "supadata",
      provider: "supadata",
      baseUrl: undefined,
    }), json({ url: "https://youtu.be/a", redirect: "https://evil.example" }))).toThrow();
  });

  it("requires an explicit multipart media type for transcription", () => {
    expect(() => resolveOperationRequest(start({
      operation: "transcribe",
      bodyKind: "binary",
      mediaType: "audio/webm",
    }), new Uint8Array([1, 2]))).toThrow("multipart/form-data");
  });

  it("keeps read-page on the exact public URL without credentials", () => {
    const message = start({
      operation: "read-page",
      provider: "extension-reader",
      baseUrl: "https://example.com/article?q=one",
      credential: undefined,
      bodyKind: "none",
      totalBytes: 0,
    });
    const request = resolveOperationRequest(message, new Uint8Array());
    expect(request.url).toBe("https://example.com/article?q=one");
    expect(originPatternFor(message)).toBe("https://example.com/*");
  });

  it("blocks obvious local and private read-page targets", () => {
    for (const target of [
      "http://localhost/page",
      "http://intranet/page",
      "http://127.0.0.1/page",
      "http://10.0.0.4/page",
      "http://192.168.1.2/page",
      "http://[::1]/page",
      "http://[::ffff:127.0.0.1]/page",
      "http://[fe90::1]/page",
      "http://[2001:db8::1]/page",
      "http://2130706433/page",
    ]) {
      expect(isPrivateReadPageTarget(new URL(target))).toBe(true);
      expect(() => resolveOperationTarget(start({
        operation: "read-page",
        provider: "extension-reader",
        baseUrl: target,
        credential: undefined,
        bodyKind: "none",
      }))).toThrow("private-network");
    }
  });

  it("rejects provider and operation mismatches", () => {
    expect(() => resolveOperationTarget(start({ operation: "exa", provider: "openai" }))).toThrow("cannot perform");
  });
});
