import { describe, expect, it } from "vitest";
import { artifactRecordSchema, toArtifactRef } from "./artifact";
import {
  resourceLocatorSchema,
  resourceRecordSchema,
  createPendingResource,
  toResourceRef,
} from "./resource";

const resource = {
  id: "resource-1",
  conversationId: "conversation-1",
  kind: "pdf" as const,
  origin: "upload" as const,
  name: "report.pdf",
  mimeType: "application/pdf",
  extension: "pdf",
  status: "ready" as const,
  byteSize: 5,
  originalByteSize: 5,
  sha256: `sha256:${"0".repeat(64)}`,
  textLength: 10,
  chunkCount: 1,
  metadata: { pageCount: 1 },
  createdAt: 1,
  updatedAt: 1,
};

describe("resource model", () => {
  it("validates durable resources and maps them to chat refs", () => {
    const parsed = resourceRecordSchema.parse(resource);
    expect(toResourceRef(parsed)).toEqual({
      id: "resource-1",
      kind: "pdf",
      name: "report.pdf",
      mediaType: "application/pdf",
      size: 5,
      status: "ready",
    });
  });

  it("rejects archive-unsafe ids and ambiguous locators", () => {
    expect(() => resourceRecordSchema.parse({ ...resource, id: "../escape" })).toThrow();
    expect(() => resourceLocatorSchema.parse({ page: 1, slide: 1 })).toThrow(
      "cannot target both a page and a slide",
    );
    expect(() => resourceRecordSchema.parse({
      ...resource,
      metadata: { pageCount: 301 },
    })).toThrow();
  });

  it("maps persistent artifacts to shared message refs", () => {
    const artifact = artifactRecordSchema.parse({
      id: "artifact-1",
      conversationId: "conversation-1",
      kind: "resource-view",
      title: "Report",
      resourceId: "resource-1",
      createdAt: 1,
      updatedAt: 1,
    });
    expect(toArtifactRef(artifact)).toEqual({
      id: "artifact-1",
      resourceId: "resource-1",
      kind: "resource-view",
    });
  });

  it("creates pending remote resources without inventing an integrity hash", () => {
    expect(createPendingResource({
      conversationId: "conversation-1",
      resourceId: "resource-web",
      kind: "web",
      origin: "web",
      name: "Example",
      mimeType: "text/plain",
      extension: "txt",
      sourceUrl: "https://example.com/article",
      now: 1,
    })).toMatchObject({ status: "pending", byteSize: 0, chunkCount: 0 });
  });

  it("only accepts HTTP(S) source URLs", () => {
    expect(() => createPendingResource({
      conversationId: "conversation-1",
      resourceId: "resource-web",
      kind: "web",
      origin: "web",
      name: "Unsafe",
      mimeType: "text/plain",
      extension: "txt",
      sourceUrl: "javascript:alert(1)",
      now: 1,
    })).toThrow("Only HTTP and HTTPS URLs");
    expect(() => createPendingResource({
      conversationId: "conversation-1",
      resourceId: "resource-web",
      kind: "web",
      origin: "web",
      name: "Credentials",
      mimeType: "text/plain",
      extension: "txt",
      sourceUrl: "https://user:secret@example.com",
      now: 1,
    })).toThrow("without embedded credentials");
  });

  it("stores only a bounded Supadata job handle for resumable transcript processing", () => {
    expect(resourceRecordSchema.parse({
      ...resource,
      kind: "video-transcript",
      origin: "video",
      status: "processing",
      sha256: undefined,
      metadata: {
        providerJob: { provider: "supadata", id: "job_123", language: "en" },
      },
    }).metadata.providerJob).toEqual({ provider: "supadata", id: "job_123", language: "en" });
    expect(() => resourceRecordSchema.parse({
      ...resource,
      metadata: { providerJob: { provider: "supadata", id: "../../secret" } },
    })).toThrow();
  });
});
