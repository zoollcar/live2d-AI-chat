import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "@/model/artifact";
import {
  CONVERSATION_EXPORT_FORMAT,
  CONVERSATION_EXPORT_VERSION,
  type Conversation,
  type ConversationExport,
} from "@/model/conversation";
import type {
  ReadResourceRequest,
  ReadResourceResult,
  ResourceBlobRecord,
  ResourceBundle,
  ResourceChunk,
  ResourceRecord,
} from "@/model/resource";
import { importResourceArchive } from "./archive";
import { sha256Blob } from "./hash";
import type { ResourceMetadataPatch, ResourceRepository } from "./repository";
import {
  exportConversationLibraryArchive,
  importConversationLibraryArchive,
} from "./conversation-archive";

class MemoryResourceRepository implements ResourceRepository {
  readonly resources = new Map<string, ResourceRecord>();
  readonly blobs = new Map<string, ResourceBlobRecord>();
  readonly chunks = new Map<string, ResourceChunk[]>();
  readonly artifacts = new Map<string, ArtifactRecord>();

  constructor(bundles: readonly ResourceBundle[] = [], artifacts: readonly ArtifactRecord[] = []) {
    for (const bundle of bundles) {
      this.resources.set(bundle.resource.id, bundle.resource);
      this.blobs.set(bundle.resource.id, bundle.blob);
      this.chunks.set(bundle.resource.id, bundle.chunks);
    }
    for (const artifact of artifacts) this.artifacts.set(artifact.id, artifact);
  }

  async saveResource(bundle: ResourceBundle) {
    this.resources.set(bundle.resource.id, bundle.resource);
    this.blobs.set(bundle.resource.id, bundle.blob);
    this.chunks.set(bundle.resource.id, bundle.chunks);
  }

  async saveResourceMetadata(resource: ResourceRecord) {
    this.resources.set(resource.id, resource);
  }

