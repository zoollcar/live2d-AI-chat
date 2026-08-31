import { describe, expect, it } from "vitest";
import type { ResourceChunk, ResourceRecord } from "@/model/resource";
import { readResourceChunks } from "./read-resource";

const resource: ResourceRecord = {
  id: "resource-1",
  conversationId: "conversation-1",
  kind: "pdf",
  origin: "upload",
  name: "report.pdf",
  mimeType: "application/pdf",
  extension: "pdf",
  status: "ready",
  byteSize: 10,
  originalByteSize: 10,
  sha256: `sha256:${"0".repeat(64)}`,
  textLength: 16_000,
  chunkCount: 2,
  metadata: { pageCount: 2 },
  createdAt: 1,
  updatedAt: 1,
};

const chunks: ResourceChunk[] = [
  {
    id: "resource-1:0",
    resourceId: "resource-1",
    index: 0,
    text: "a".repeat(8_000),
    locator: { page: 1, label: "Page 1", startChar: 0, endChar: 8_000 },
  },
  {
    id: "resource-1:1",
    resourceId: "resource-1",
    index: 1,
    text: "b".repeat(8_000),
    locator: { page: 2, label: "Page 2", startChar: 8_001, endChar: 16_001 },
  },
];

describe("readResourceChunks", () => {
  it("hard-caps reads at 12k characters and resumes with an opaque cursor", () => {
    const first = readResourceChunks(resource, chunks);
    expect(first.text).toHaveLength(12_000);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    const second = readResourceChunks(resource, chunks, { cursor: first.nextCursor });
    expect(`${first.text}${second.text}`).toBe(`${"a".repeat(8_000)}\n${"b".repeat(8_000)}`);
    expect(second.truncated).toBe(false);
  });

  it("targets a page locator without leaking adjacent page text", () => {
    const page = readResourceChunks(resource, chunks, { locator: { page: 2 } });
    expect(page.text).toBe("b".repeat(8_000));
    expect(page.locator).toMatchObject({ page: 2, startChar: 8_001, endChar: 16_001 });
  });

  it("preserves the inter-chunk separator when a page ends exactly at the read limit", () => {
    const first = readResourceChunks(resource, chunks, { maxChars: 8_000 });
    const second = readResourceChunks(resource, chunks, { cursor: first.nextCursor });
    expect(`${first.text}${second.text}`).toBe(`${"a".repeat(8_000)}\n${"b".repeat(8_000)}`);
  });

  it("filters chunks by query and binds the query to continuation cursors", () => {
    const first = readResourceChunks(resource, chunks, { query: "b", maxChars: 1 });
    expect(first.text).toBe("b");
    expect(first.resource.status).toBe("ready");
    expect(() => readResourceChunks(resource, chunks, {
      query: "a",
      cursor: first.nextCursor,
    })).toThrow("query does not match");
  });

  it("rejects oversized reads and cursors from another resource", () => {
    expect(() => readResourceChunks(resource, chunks, { maxChars: 12_001 })).toThrow("maxChars");
    const cursor = readResourceChunks(resource, chunks, { maxChars: 1 }).nextCursor;
    expect(() => readResourceChunks({ ...resource, id: "resource-2" }, [], { cursor })).toThrow(
      "different resource",
    );
  });
});
