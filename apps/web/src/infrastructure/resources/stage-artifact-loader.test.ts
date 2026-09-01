import { describe, expect, it, vi } from "vitest";
import type { ArtifactRecord } from "@/model/artifact";
import type { ResourceBlobRecord, ResourceChunk, ResourceKind, ResourceRecord } from "@/model/resource";
import {
  loadStageArtifact,
  type StageArtifactResourceRepository,
  type StageObjectUrlAdapter,
} from "./stage-artifact-loader";
import { getStageDocumentPreviewSource } from "./stage-document-preview";

function resource(
  id: string,
  kind: ResourceKind,
  overrides: Partial<ResourceRecord> = {},
): ResourceRecord {
  return {
    id,
    conversationId: "conversation",
    kind,
    origin: "upload",
    name: `${id}.${kind}`,
    mimeType: kind === "image" ? "image/png" : "text/plain",
    extension: kind === "video-transcript" ? "txt" : kind,
    status: "ready",
    byteSize: 3,
    originalByteSize: 3,
    sha256: `sha256:${"a".repeat(64)}`,
    textLength: 0,
    chunkCount: 0,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function artifact(
  contentId: string,
  overrides: Partial<ArtifactRecord> = {},
): ArtifactRecord {
  return {
    id: contentId,
    conversationId: "conversation",
    kind: "resource-view",
    title: `Artifact ${contentId}`,
    resourceId: contentId,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function repositoryFixture(input: {
  artifacts: ArtifactRecord[];
  resources: ResourceRecord[];
  chunks?: ResourceChunk[];
  blobs?: ResourceBlobRecord[];
}): StageArtifactResourceRepository {
  const artifacts = new Map(input.artifacts.map((item) => [item.id, item]));
  const resources = new Map(input.resources.map((item) => [item.id, item]));
  const blobs = new Map((input.blobs ?? []).map((item) => [item.resourceId, item]));
  const chunks = input.chunks ?? [];
  return {
    async getArtifact(id) {
      return artifacts.get(id);
    },
    async getResource(id) {
      return resources.get(id);
    },
    async getResourceBlob(id) {
      return blobs.get(id);
    },
    async getResourceChunks(id) {
      return chunks.filter((chunk) => chunk.resourceId === id);
    },
  };
}

function objectUrlFixture() {
  let nextId = 0;
  const create = vi.fn((_blob: Blob) => `blob:preview-${nextId += 1}`);
  const revoke = vi.fn((_url: string) => undefined);
  return { create, revoke } satisfies StageObjectUrlAdapter;
}

describe("stage artifact loader", () => {
  it("groups extracted presentation chunks into slides and honors a selected locator", async () => {
    const record = artifact("deck", { locator: { slide: 2 } });
    const deck = resource("deck", "pptx", {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      extension: "pptx",
      chunkCount: 3,
      textLength: 25,
      metadata: { slideCount: 2 },
    });
    const chunks: ResourceChunk[] = [
      { id: "deck:0", resourceId: "deck", index: 0, text: "First", locator: { slide: 1, startChar: 0, endChar: 5 } },
      { id: "deck:1", resourceId: "deck", index: 1, text: "Second ", locator: { slide: 2, startChar: 6, endChar: 13 } },
      { id: "deck:2", resourceId: "deck", index: 2, text: "slide", locator: { slide: 2, startChar: 13, endChar: 18 } },
    ];
    const loaded = await loadStageArtifact("deck", {
      repository: repositoryFixture({ artifacts: [record], resources: [deck], chunks }),
    });

    expect(loaded.artifact).toMatchObject({
      kind: "pptx",
      content: { pages: [{ label: "Slide 2", sourcePageIndex: 1, text: "Second slide" }] },
    });
  });

  it("registers original document bytes outside the stage model and releases them with the loaded view", async () => {
    const pdfBlob = new Blob(["%PDF-1.7\npreview"], { type: "application/pdf" });
    const pdf = resource("report", "pdf", {
      mimeType: "application/pdf",
      extension: "pdf",
      byteSize: pdfBlob.size,
      originalByteSize: pdfBlob.size,
      chunkCount: 2,
      textLength: 11,
      metadata: { pageCount: 2 },
    });
    const record = artifact(pdf.id);
    const urls = objectUrlFixture();
    const repository = repositoryFixture({
      artifacts: [],
      resources: [pdf],
      blobs: [{ resourceId: pdf.id, blob: pdfBlob, byteSize: pdfBlob.size, mimeType: "application/pdf" }],
      chunks: [
        { id: "report:0", resourceId: pdf.id, index: 0, text: "First", locator: { page: 1 } },
        { id: "report:1", resourceId: pdf.id, index: 1, text: "Second", locator: { page: 2 } },
      ],
    });
    const loaded = await loadStageArtifact(record, { repository, objectUrls: urls });

    expect(loaded.artifact).toMatchObject({
      kind: "pdf",
      content: {
        originalPreviewAvailable: true,
        pages: [
          { sourcePageIndex: 0, text: "First" },
          { sourcePageIndex: 1, text: "Second" },
        ],
      },
    });
    const firstSource = getStageDocumentPreviewSource(record.id);
    expect(firstSource).toMatchObject({ kind: "pdf" });
    expect(urls.create).not.toHaveBeenCalled();
    expect(JSON.stringify(loaded.artifact)).not.toContain("%PDF");

    const refreshed = await loadStageArtifact(record, { repository, objectUrls: urls });
    const refreshedSource = getStageDocumentPreviewSource(record.id);
    expect(refreshedSource).toMatchObject({ kind: "pdf" });
    expect(refreshedSource).not.toBe(firstSource);
    loaded.dispose();
    expect(getStageDocumentPreviewSource(record.id)).toBe(refreshedSource);
    refreshed.dispose();
    expect(getStageDocumentPreviewSource(record.id)).toBeUndefined();
  });

  it("maps pending and failed resources to display-safe stage states", async () => {
    const pending = resource("pending", "text", {
      status: "pending",
      sha256: undefined,
    });
    const failed = resource("failed", "web", {
      status: "error",
      sha256: undefined,
      errorMessage: "The page could not be fetched.",
    });
    const repository = repositoryFixture({
      artifacts: [artifact("pending"), artifact("failed")],
      resources: [pending, failed],
    });

    await expect(loadStageArtifact("pending", { repository })).resolves.toMatchObject({
      artifact: { kind: "text", status: "queued" },
    });
    await expect(loadStageArtifact("failed", { repository })).resolves.toMatchObject({
      artifact: { kind: "web", status: "error", errorMessage: "The page could not be fetched." },
    });
  });

  it("uses a raster image preview for SVG and never creates a URL for raw SVG", async () => {
    const svg = resource("drawing-source", "svg", {
      mimeType: "image/svg+xml",
      extension: "svg",
    });
    const preview = resource("drawing-preview", "image", {
      mimeType: "image/webp",
      extension: "webp",
      metadata: { description: "Safe drawing preview" },
    });
    const svgBlob = new Blob(["<svg></svg>"], { type: "image/svg+xml" });
    const previewBlob = new Blob(["webp"], { type: "image/webp" });
    const urls = objectUrlFixture();
    const repository = repositoryFixture({
      artifacts: [artifact("drawing-source", {
        kind: "svg-drawing",
        previewResourceId: "drawing-preview",
      })],
      resources: [svg, preview],
      blobs: [
        { resourceId: "drawing-source", blob: svgBlob, byteSize: svgBlob.size, mimeType: svgBlob.type },
        { resourceId: "drawing-preview", blob: previewBlob, byteSize: previewBlob.size, mimeType: previewBlob.type },
      ],
    });

    const loaded = await loadStageArtifact("drawing-source", { repository, objectUrls: urls });
    expect(loaded.artifact).toMatchObject({
      kind: "svg",
      status: "ready",
      content: { rasterPreviewUrl: "blob:preview-1", alt: "Safe drawing preview" },
    });
    expect(urls.create).toHaveBeenCalledTimes(1);
    expect(urls.create).toHaveBeenCalledWith(previewBlob);
    loaded.dispose();
    loaded.dispose();
    expect(urls.revoke).toHaveBeenCalledTimes(1);
    expect(urls.revoke).toHaveBeenCalledWith("blob:preview-1");
  });

  it("returns an error view when an SVG has no static raster preview", async () => {
    const svg = resource("drawing-source", "svg", { mimeType: "image/svg+xml", extension: "svg" });
    const urls = objectUrlFixture();
    const loaded = await loadStageArtifact(artifact("drawing-source", { kind: "svg-drawing" }), {
      repository: repositoryFixture({ artifacts: [], resources: [svg] }),
      objectUrls: urls,
    });

    expect(loaded.artifact).toMatchObject({
      kind: "svg",
      status: "error",
      errorMessage: "A static drawing preview is unavailable.",
    });
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("rejects a preview blob whose actual media type is SVG", async () => {
    const svg = resource("drawing-source", "svg", { mimeType: "image/svg+xml", extension: "svg" });
    const mislabeledPreview = resource("mislabeled-preview", "image", {
      mimeType: "image/webp",
      extension: "webp",
    });
    const rawSvg = new Blob(["<svg></svg>"], { type: "image/svg+xml" });
    const urls = objectUrlFixture();
    const loaded = await loadStageArtifact(artifact("drawing-source", {
      kind: "svg-drawing",
      previewResourceId: "mislabeled-preview",
    }), {
      repository: repositoryFixture({
        artifacts: [],
        resources: [svg, mislabeledPreview],
        blobs: [{
          resourceId: "mislabeled-preview",
          blob: rawSvg,
          byteSize: rawSvg.size,
          mimeType: "image/webp",
        }],
      }),
      objectUrls: urls,
    });

    expect(loaded.artifact).toMatchObject({ kind: "svg", status: "error" });
    expect(urls.create).not.toHaveBeenCalled();
  });

  it("creates searchable video cues and revocable image views", async () => {
    const image = resource("sticker-image", "image", { metadata: { description: "Happy reaction" } });
    const transcript = resource("transcript", "video-transcript", {
      origin: "video",
      sourceUrl: "https://video.example/watch/123",
      chunkCount: 1,
      textLength: 5,
      metadata: { durationSeconds: 8 },
    });
    const imageBlob = new Blob(["png"], { type: "image/png" });
    const repository = repositoryFixture({
      artifacts: [
        artifact("sticker-image", { kind: "sticker" }),
        artifact("transcript"),
      ],
      resources: [image, transcript],
      blobs: [{ resourceId: "sticker-image", blob: imageBlob, byteSize: imageBlob.size, mimeType: imageBlob.type }],
      chunks: [{
        id: "transcript:0",
        resourceId: "transcript",
        index: 0,
        text: "Hello",
        locator: { startSeconds: 2, endSeconds: 4, startChar: 0, endChar: 5, label: "Host" },
      }],
    });
    const urls = objectUrlFixture();

    const sticker = await loadStageArtifact("sticker-image", { repository, objectUrls: urls });
    expect(sticker.artifact).toMatchObject({
      kind: "image",
      content: { imageUrl: "blob:preview-1", alt: "Happy reaction" },
    });
    const video = await loadStageArtifact("transcript", { repository, objectUrls: urls });
    expect(video.artifact).toMatchObject({
      kind: "video-transcript",
      source: { label: "video.example", url: "https://video.example/watch/123" },
      content: {
        durationMs: 8_000,
        cues: [{ startMs: 2_000, endMs: 4_000, speaker: "Host", text: "Hello" }],
      },
    });
    sticker.dispose();
    video.dispose();
    expect(urls.revoke).toHaveBeenCalledTimes(1);
  });
});