  async updateResource(id: string, patch: ResourceMetadataPatch) {
    const current = this.resources.get(id);
    if (!current) throw new Error("missing resource");
    const updated = { ...current, ...patch };
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

  async readResource(_id: string, _request?: ReadResourceRequest): Promise<ReadResourceResult> {
    throw new Error("not used");
  }

  async deleteResource(id: string) {
    const existed = this.resources.delete(id);
    this.blobs.delete(id);
    this.chunks.delete(id);
    for (const [artifactId, artifact] of this.artifacts) {
      if (artifact.resourceId === id || artifact.previewResourceId === id) this.artifacts.delete(artifactId);
    }
    return existed;
  }

  async saveArtifact(artifact: ArtifactRecord) {
    if (!this.resources.has(artifact.resourceId)) throw new Error("missing artifact resource");
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
    for (const artifact of artifacts) this.artifacts.delete(artifact.id);
    for (const resource of resources) await this.deleteResource(resource.id);
    return { conversationDeleted: false, resourcesDeleted: resources.length, artifactsDeleted: artifacts.length };
  }

  async deleteConversationCascade(conversationId: string) {
    return { ...await this.deleteConversationResources(conversationId), conversationDeleted: true };
  }
}

async function resourceBundle(conversationId = "conversation-1", id = "resource-1"): Promise<ResourceBundle> {
  const blob = new Blob(["archived text"], { type: "text/plain" });
  return {
    resource: {
      id,
      conversationId,
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
    blob: { resourceId: id, blob, byteSize: blob.size, mimeType: "text/plain" },
    chunks: [{
      id: `${id}:0`,
      resourceId: id,
      index: 0,
      text: "archived text",
      locator: { startChar: 0, endChar: 13 },
    }],
  };
}

function artifact(conversationId = "conversation-1", resourceId = "resource-1"): ArtifactRecord {
  return {
    id: resourceId,
    conversationId,
    kind: "resource-view",
    title: "Notes",
    resourceId,
    createdAt: 1,
    updatedAt: 1,
  };
}

function conversation(id = "conversation-1", withReferences = true): Conversation {
  return {
    id,
    title: "Archive test",
    createdAt: 1,
    updatedAt: 1,
    starred: false,
    characterId: "default",
    modelSnapshot: {
      transport: "extension",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-test",
    },
    messages: withReferences ? [{
      role: "user",
      content: "Read this",
      attachments: [{
        id: "resource-1",
        kind: "text",
        name: "notes.txt",
        mediaType: "text/plain",
        size: 13,
        status: "ready",
      }],
      artifacts: [{ id: "resource-1", resourceId: "resource-1", kind: "resource-view" }],
    }] : [],
  };
}

async function zipFixture(): Promise<Blob> {
  const bundle = await resourceBundle();
  const repository = new MemoryResourceRepository([bundle], [artifact()]);
  return exportConversationLibraryArchive([conversation()], repository);
}

describe("conversation resource archive integration", () => {
  it("exports the conversation, original resource, extracted text, and artifact as ZIP v2", async () => {
    const imported = await importResourceArchive(await zipFixture());

    expect(imported.legacyJson).toBe(false);
    expect(imported.conversations.conversations).toEqual([conversation()]);
    expect(imported.resources).toHaveLength(1);
    expect(await imported.resources[0].blob.blob.text()).toBe("archived text");
    expect(imported.resources[0].chunks[0].text).toBe("archived text");
    expect(imported.artifacts).toEqual([artifact()]);
  });

  it("remaps colliding conversation, resource, artifact, message, and chunk ids before persisting", async () => {
    const existingBundle = await resourceBundle("conversation-1", "resource-1");
    const existingArtifact = artifact("conversation-1", "resource-1");
    const repository = new MemoryResourceRepository([existingBundle], [existingArtifact]);
    let payload: ConversationExport | undefined;

    const result = await importConversationLibraryArchive({
      input: await zipFixture(),
      existingConversations: [conversation("conversation-1", false)],
      repository,
      importConversations: async (value) => {
        payload = value;
        return value.conversations.length;
      },
    });

    const importedConversation = payload?.conversations[0];
    expect(result).toMatchObject({ count: 1, legacyJson: false });
    expect(importedConversation?.id).not.toBe("conversation-1");
    const importedResourceId = importedConversation?.messages[0].attachments?.[0].id;
    const importedArtifactRef = importedConversation?.messages[0].artifacts?.[0];
    expect(importedResourceId).not.toBe("resource-1");
    expect(importedArtifactRef?.id).toBe(importedResourceId);
    expect(importedArtifactRef?.resourceId).toBe(importedResourceId);
    expect(repository.resources.get("resource-1")).toEqual(existingBundle.resource);
    expect(repository.resources.get(importedResourceId ?? "")?.conversationId).toBe(importedConversation?.id);
    expect(repository.chunks.get(importedResourceId ?? "")?.[0]).toMatchObject({
      id: `${importedResourceId}:0`,
      resourceId: importedResourceId,
    });
    expect(repository.artifacts.get(importedArtifactRef?.id ?? "")).toMatchObject({
      conversationId: importedConversation?.id,
      resourceId: importedResourceId,
    });
  });

  it("rolls back imported resources and artifacts when conversation persistence fails", async () => {
    const repository = new MemoryResourceRepository();

    await expect(importConversationLibraryArchive({
      input: await zipFixture(),
      existingConversations: [],
      repository,
      importConversations: async () => {
        throw new Error("conversation storage failed");
      },
    })).rejects.toThrow("conversation storage failed");

    expect(repository.resources.size).toBe(0);
    expect(repository.artifacts.size).toBe(0);
  });

  it("keeps legacy JSON v0/v1 imports resource-free", async () => {
    const legacy: ConversationExport = {
      format: CONVERSATION_EXPORT_FORMAT,
      version: CONVERSATION_EXPORT_VERSION,
      exportedAt: "2026-08-31T00:00:00.000Z",
      conversations: [conversation("legacy-conversation", false)],
    };
    const repository = new MemoryResourceRepository();
    let received: ConversationExport | undefined;

    const result = await importConversationLibraryArchive({
      input: JSON.stringify(legacy),
      existingConversations: [],
      repository,
      importConversations: async (payload) => {
        received = payload;
        return payload.conversations.length;
      },
    });

    expect(result).toEqual({ count: 1, legacyJson: true });
    expect(received).toEqual(legacy);
    expect(repository.resources.size).toBe(0);
  });

  it("rejects an export while a referenced resource is unfinished", async () => {
    const bundle = await resourceBundle();
    bundle.resource = { ...bundle.resource, status: "processing", sha256: undefined };
    const repository = new MemoryResourceRepository([bundle], [artifact()]);

    await expect(exportConversationLibraryArchive([conversation()], repository))
      .rejects.toThrow("still processing");
  });

  it("omits an abandoned unfinished resource that is no longer referenced", async () => {
    const ready = await resourceBundle();
    const abandoned = await resourceBundle("conversation-1", "resource-abandoned");
    abandoned.resource = { ...abandoned.resource, status: "error", sha256: undefined, errorMessage: "Canceled" };
    const repository = new MemoryResourceRepository([ready, abandoned], [artifact()]);

    const archive = await importResourceArchive(
      await exportConversationLibraryArchive([conversation()], repository),
    );

    expect(archive.resources.map((bundle) => bundle.resource.id)).toEqual(["resource-1"]);
  });

  it("canonicalizes a processing attachment snapshot after its background resource becomes ready", async () => {
    const ready = await resourceBundle();
    ready.resource = {
      ...ready.resource,
      name: "Resolved page title",
      updatedAt: 2,
    };
    const pendingConversation = conversation();
    pendingConversation.messages[0] = {
      ...pendingConversation.messages[0],
      attachments: [{
        id: ready.resource.id,
        kind: ready.resource.kind,
        name: "example.com",
        mediaType: "text/plain",
        size: 0,
        status: "processing",
      }],
    };
    const repository = new MemoryResourceRepository([ready], [artifact()]);

    const archive = await importResourceArchive(
      await exportConversationLibraryArchive([pendingConversation], repository),
    );

    expect(archive.conversations.conversations[0].messages[0].attachments).toEqual([{
      id: ready.resource.id,
      kind: ready.resource.kind,
      name: "Resolved page title",
      mediaType: ready.resource.mimeType,
      size: ready.resource.originalByteSize,
      status: "ready",
    }]);
  });
});
