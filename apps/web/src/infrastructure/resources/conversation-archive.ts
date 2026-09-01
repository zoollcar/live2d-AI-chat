import type { ArtifactRef, ResourceRef } from "@live2d-chat/shared";
import type { ChatMessage } from "@/agent/types";
import {
  CONVERSATION_EXPORT_FORMAT,
  CONVERSATION_EXPORT_VERSION,
  conversationSchema,
  createConversationId,
  type Conversation,
  type ConversationExport,
} from "@/model/conversation";
import { toArtifactRef, type ArtifactRecord } from "@/model/artifact";
import {
  createResourceChunkId,
  createResourceId,
  toResourceRef,
  type ResourceBundle,
  type ResourceRecord,
} from "@/model/resource";
import { exportResourceArchiveV2, importResourceArchive } from "./archive";
import { ResourceError } from "./errors";
import type { ResourceRepository } from "./repository";

export interface ConversationArchiveImportResult {
  count: number;
  legacyJson: boolean;
  activeConversationId?: string;
}

export interface ImportConversationArchiveOptions {
  input: Blob | Uint8Array | string;
  existingConversations: readonly Conversation[];
  repository: ResourceRepository;
  importConversations(payload: ConversationExport): Promise<number>;
  signal?: AbortSignal;
}

interface PreparedArchiveImport {
  conversations: ConversationExport;
  resources: ResourceBundle[];
  artifacts: ArtifactRecord[];
}

function archiveError(message: string): ResourceError {
  return new ResourceError("archive_integrity_failed", message);
}

function ensureResourceReference(
  reference: ResourceRef,
  conversationId: string,
  resources: ReadonlyMap<string, ResourceRecord>,
): void {
  const resource = resources.get(reference.id);
  if (!resource
    || resource.conversationId !== conversationId
    || resource.kind !== reference.kind
    || resource.name !== reference.name
    || resource.mimeType !== reference.mediaType
    || resource.originalByteSize !== reference.size
    || resource.status !== reference.status) {
    throw archiveError(`Conversation '${conversationId}' references missing resource '${reference.id}'.`);
  }
}

function ensureArtifactReference(
  reference: ArtifactRef,
  conversationId: string,
  artifacts: ReadonlyMap<string, ArtifactRecord>,
): void {
  const artifact = artifacts.get(reference.id);
  if (!artifact
    || artifact.conversationId !== conversationId
    || artifact.resourceId !== reference.resourceId
    || artifact.kind !== reference.kind) {
    throw archiveError(`Conversation '${conversationId}' references missing artifact '${reference.id}'.`);
  }
}

function assertConversationReferences(
  conversations: readonly Conversation[],
  resources: readonly ResourceBundle[],
  artifacts: readonly ArtifactRecord[],
): void {
  const conversationIds = new Set(conversations.map((conversation) => conversation.id));
  if (conversationIds.size !== conversations.length) {
    throw archiveError("The conversation archive contains duplicate conversation ids.");
  }
  const resourceRecords = new Map(resources.map((bundle) => [bundle.resource.id, bundle.resource]));
  const artifactRecords = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  if (resourceRecords.size !== resources.length || artifactRecords.size !== artifacts.length) {
    throw archiveError("The conversation archive contains duplicate resource or artifact ids.");
  }
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      for (const reference of message.attachments ?? []) {
        ensureResourceReference(reference, conversation.id, resourceRecords);
      }
      for (const reference of message.artifacts ?? []) {
        ensureArtifactReference(reference, conversation.id, artifactRecords);
      }
    }
  }
}

/**
 * A URL/transcript can be attached while it is still processing. Its message
 * reference is therefore only a snapshot; the repository record remains the
 * source of truth for mutable display fields such as status, title, and size.
 * Canonicalize those refs at export time so a completed background job cannot
 * make an otherwise valid archive fail integrity validation or re-import as
 * permanently "processing".
 */
