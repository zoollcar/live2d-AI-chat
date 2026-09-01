import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "@/model/artifact";
import type { ResourceBundle } from "@/model/resource";
import {
  CONVERSATION_EXPORT_FORMAT,
  CONVERSATION_EXPORT_VERSION,
  type ConversationExport,
} from "@/model/conversation";
import { sha256Blob } from "./hash";
import {
  exportResourceArchiveV2,
  importResourceArchive,
} from "./archive";

class HookedBlob extends Blob {
  constructor(
    parts: BlobPart[],
    private readonly hook: (buffer: ArrayBuffer) => ArrayBuffer | Promise<ArrayBuffer>,
    options?: BlobPropertyBag,
  ) {
    super(parts, options);
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    return this.hook(await super.arrayBuffer());
  }
}

const conversations: ConversationExport = {
  format: CONVERSATION_EXPORT_FORMAT,
  version: CONVERSATION_EXPORT_VERSION,
  exportedAt: "2026-08-30T00:00:00.000Z",
  conversations: [{
    id: "conversation-1",
    title: "Resources",
    createdAt: 1,
    updatedAt: 1,
    starred: false,
    characterId: "default",
    modelSnapshot: {
      transport: "extension",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
    },
    messages: [],
  }],
};

async function textResource(): Promise<ResourceBundle> {
  const blob = new Blob(["archived text"], { type: "text/plain" });
  return {
    resource: {
      id: "resource-text",
      conversationId: "conversation-1",
      kind: "text",
      origin: "upload",
      name: "notes.txt",
      mimeType: "text/plain",
      extension: "txt",
      status: "ready",
      byteSize: blob.size,
      originalByteSize: blob.size,
      sha256: await sha256Blob(blob),
      textLength: 13,
      chunkCount: 1,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    blob: { resourceId: "resource-text", blob, byteSize: blob.size, mimeType: "text/plain" },
    chunks: [{
      id: "resource-text:0",
      resourceId: "resource-text",
      index: 0,
      text: "archived text",
      locator: { startChar: 0, endChar: 13 },
    }],
  };
}

async function customTextResource(id: string, text: string, blob: Blob): Promise<ResourceBundle> {
  return {
    resource: {
      id,
      conversationId: "conversation-1",
      kind: "text",
      origin: "upload",
      name: `${id}.txt`,
      mimeType: "text/plain",
      extension: "txt",
      status: "ready",
      byteSize: blob.size,
      originalByteSize: blob.size,
      sha256: await sha256Blob(new Blob([text], { type: "text/plain" })),
      textLength: text.length,
      chunkCount: 1,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    blob: { resourceId: id, blob, byteSize: blob.size, mimeType: "text/plain" },
    chunks: [{
      id: `${id}:0`,
      resourceId: id,
      index: 0,
      text,
      locator: { startChar: 0, endChar: text.length },
    }],
  };
}

async function svgResource(): Promise<ResourceBundle> {
  const sanitized = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const blob = new Blob([sanitized], { type: "image/svg+xml" });
  const discardedOriginal = new Blob([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>bad()</script><rect/></svg>',
  ]);
  return {
    resource: {
      id: "resource-svg",
      conversationId: "conversation-1",
      kind: "svg",
      origin: "generated",
      name: "drawing.svg",
      mimeType: "image/svg+xml",
      extension: "svg",
      status: "ready",
      byteSize: blob.size,
      originalByteSize: discardedOriginal.size,
      sha256: await sha256Blob(blob),
      originalSha256: await sha256Blob(discardedOriginal),
      textLength: sanitized.length,
      chunkCount: 1,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    blob: { resourceId: "resource-svg", blob, byteSize: blob.size, mimeType: "image/svg+xml" },
    chunks: [{
      id: "resource-svg:0",
      resourceId: "resource-svg",
      index: 0,
      text: sanitized,
      locator: { startChar: 0, endChar: sanitized.length },
    }],
  };
}

const artifact: ArtifactRecord = {
  id: "resource-text",
  conversationId: "conversation-1",
  kind: "resource-view",
  title: "Notes",
  resourceId: "resource-text",
  createdAt: 1,
  updatedAt: 1,
};

describe("resource archive v2", () => {
  it("round-trips explicit resource/artifact paths and SVG sanitization provenance", async () => {
    const archive = await exportResourceArchiveV2({
      conversations,
      resources: [await textResource(), await svgResource()],
      artifacts: [artifact],
      exportedAt: "2026-08-30T00:00:00.000Z",
    });
    const imported = await importResourceArchive(archive);

    expect(imported.legacyJson).toBe(false);
    expect(imported.resources.map((bundle) => bundle.resource.id)).toEqual(["resource-text", "resource-svg"]);
    expect(imported.artifacts).toEqual([artifact]);
    expect(imported.manifest?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "resources/resource-text/original.txt", role: "resource-original" }),
      expect.objectContaining({ path: "resources/resource-text/extracted.json", role: "resource-extracted" }),
      expect.objectContaining({ path: "artifacts/resource-text/artifact.json", role: "artifact-metadata" }),
      expect.objectContaining({
        path: "resources/resource-svg/original.svg",
        role: "resource-original",
        sanitized: true,
        originalSha256: (await svgResource()).resource.originalSha256,
      }),
    ]));
  });

  it("consumes each original before requesting the next gated Blob", async () => {
    let earlyBuffer: ArrayBuffer | undefined;
    let releaseLater!: () => void;
    let markLaterRequested!: () => void;
    const laterGate = new Promise<void>((resolve) => {
      releaseLater = resolve;
    });
    const laterRequested = new Promise<void>((resolve) => {
      markLaterRequested = resolve;
    });
    const earlyBlob = new HookedBlob(["early payload"], (buffer) => {
      earlyBuffer = buffer;
      return buffer;
    }, { type: "text/plain" });
    const laterBlob = new HookedBlob(["later payload"], async (buffer) => {
      if (!earlyBuffer) throw new Error("The early resource was not read first.");
      structuredClone(earlyBuffer, { transfer: [earlyBuffer] });
      markLaterRequested();
      await laterGate;
      return buffer;
    }, { type: "text/plain" });
    const pending = exportResourceArchiveV2({
      conversations,
      resources: [
        await customTextResource("resource-early", "early payload", earlyBlob),
        await customTextResource("resource-later", "later payload", laterBlob),
      ],
      artifacts: [],
    });

    await laterRequested;
    expect(earlyBuffer?.byteLength).toBe(0);
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    releaseLater();
    const imported = await importResourceArchive(await pending);
    const early = imported.resources.find((bundle) => bundle.resource.id === "resource-early");
    expect(await early?.blob.blob.text()).toBe("early payload");
  });

  it("rejects content tampering even when the ZIP itself remains well formed", async () => {
    const archive = await exportResourceArchiveV2({
      conversations,
      resources: [await textResource()],
      artifacts: [],
    });
    const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
    files["resources/resource-text/original.txt"][0] ^= 0xff;
    await expect(importResourceArchive(zipSync(files, { level: 0 }))).rejects.toThrow("integrity validation");
  });

  it("rejects an export whose extracted-text metadata is inconsistent", async () => {
    const resource = await textResource();
    await expect(exportResourceArchiveV2({
      conversations,
      resources: [{
        ...resource,
        resource: { ...resource.resource, textLength: resource.resource.textLength + 1 },
      }],
      artifacts: [],
    })).rejects.toThrow("bundle is inconsistent");
  });

  it("rejects path traversal before decompression results are trusted", async () => {
    const malicious = zipSync({ "../outside.txt": new Uint8Array([1]) }, { level: 0 });
    await expect(importResourceArchive(malicious)).rejects.toThrow("unsafe path");
  });

  it("cancels asynchronous ZIP expansion through its AbortSignal", async () => {
    const archive = zipSync({
      "manifest.json": new Uint8Array(2 * 1024 * 1024),
    }, { level: 0 });
    const controller = new AbortController();
    const pending = importResourceArchive(archive, controller.signal);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
  });

  it("maps legacy conversation JSON v0 and v1 to empty resource collections", async () => {
    const current = await importResourceArchive(JSON.stringify(conversations));
    expect(current).toMatchObject({ legacyJson: true, resources: [], artifacts: [] });

    const legacy = await importResourceArchive(JSON.stringify({
      format: CONVERSATION_EXPORT_FORMAT,
      version: 0,
      conversations: [{
        id: "legacy",
        title: "Legacy",
        createdAt: 1,
        updatedAt: 1,
        characterId: "default",
        model: conversations.conversations[0].modelSnapshot,
        messages: [],
      }],
    }));
    expect(legacy).toMatchObject({
      legacyJson: true,
      resources: [],
      artifacts: [],
      conversations: { version: 1 },
    });
  });
});
