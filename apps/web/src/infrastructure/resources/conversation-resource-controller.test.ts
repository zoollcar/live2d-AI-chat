// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentProviderSettings } from "@live2d-chat/shared";
import type { ArtifactRecord } from "@/model/artifact";
import {
  createPendingResource,
  type ReadResourceRequest,
  type ReadResourceResult,
  type ResourceBlobRecord,
  type ResourceBundle,
  type ResourceChunk,
  type ResourceRecord,
} from "@/model/resource";
import type { ContentNetworkClient } from "@/infrastructure/network";
import type { ResourceMetadataPatch, ResourceRepository } from "./repository";
import { getStageDocumentPreviewSource } from "./stage-document-preview";
import { useStageWorkspaceStore } from "./stage-workspace-store";
import {
  buildAttachmentPrompt,
  createConversationResourceController,
  isTranscriptUrl,
  type ConversationResourceController,
} from "./conversation-resource-controller";

const contentSettings: ContentProviderSettings = {
  webProvider: "exa",
  webTransport: "direct",
  videoTranscriptProvider: "supadata",
  videoTransport: "direct",
  exa: { apiKey: "test", rememberApiKey: false },
  supadata: { apiKey: "test", rememberApiKey: false },
};

class MemoryResourceRepository implements ResourceRepository {
  readonly resources = new Map<string, ResourceRecord>();
  readonly blobs = new Map<string, ResourceBlobRecord>();
  readonly chunks = new Map<string, ResourceChunk[]>();
  readonly artifacts = new Map<string, ArtifactRecord>();

  async saveResource(bundle: ResourceBundle) {
    this.resources.set(bundle.resource.id, bundle.resource);
    this.blobs.set(bundle.resource.id, bundle.blob);
    this.chunks.set(bundle.resource.id, [...bundle.chunks]);
  }

  async saveResourceMetadata(resource: ResourceRecord) {
    this.resources.set(resource.id, resource);
  }

  async updateResource(id: string, patch: ResourceMetadataPatch) {
    const current = this.resources.get(id);
    if (!current) throw new Error(`Missing resource ${id}`);
    const updated: ResourceRecord = {
      ...current,
      ...patch,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: Math.max(current.updatedAt, Date.now()),
    };
    if (patch.status && patch.status !== "error" && !("errorMessage" in patch)) {
      delete updated.errorMessage;
    }
    this.resources.set(id, updated);
    return updated;
  }

  async getResource(id: string) {
    return this.resources.get(id);
  }

  async getResourceBlob(id: string) {
    return this.blobs.get(id);
  }

  async getResourceChunks(id: string) {
    return this.chunks.get(id) ?? [];
  }

  async listResources(conversationId: string) {
    return [...this.resources.values()].filter((resource) => resource.conversationId === conversationId);
  }

  async readResource(id: string, _request?: ReadResourceRequest): Promise<ReadResourceResult> {
    const resource = this.resources.get(id);
    if (!resource) throw new Error(`Missing resource ${id}`);
    return {
      resource,
      text: (this.chunks.get(id) ?? []).map((chunk) => chunk.text).join("\n"),
      truncated: false,
    };
  }

  async deleteResource(id: string) {
    const existed = this.resources.delete(id);
    this.blobs.delete(id);
    this.chunks.delete(id);
    return existed;
  }

  async saveArtifact(artifact: ArtifactRecord) {
    this.artifacts.set(artifact.id, artifact);
  }

  async getArtifact(id: string) {
    return this.artifacts.get(id);
  }

  async listArtifacts(conversationId: string) {
    return [...this.artifacts.values()].filter((artifact) => artifact.conversationId === conversationId);
  }

  async deleteArtifact(id: string) {
    return this.artifacts.delete(id);
  }

  async deleteConversationResources(conversationId: string) {
    const resources = await this.listResources(conversationId);
    const artifacts = await this.listArtifacts(conversationId);
    for (const resource of resources) await this.deleteResource(resource.id);
    for (const artifact of artifacts) this.artifacts.delete(artifact.id);
    return { conversationDeleted: false, resourcesDeleted: resources.length, artifactsDeleted: artifacts.length };
  }

  async deleteConversationCascade(conversationId: string) {
    return { ...await this.deleteConversationResources(conversationId), conversationDeleted: true };
  }
}

function abortablePending<T>(signal?: AbortSignal): Promise<T> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Cancelled", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function networkFixture(overrides: Partial<ContentNetworkClient> = {}): ContentNetworkClient {
  return {
    readWebPage: (_url, signal) => abortablePending(signal),
    readVideoTranscript: (_input, signal) => abortablePending(signal),
    pollVideoTranscriptJob: (_input, signal) => abortablePending(signal),
    ...overrides,
  };
}

