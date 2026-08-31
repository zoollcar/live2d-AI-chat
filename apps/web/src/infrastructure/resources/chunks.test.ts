import { describe, expect, it } from "vitest";
import type { ResourceRecord } from "@/model/resource";
import { buildResourceChunks, extractedTextLength } from "./chunks";
import { readResourceChunks } from "./read-resource";

describe("buildResourceChunks", () => {
  it("never exceeds the requested chunk size at a boundary newline", () => {
    const text = `${"x".repeat(256)}\nremaining`;
    const chunks = buildResourceChunks("resource-1", [{ text }], 256);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 256)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);

    const resource: ResourceRecord = {
      id: "resource-1",
      conversationId: "conversation-1",
      kind: "text",
      origin: "upload",
      name: "boundary.txt",
      mimeType: "text/plain",
      extension: "txt",
      status: "ready",
      byteSize: text.length,
      originalByteSize: text.length,
      sha256: `sha256:${"0".repeat(64)}`,
      textLength: extractedTextLength(chunks),
      chunkCount: chunks.length,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    };
    expect(readResourceChunks(resource, chunks).text).toBe(text);
    const first = readResourceChunks(resource, chunks, { maxChars: 256 });
    const second = readResourceChunks(resource, chunks, { cursor: first.nextCursor });
    expect(`${first.text}${second.text}`).toBe(text);
  });
});