function canonicalizeConversationReferences(
  conversations: readonly Conversation[],
  resources: readonly ResourceBundle[],
  artifacts: readonly ArtifactRecord[],
): Conversation[] {
  const resourceRecords = new Map(resources.map((bundle) => [bundle.resource.id, bundle.resource]));
  const artifactRecords = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      ...(message.attachments ? {
        attachments: message.attachments.map((reference) => {
          const resource = resourceRecords.get(reference.id);
          if (!resource
            || resource.conversationId !== conversation.id
            || resource.kind !== reference.kind) {
            throw archiveError(`Conversation '${conversation.id}' references missing resource '${reference.id}'.`);
          }
          return toResourceRef(resource);
        }),
      } : {}),
      ...(message.artifacts ? {
        artifacts: message.artifacts.map((reference) => {
          const artifact = artifactRecords.get(reference.id);
          if (!artifact
            || artifact.conversationId !== conversation.id
            || artifact.resourceId !== reference.resourceId
            || artifact.kind !== reference.kind) {
            throw archiveError(`Conversation '${conversation.id}' references missing artifact '${reference.id}'.`);
          }
          return toArtifactRef(artifact);
        }),
      } : {}),
    })),
  }));
}

async function bundleResource(
  resource: ResourceRecord,
  repository: ResourceRepository,
): Promise<ResourceBundle> {
  if (resource.status !== "ready") {
    throw archiveError(`Resource '${resource.name}' is still ${resource.status} and cannot be exported.`);
  }
  const [blob, chunks] = await Promise.all([
    repository.getResourceBlob(resource.id),
    repository.getResourceChunks(resource.id),
  ]);
  if (!blob) throw archiveError(`Resource '${resource.name}' has no stored original file.`);
  return { resource, blob, chunks };
}

export async function exportConversationLibraryArchive(
  conversations: readonly Conversation[],
  repository: ResourceRepository,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  const artifactLists = await Promise.all(conversations.map((conversation) =>
    repository.listArtifacts(conversation.id)));
  const artifacts = artifactLists.flat();
  const requiredResourceIds = new Set([
    ...conversations.flatMap((conversation) => conversation.messages.flatMap((message) =>
      (message.attachments ?? []).map((reference) => reference.id))),
    ...artifacts.flatMap((artifact) => [
      artifact.resourceId,
      ...(artifact.previewResourceId ? [artifact.previewResourceId] : []),
    ]),
  ]);
  const resourceLists = await Promise.all(conversations.map((conversation) =>
    repository.listResources(conversation.id)));
  const exportableResources = resourceLists.flat().filter((resource) =>
    resource.status === "ready" || requiredResourceIds.has(resource.id));
  const resources = await Promise.all(exportableResources.map((resource) =>
    bundleResource(resource, repository)));
  const canonicalConversations = canonicalizeConversationReferences(conversations, resources, artifacts);
  assertConversationReferences(canonicalConversations, resources, artifacts);
  return exportResourceArchiveV2({
    conversations: {
      format: CONVERSATION_EXPORT_FORMAT,
      version: CONVERSATION_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      conversations: canonicalConversations.map((conversation) => conversationSchema.parse(conversation)),
    },
    resources,
    artifacts,
    signal,
  });
}

async function allocateId(
  createId: () => string,
  reserved: Set<string>,
  exists: (id: string) => Promise<boolean>,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = createId();
    if (!reserved.has(id) && !await exists(id)) {
      reserved.add(id);
      return id;
    }
  }
  throw new ResourceError("storage_failed", "Unable to allocate a collision-free import id.");
}

function remapMessage(
  message: ChatMessage,
  resourceIds: ReadonlyMap<string, string>,
): ChatMessage {
  return {
    ...message,
    attachments: message.attachments?.map((reference) => {
      const id = resourceIds.get(reference.id);
      if (!id) throw archiveError(`Message references unarchived resource '${reference.id}'.`);
      return { ...reference, id };
    }),
    artifacts: message.artifacts?.map((reference) => {
      const resourceId = resourceIds.get(reference.resourceId);
      if (!resourceId) throw archiveError(`Message references unarchived artifact '${reference.id}'.`);
      return { ...reference, id: resourceId, resourceId };
    }),
  };
}