const controllers: ConversationResourceController[] = [];

function controller(
  repository: ResourceRepository,
  networkClient: ContentNetworkClient = networkFixture(),
): ConversationResourceController {
  const instance = createConversationResourceController({
    conversationId: "conversation-1",
    contentSettings,
    repository,
    networkClient,
  });
  controllers.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of controllers.splice(0)) instance.dispose();
  vi.unstubAllGlobals();
});

describe("conversation resource controller", () => {
  it("wraps attachment references as untrusted data without placing file contents in the prompt", () => {
    const prompt = buildAttachmentPrompt("Summarize this", [{
      id: "resource-1",
      kind: "svg",
      name: "diagram.svg",
      mediaType: "image/svg+xml",
      size: 42,
      status: "ready",
    }]);

    expect(prompt).toContain('<attached_resources trust="untrusted-data-only">');
    expect(prompt).toContain("resourceId=resource-1");
    expect(prompt).not.toContain("<svg");
  });

  it("keeps a loaded document preview when a stale close is rejected", async () => {
    const repository = new MemoryResourceRepository();
    const sourceBlob = new Blob(["%PDF-1.7\npreview"], { type: "application/pdf" });
    const resource: ResourceRecord = {
      ...createPendingResource({
        conversationId: "conversation-1",
        kind: "pdf",
        origin: "upload",
        name: "report.pdf",
        mimeType: "application/pdf",
        extension: "pdf",
        resourceId: "resource-pdf",
        now: 1,
      }),
      status: "ready",
      byteSize: sourceBlob.size,
      originalByteSize: sourceBlob.size,
      sha256: `sha256:${"0".repeat(64)}`,
      metadata: { pageCount: 1 },
      updatedAt: 2,
    };
    const artifact: ArtifactRecord = {
      id: "artifact-pdf",
      conversationId: "conversation-1",
      kind: "resource-view",
      title: "Report",
      resourceId: resource.id,
      createdAt: 2,
      updatedAt: 2,
    };
    await repository.saveResource({
      resource,
      blob: {
        resourceId: resource.id,
        blob: sourceBlob,
        byteSize: sourceBlob.size,
        mimeType: sourceBlob.type,
      },
      chunks: [],
    });
    await repository.saveArtifact(artifact);
    const instance = controller(repository);

    await vi.waitFor(() => {
      expect(useStageWorkspaceStore.getState().artifacts.some((item) => item.id === artifact.id)).toBe(true);
      expect(getStageDocumentPreviewSource(artifact.id)).toBeDefined();
    });
    const staleRevision = useStageWorkspaceStore.getState().layoutRevision;
    useStageWorkspaceStore.getState().openArtifact({
      id: "newer-artifact",
      kind: "text",
      title: "Newer artifact",
      status: "ready",
      createdAt: 3,
      updatedAt: 3,
      content: { text: "newer" },
    });
    const currentRevision = useStageWorkspaceStore.getState().layoutRevision;

    expect(instance.closeArtifact(artifact.id, staleRevision)).toBe(false);
    expect(useStageWorkspaceStore.getState().artifacts.some((item) => item.id === artifact.id)).toBe(true);
    expect(getStageDocumentPreviewSource(artifact.id)).toBeDefined();

    expect(instance.closeArtifact(artifact.id, currentRevision)).toBe(true);
    expect(useStageWorkspaceStore.getState().artifacts.some((item) => item.id === artifact.id)).toBe(false);
    expect(getStageDocumentPreviewSource(artifact.id)).toBeUndefined();
  });

  it("rejects resources owned by another conversation", async () => {
    const repository = new MemoryResourceRepository();
    const foreign = createPendingResource({
      conversationId: "conversation-2",
      kind: "web",
      origin: "web",
      name: "example.com",
      mimeType: "text/plain",
      extension: "txt",
      sourceUrl: "https://example.com/",
    });
    await repository.saveResourceMetadata(foreign);

    await expect(controller(repository).resources.read({
      resourceId: foreign.id,
      maxChars: 12_000,
    })).rejects.toThrow("not available in this conversation");
  });

  it("cannot cancel or delete a resource owned by another conversation", async () => {
    const repository = new MemoryResourceRepository();
    const foreign = createPendingResource({
      conversationId: "conversation-2",
      kind: "web",
      origin: "web",
      name: "foreign page",
      mimeType: "text/plain",
      extension: "txt",
      sourceUrl: "https://example.com/foreign",
    });
    await repository.saveResourceMetadata(foreign);
    const instance = controller(repository);

    await expect(instance.cancelResource(foreign.id)).rejects.toThrow("not available in this conversation");
    await expect(instance.removeResource(foreign.id)).rejects.toThrow("not available in this conversation");
    expect(repository.resources.get(foreign.id)).toEqual(foreign);
  });

  it("drops an in-flight URL attachment without emitting into the next controller after disposal", async () => {
    const repository = new MemoryResourceRepository();
    let resolveResources: ((resources: ResourceRecord[]) => void) | undefined;
    const delayedResources = new Promise<ResourceRecord[]>((resolve) => {
      resolveResources = resolve;
    });
    vi.spyOn(repository, "listResources")
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => delayedResources);
    const onUpdate = vi.fn();
    const instance = createConversationResourceController({
      conversationId: "conversation-1",
      contentSettings,
      repository,
      networkClient: networkFixture(),
      onUpdate,
    });
    controllers.push(instance);

    const attaching = instance.attachUrl("https://example.com/slow");
    instance.dispose();
    resolveResources?.([]);

    await expect(attaching).rejects.toMatchObject({ name: "AbortError" });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(repository.resources.size).toBe(0);
    expect(repository.artifacts.size).toBe(0);
  });

  it("removes an SVG raster preview when its source attachment is removed", async () => {
    const repository = new MemoryResourceRepository();
    const source = createPendingResource({
      conversationId: "conversation-1",
      kind: "svg",
      origin: "upload",
      name: "drawing.svg",
      mimeType: "image/svg+xml",
      extension: "svg",
    });
    const preview = createPendingResource({
      conversationId: "conversation-1",
      kind: "image",
      origin: "generated",
      name: "drawing.png",
      mimeType: "image/png",
      extension: "png",
    });
    const artifact: ArtifactRecord = {
      id: "artifact-svg-preview",
      conversationId: "conversation-1",
      kind: "resource-view",
      title: "Drawing",
      resourceId: source.id,
      previewResourceId: preview.id,
      createdAt: 1,
      updatedAt: 1,
    };
    await repository.saveResourceMetadata(source);
    await repository.saveResourceMetadata(preview);
    await repository.saveArtifact(artifact);
    const instance = controller(repository);
    await vi.waitFor(() => expect(useStageWorkspaceStore.getState().artifacts).toHaveLength(1));

    await instance.removeResource(source.id);

    expect(repository.resources.has(source.id)).toBe(false);
    expect(repository.resources.has(preview.id)).toBe(false);
    expect(repository.artifacts.has(artifact.id)).toBe(false);
    expect(useStageWorkspaceStore.getState().artifacts).toHaveLength(0);
  });

  it("does not resurrect a web resource removed while its completed bundle is being saved", async () => {
    const repository = new MemoryResourceRepository();
    const originalSave = repository.saveResource.bind(repository);
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveResource = vi.spyOn(repository, "saveResource").mockImplementation(async (bundle) => {
      await saveGate;
      await originalSave(bundle);
    });
    const onUpdate = vi.fn();
    const instance = createConversationResourceController({
      conversationId: "conversation-1",
      contentSettings,
      repository,
      networkClient: networkFixture({
        readWebPage: vi.fn().mockResolvedValue({
          provider: "exa",
          sourceUrl: "https://example.com/article",
          resolvedUrl: "https://example.com/article",
          title: "Article",
          mediaType: "text/plain",
          text: "Completed page text",
        }),
      }),
      onUpdate,
    });
    controllers.push(instance);

    const attached = await instance.attachUrl("https://example.com/article");
    await vi.waitFor(() => expect(saveResource).toHaveBeenCalledOnce());
    await instance.removeResource(attached.id);
    releaseSave?.();

    await vi.waitFor(() => expect(repository.resources.has(attached.id)).toBe(false));
    expect(repository.artifacts.size).toBe(0);
    expect(onUpdate.mock.calls.some(([update]) => update.resource.status === "ready")).toBe(false);
  });

  it("keeps a web resource canceled when its completed bundle finishes saving", async () => {
    const repository = new MemoryResourceRepository();
    const originalSave = repository.saveResource.bind(repository);
    let releaseSave: (() => void) | undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveResource = vi.spyOn(repository, "saveResource").mockImplementation(async (bundle) => {
      await saveGate;
      await originalSave(bundle);
    });
    const onUpdate = vi.fn();
    const instance = createConversationResourceController({
      conversationId: "conversation-1",
      contentSettings,
      repository,
      networkClient: networkFixture({
        readWebPage: vi.fn().mockResolvedValue({
          provider: "exa",
          sourceUrl: "https://example.com/cancel",
          resolvedUrl: "https://example.com/cancel",
          title: "Canceled article",
          mediaType: "text/plain",
          text: "Completed page text",
        }),
      }),
      onUpdate,
    });
    controllers.push(instance);

    const attached = await instance.attachUrl("https://example.com/cancel");
    await vi.waitFor(() => expect(saveResource).toHaveBeenCalledOnce());
    await instance.cancelResource(attached.id);
    releaseSave?.();

    await vi.waitFor(() => expect(repository.resources.get(attached.id)).toMatchObject({
      status: "error",
      errorMessage: "Processing was cancelled.",
    }));
    expect(onUpdate.mock.calls.some(([update]) => update.resource.status === "ready")).toBe(false);
  });

  it("classifies supported video hosts and de-duplicates normalized URL resources", async () => {
    const repository = new MemoryResourceRepository();
    const readWebPage = vi.fn((_url: string, signal?: AbortSignal) => abortablePending<never>(signal));
    const instance = controller(repository, networkFixture({ readWebPage }));

    expect(isTranscriptUrl("https://www.youtube.com/watch?v=test")).toBe(true);
    expect(isTranscriptUrl("https://example.com/watch?v=test")).toBe(false);

    const first = await instance.attachUrl("https://example.com/article#section");
    const second = await instance.attachUrl("https://example.com/article");
    expect(first.id).toBe(second.id);
    expect(first.kind).toBe("web");
    await vi.waitFor(() => expect(readWebPage).toHaveBeenCalledOnce());
  });

  it("returns a processing transcript after the initial 90-second provider window and keeps one job in background", async () => {
    const repository = new MemoryResourceRepository();
    const readVideoTranscript = vi.fn().mockResolvedValue({
      status: "processing",
      provider: "supadata",
      sourceUrl: "https://youtu.be/example",
      jobId: "job-1",
    });
    const pollVideoTranscriptJob = vi.fn((_input: unknown, signal?: AbortSignal) => abortablePending<never>(signal));
    const instance = controller(repository, networkFixture({ readVideoTranscript, pollVideoTranscriptJob }));

    const resource = await instance.attachUrl("https://youtu.be/example");
    await vi.waitFor(() => expect(pollVideoTranscriptJob).toHaveBeenCalledOnce());
    const result = await instance.network.readVideoTranscript({ resourceId: resource.id });

    expect(result).toMatchObject({ processing: true, resource: { id: resource.id, status: "processing" } });
    expect(readVideoTranscript).toHaveBeenCalledOnce();
    expect(pollVideoTranscriptJob).toHaveBeenCalledOnce();
  });

  it("does not silently replay an interrupted provider request after controller restoration", async () => {
    const repository = new MemoryResourceRepository();
    const interrupted = {
      ...createPendingResource({
        conversationId: "conversation-1",
        kind: "web",
        origin: "web",
        name: "example.com",
        mimeType: "text/plain",
        extension: "txt",
        sourceUrl: "https://example.com/article",
      }),
      status: "processing" as const,
    };
    await repository.saveResourceMetadata(interrupted);
    const readWebPage = vi.fn();

    controller(repository, networkFixture({ readWebPage }));

    await vi.waitFor(() => expect(repository.resources.get(interrupted.id)).toMatchObject({
      status: "error",
      errorMessage: "Processing was interrupted. Retry to continue.",
    }));
    expect(readWebPage).not.toHaveBeenCalled();
  });

  it("resumes a persisted Supadata job by polling its id without replaying the initial request", async () => {
    const repository = new MemoryResourceRepository();
    const sourceUrl = "https://youtu.be/resumable";
    const transcript = {
      ...createPendingResource({
        conversationId: "conversation-1",
        kind: "video-transcript",
        origin: "video",
        name: "resumable transcript",
        mimeType: "text/plain",
        extension: "txt",
        sourceUrl,
      }),
      status: "processing" as const,
      metadata: {
        providerJob: { provider: "supadata" as const, id: "job-resume", language: "en" },
      },
    };
    await repository.saveResourceMetadata(transcript);
    const readVideoTranscript = vi.fn();
    const pollVideoTranscriptJob = vi.fn().mockResolvedValue({
      status: "ready",
      provider: "supadata",
      sourceUrl,
      language: "en",
      availableLanguages: ["en"],
      cues: [{ text: "Restored cue", startSeconds: 1, endSeconds: 2, language: "en" }],
      text: "Restored cue",
      jobId: "job-resume",
    });

    controller(repository, networkFixture({ readVideoTranscript, pollVideoTranscriptJob }));

    await vi.waitFor(() => expect(repository.resources.get(transcript.id)?.status).toBe("ready"));
    expect(readVideoTranscript).not.toHaveBeenCalled();
    expect(pollVideoTranscriptJob).toHaveBeenCalledWith({
      jobId: "job-resume",
      sourceUrl,
      language: "en",
    }, expect.any(AbortSignal));
  });

  it("rejects an unknown sticker id before touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(controller(new MemoryResourceRepository()).workspace.sendSticker("not-in-pack"))
      .rejects.toThrow("not in the installed pack");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