async function prepareArchiveImport(
  imported: Awaited<ReturnType<typeof importResourceArchive>>,
  existingConversations: readonly Conversation[],
  repository: ResourceRepository,
): Promise<PreparedArchiveImport> {
  assertConversationReferences(imported.conversations.conversations, imported.resources, imported.artifacts);

  const reservedConversationIds = new Set(existingConversations.map((conversation) => conversation.id));
  const conversationIds = new Map<string, string>();
  for (const conversation of imported.conversations.conversations) {
    const id = reservedConversationIds.has(conversation.id)
      ? await allocateId(createConversationId, reservedConversationIds, async () => false)
      : conversation.id;
    reservedConversationIds.add(id);
    conversationIds.set(conversation.id, id);
  }

  const reservedResourceIds = new Set(imported.resources.map((bundle) => bundle.resource.id));
  const resourceIds = new Map<string, string>();
  for (const bundle of imported.resources) {
    const currentId = bundle.resource.id;
    const id = await repository.getResource(currentId)
      ? await allocateId(createResourceId, reservedResourceIds, async (candidate) =>
        Boolean(await repository.getResource(candidate)))
      : currentId;
    resourceIds.set(currentId, id);
  }

  const resources = imported.resources.map((bundle) => {
    const id = resourceIds.get(bundle.resource.id);
    const conversationId = conversationIds.get(bundle.resource.conversationId);
    if (!id || !conversationId) throw archiveError(`Resource '${bundle.resource.id}' has an invalid owner.`);
    return {
      resource: { ...bundle.resource, id, conversationId },
      blob: { ...bundle.blob, resourceId: id },
      chunks: bundle.chunks.map((chunk) => ({
        ...chunk,
        id: createResourceChunkId(id, chunk.index),
        resourceId: id,
      })),
    };
  });

  const artifacts = imported.artifacts.map((artifact) => {
    const conversationId = conversationIds.get(artifact.conversationId);
    const resourceId = resourceIds.get(artifact.resourceId);
    const previewResourceId = artifact.previewResourceId
      ? resourceIds.get(artifact.previewResourceId)
      : undefined;
    if (!conversationId || !resourceId || (artifact.previewResourceId && !previewResourceId)) {
      throw archiveError(`Artifact '${artifact.id}' has an invalid archive reference.`);
    }
    return { ...artifact, id: resourceId, conversationId, resourceId, previewResourceId };
  });

  const conversations = imported.conversations.conversations.map((conversation) => {
    const id = conversationIds.get(conversation.id);
    if (!id) throw archiveError(`Conversation '${conversation.id}' could not be remapped.`);
    return conversationSchema.parse({
      ...conversation,
      id,
      messages: conversation.messages.map((message) => remapMessage(message, resourceIds)),
    });
  });

  return {
    conversations: {
      ...imported.conversations,
      conversations,
    },
    resources,
    artifacts,
  };
}

async function rollbackImportedResources(
  resources: readonly ResourceBundle[],
  artifacts: readonly ArtifactRecord[],
  repository: ResourceRepository,
): Promise<void> {
  await Promise.allSettled(artifacts.map((artifact) => repository.deleteArtifact(artifact.id)));
  await Promise.allSettled(resources.map((bundle) => repository.deleteResource(bundle.resource.id)));
}

export async function importConversationLibraryArchive(
  options: ImportConversationArchiveOptions,
): Promise<ConversationArchiveImportResult> {
  const imported = await importResourceArchive(options.input, options.signal);
  options.signal?.throwIfAborted();
  if (imported.legacyJson) {
    const count = await options.importConversations(imported.conversations);
    return { count, legacyJson: true };
  }

  const prepared = await prepareArchiveImport(imported, options.existingConversations, options.repository);
  const savedResources: ResourceBundle[] = [];
  const savedArtifacts: ArtifactRecord[] = [];
  try {
    for (const bundle of prepared.resources) {
      options.signal?.throwIfAborted();
      if (await options.repository.getResource(bundle.resource.id)) {
        throw new ResourceError("storage_failed", `Resource '${bundle.resource.id}' appeared during import.`);
      }
      await options.repository.saveResource(bundle);
      savedResources.push(bundle);
    }
    for (const artifact of prepared.artifacts) {
      options.signal?.throwIfAborted();
      if (await options.repository.getArtifact(artifact.id)) {
        throw new ResourceError("storage_failed", `Artifact '${artifact.id}' appeared during import.`);
      }
      await options.repository.saveArtifact(artifact);
      savedArtifacts.push(artifact);
    }
    const count = await options.importConversations(prepared.conversations);
    return {
      count,
      legacyJson: false,
      activeConversationId: prepared.conversations.conversations[0]?.id,
    };
  } catch (error) {
    await rollbackImportedResources(savedResources, savedArtifacts, options.repository);
    throw error;
  }
}
