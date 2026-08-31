import { artifactRecordSchema, type ArtifactRecord } from "@/model/artifact";
import {
  resourceChunkSchema,
  resourceRecordSchema,
  type ReadResourceRequest,
  type ResourceBlobRecord,
  type ResourceBundle,
  type ResourceRecord,
} from "@/model/resource";
import { ResourceError } from "./errors";
import { extractedTextLength, validateResourceChunkSequence } from "./chunks";
import { sha256Blob } from "./hash";
import { readResourceChunks } from "./read-resource";
import type { ConversationCascadeResult, ResourceMetadataPatch, ResourceRepository } from "./repository";

export const LIVE2D_DATABASE_NAME = "live2d-chat";
export const LIVE2D_DATABASE_VERSION = 2;

export const RESOURCE_STORE_NAMES = {
  conversations: "conversations",
  meta: "meta",
  resources: "resources",
  resourceBlobs: "resourceBlobs",
  resourceChunks: "resourceChunks",
  artifacts: "artifacts",
} as const;

const INDEXES = {
  updatedAt: "updatedAt",
  conversationId: "conversationId",
  resourceId: "resourceId",
  previewResourceId: "previewResourceId",
  resourceChunkOrder: "resourceChunkOrder",
} as const;

let defaultDatabasePromise: Promise<IDBDatabase> | undefined;

/**
 * Mainline integration point for the existing conversation database owner.
 * Its `onupgradeneeded` handler must call this function and open the database
 * with LIVE2D_DATABASE_VERSION. Keeping a separate v1 connection promise after
 * this upgrade would leave that module holding a closed database handle.
 */
export function upgradeLive2dDatabaseToV2(database: IDBDatabase, transaction: IDBTransaction): void {
  const conversations = database.objectStoreNames.contains(RESOURCE_STORE_NAMES.conversations)
    ? transaction.objectStore(RESOURCE_STORE_NAMES.conversations)
    : database.createObjectStore(RESOURCE_STORE_NAMES.conversations, { keyPath: "id" });
  if (!conversations.indexNames.contains(INDEXES.updatedAt)) {
    conversations.createIndex(INDEXES.updatedAt, "updatedAt", { unique: false });
  }
  if (!database.objectStoreNames.contains(RESOURCE_STORE_NAMES.meta)) {
    database.createObjectStore(RESOURCE_STORE_NAMES.meta);
  }
  const resources = database.objectStoreNames.contains(RESOURCE_STORE_NAMES.resources)
    ? transaction.objectStore(RESOURCE_STORE_NAMES.resources)
    : database.createObjectStore(RESOURCE_STORE_NAMES.resources, { keyPath: "id" });
  if (!resources.indexNames.contains(INDEXES.conversationId)) {
    resources.createIndex(INDEXES.conversationId, "conversationId", { unique: false });
  }

  if (!database.objectStoreNames.contains(RESOURCE_STORE_NAMES.resourceBlobs)) {
    database.createObjectStore(RESOURCE_STORE_NAMES.resourceBlobs, { keyPath: "resourceId" });
  }
  const chunks = database.objectStoreNames.contains(RESOURCE_STORE_NAMES.resourceChunks)
    ? transaction.objectStore(RESOURCE_STORE_NAMES.resourceChunks)
    : database.createObjectStore(RESOURCE_STORE_NAMES.resourceChunks, { keyPath: "id" });
  if (!chunks.indexNames.contains(INDEXES.resourceId)) {
    chunks.createIndex(INDEXES.resourceId, "resourceId", { unique: false });
  }
  if (!chunks.indexNames.contains(INDEXES.resourceChunkOrder)) {
    chunks.createIndex(INDEXES.resourceChunkOrder, ["resourceId", "index"], { unique: true });
  }

  const artifacts = database.objectStoreNames.contains(RESOURCE_STORE_NAMES.artifacts)
    ? transaction.objectStore(RESOURCE_STORE_NAMES.artifacts)
    : database.createObjectStore(RESOURCE_STORE_NAMES.artifacts, { keyPath: "id" });
  if (!artifacts.indexNames.contains(INDEXES.conversationId)) {
    artifacts.createIndex(INDEXES.conversationId, "conversationId", { unique: false });
  }
  if (!artifacts.indexNames.contains(INDEXES.resourceId)) {
    artifacts.createIndex(INDEXES.resourceId, "resourceId", { unique: false });
  }
  if (!artifacts.indexNames.contains(INDEXES.previewResourceId)) {
    artifacts.createIndex(INDEXES.previewResourceId, "previewResourceId", { unique: false });
  }
}

export function openLive2dDatabaseV2(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  if (factory === globalThis.indexedDB && defaultDatabasePromise) return defaultDatabasePromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = factory.open(LIVE2D_DATABASE_NAME, LIVE2D_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.transaction) {
        reject(new ResourceError("storage_failed", "IndexedDB upgrade transaction is unavailable."));
        return;
      }
      upgradeLive2dDatabaseToV2(request.result, request.transaction);
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
        if (factory === globalThis.indexedDB) defaultDatabasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new ResourceError("storage_failed", "Unable to open IndexedDB."));
    request.onblocked = () => {
      blocked = true;
      reject(new ResourceError(
        "storage_failed",
        "The resource database upgrade is blocked by another open application tab.",
      ));
    };
  });
  if (factory === globalThis.indexedDB) {
    defaultDatabasePromise = opening;
    void opening.catch(() => {
      if (defaultDatabasePromise === opening) defaultDatabasePromise = undefined;
    });
  }
  return opening;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new ResourceError("storage_failed", "IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new ResourceError("storage_failed", "IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new ResourceError("storage_failed", "IndexedDB transaction was aborted."));
  });
}

async function deleteKeys(store: IDBObjectStore, indexName: string, value: IDBValidKey): Promise<number> {
  const keys = await requestResult(store.index(indexName).getAllKeys(value));
  for (const key of keys) store.delete(key);
  return keys.length;
}

function parseBlobRecord(value: unknown): ResourceBlobRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ResourceBlobRecord>;
  if (typeof candidate.resourceId !== "string"
    || !(candidate.blob instanceof Blob)
    || candidate.byteSize !== candidate.blob.size
    || typeof candidate.mimeType !== "string") return undefined;
  return candidate as ResourceBlobRecord;
}

export function createIndexedDbResourceRepository(
  openDatabase: () => Promise<IDBDatabase> = () => openLive2dDatabaseV2(),
): ResourceRepository {
  return {
    async saveResource(bundle: ResourceBundle) {
      const resource = resourceRecordSchema.parse(bundle.resource);
      const chunks = validateResourceChunkSequence(resource.id, bundle.chunks);
      if (resource.status !== "ready"
        || bundle.blob.resourceId !== resource.id
        || bundle.blob.byteSize !== bundle.blob.blob.size
        || bundle.blob.mimeType !== resource.mimeType
        || resource.byteSize !== bundle.blob.byteSize
        || chunks.length !== resource.chunkCount
        || extractedTextLength(chunks) !== resource.textLength
        || await sha256Blob(bundle.blob.blob) !== resource.sha256) {
        throw new ResourceError("storage_failed", "The resource bundle is internally inconsistent.");
      }
      const database = await openDatabase();
      const transaction = database.transaction([
        RESOURCE_STORE_NAMES.resources,
        RESOURCE_STORE_NAMES.resourceBlobs,
        RESOURCE_STORE_NAMES.resourceChunks,
      ], "readwrite");
      const done = transactionDone(transaction);
      const chunkStore = transaction.objectStore(RESOURCE_STORE_NAMES.resourceChunks);
      await deleteKeys(chunkStore, INDEXES.resourceId, resource.id);
      transaction.objectStore(RESOURCE_STORE_NAMES.resources).put(resource);
      transaction.objectStore(RESOURCE_STORE_NAMES.resourceBlobs).put(bundle.blob);
      for (const chunk of chunks) chunkStore.put(chunk);
      await done;
    },

    async saveResourceMetadata(value: ResourceRecord) {
      const resource = resourceRecordSchema.parse(value);
      if (resource.status === "ready"
        || resource.sha256
        || resource.originalSha256
        || resource.byteSize !== 0
        || resource.textLength !== 0
        || resource.chunkCount !== 0) {
        throw new ResourceError(
          "storage_failed",
          "Ready or content-bearing resources must be persisted with saveResource().",
        );
      }
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.resources, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RESOURCE_STORE_NAMES.resources);
      if (await requestResult(store.getKey(resource.id)) !== undefined) {
        await done;
        throw new ResourceError(
          "storage_failed",
          `Resource metadata '${resource.id}' already exists; use updateResource() for status changes.`,
        );
      }
      store.add(resource);
      await done;
    },

    async updateResource(id: string, patch: ResourceMetadataPatch) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.resources, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RESOURCE_STORE_NAMES.resources);
      const current = resourceRecordSchema.safeParse(await requestResult(store.get(id)));
      if (!current.success) {
        await done;
        throw new ResourceError("resource_not_found", `Resource '${id}' was not found.`);
      }
      const candidate: Record<string, unknown> = {
        ...current.data,
        ...patch,
        metadata: patch.metadata
          ? {
            ...current.data.metadata,
            ...patch.metadata,
            ...(patch.metadata.progress
              ? { progress: { ...current.data.metadata.progress, ...patch.metadata.progress } }
              : {}),
          }
          : current.data.metadata,
        updatedAt: patch.updatedAt ?? Math.max(Date.now(), current.data.updatedAt),
      };
      if (patch.status && patch.status !== "error" && !("errorMessage" in patch)) delete candidate.errorMessage;
      const updated = resourceRecordSchema.parse(candidate);
      store.put(updated);
      await done;
      return updated;
    },

    async getResource(id: string) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.resources, "readonly");
      const done = transactionDone(transaction);
      const value = await requestResult(transaction.objectStore(RESOURCE_STORE_NAMES.resources).get(id));
      await done;
      const parsed = resourceRecordSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },

    async getResourceBlob(id: string) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.resourceBlobs, "readonly");
      const done = transactionDone(transaction);
      const value = await requestResult(transaction.objectStore(RESOURCE_STORE_NAMES.resourceBlobs).get(id));
      await done;
      return parseBlobRecord(value);
    },

    async getResourceChunks(id: string) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.resourceChunks, "readonly");
      const done = transactionDone(transaction);
      const values = await requestResult(
        transaction.objectStore(RESOURCE_STORE_NAMES.resourceChunks).index(INDEXES.resourceId).getAll(id),
      );
      await done;
      return values.flatMap((value) => {
        const parsed = resourceChunkSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }).sort((left, right) => left.index - right.index);
    },

    async listResources(conversationId: string) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.resources, "readonly");
      const done = transactionDone(transaction);
      const values = await requestResult(
        transaction.objectStore(RESOURCE_STORE_NAMES.resources).index(INDEXES.conversationId).getAll(conversationId),
      );
      await done;
      return values.flatMap((value) => {
        const parsed = resourceRecordSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }).sort((left, right) => left.createdAt - right.createdAt);
    },

    async readResource(id: string, request: ReadResourceRequest = {}) {
      const [resource, chunks] = await Promise.all([this.getResource(id), this.getResourceChunks(id)]);
      if (!resource) throw new ResourceError("resource_not_found", `Resource '${id}' was not found.`);
      let validatedChunks;
      try {
        validatedChunks = validateResourceChunkSequence(resource.id, chunks);
      } catch (error) {
        throw new ResourceError("storage_failed", `Resource '${id}' has corrupt extracted text.`, { cause: error });
      }
      if (validatedChunks.length !== resource.chunkCount
        || extractedTextLength(validatedChunks) !== resource.textLength) {
        throw new ResourceError("storage_failed", `Resource '${id}' has incomplete extracted text.`);
      }
      return readResourceChunks(resource, validatedChunks, request);
    },

    async deleteResource(id: string) {
      const database = await openDatabase();
      const transaction = database.transaction([
        RESOURCE_STORE_NAMES.resources,
        RESOURCE_STORE_NAMES.resourceBlobs,
        RESOURCE_STORE_NAMES.resourceChunks,
        RESOURCE_STORE_NAMES.artifacts,
      ], "readwrite");
      const done = transactionDone(transaction);
      const resources = transaction.objectStore(RESOURCE_STORE_NAMES.resources);
      const existed = await requestResult(resources.getKey(id));
      resources.delete(id);
      transaction.objectStore(RESOURCE_STORE_NAMES.resourceBlobs).delete(id);
      await deleteKeys(transaction.objectStore(RESOURCE_STORE_NAMES.resourceChunks), INDEXES.resourceId, id);
      const artifacts = transaction.objectStore(RESOURCE_STORE_NAMES.artifacts);
      await deleteKeys(artifacts, INDEXES.resourceId, id);
      await deleteKeys(artifacts, INDEXES.previewResourceId, id);
      await done;
      return existed !== undefined;
    },

    async saveArtifact(value: ArtifactRecord) {
      const artifact = artifactRecordSchema.parse(value);
      const database = await openDatabase();
      const transaction = database.transaction([
        RESOURCE_STORE_NAMES.resources,
        RESOURCE_STORE_NAMES.artifacts,
      ], "readwrite");
      const done = transactionDone(transaction);
      const resources = transaction.objectStore(RESOURCE_STORE_NAMES.resources);
      const resource = resourceRecordSchema.safeParse(await requestResult(resources.get(artifact.resourceId)));
      const preview = artifact.previewResourceId
        ? resourceRecordSchema.safeParse(await requestResult(resources.get(artifact.previewResourceId)))
        : undefined;
      if (!resource.success || resource.data.conversationId !== artifact.conversationId
        || (artifact.previewResourceId && (!preview?.success
          || preview.data.conversationId !== artifact.conversationId
          || preview.data.kind !== "image"))
        || (artifact.kind === "svg-drawing" && resource.success && resource.data.kind !== "svg")
        || (artifact.kind === "sticker" && resource.success && resource.data.kind !== "image")) {
        await done;
        throw new ResourceError("storage_failed", "Artifacts may only reference resources in the same conversation.");
      }
      transaction.objectStore(RESOURCE_STORE_NAMES.artifacts).put(artifact);
      await done;
    },

    async getArtifact(id: string) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.artifacts, "readonly");
      const done = transactionDone(transaction);
      const value = await requestResult(transaction.objectStore(RESOURCE_STORE_NAMES.artifacts).get(id));
      await done;
      const parsed = artifactRecordSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    },

    async listArtifacts(conversationId: string) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.artifacts, "readonly");
      const done = transactionDone(transaction);
      const values = await requestResult(
        transaction.objectStore(RESOURCE_STORE_NAMES.artifacts).index(INDEXES.conversationId).getAll(conversationId),
      );
      await done;
      return values.flatMap((value) => {
        const parsed = artifactRecordSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }).sort((left, right) => left.createdAt - right.createdAt);
    },

    async deleteArtifact(id: string) {
      const database = await openDatabase();
      const transaction = database.transaction(RESOURCE_STORE_NAMES.artifacts, "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore(RESOURCE_STORE_NAMES.artifacts);
      const existed = await requestResult(store.getKey(id));
      store.delete(id);
      await done;
      return existed !== undefined;
    },

    async deleteConversationResources(conversationId: string) {
      return deleteConversationData(await openDatabase(), conversationId, false);
    },

    async deleteConversationCascade(conversationId: string) {
      return deleteConversationData(await openDatabase(), conversationId, true);
    },
  };
}

async function deleteConversationData(
  database: IDBDatabase,
  conversationId: string,
  deleteConversation: boolean,
): Promise<ConversationCascadeResult> {
  const storeNames = [
    RESOURCE_STORE_NAMES.resources,
    RESOURCE_STORE_NAMES.resourceBlobs,
    RESOURCE_STORE_NAMES.resourceChunks,
    RESOURCE_STORE_NAMES.artifacts,
    ...(deleteConversation ? [RESOURCE_STORE_NAMES.conversations] : []),
  ];
  const transaction = database.transaction(storeNames, "readwrite");
  const done = transactionDone(transaction);
  const resources = transaction.objectStore(RESOURCE_STORE_NAMES.resources);
  const records = await requestResult(resources.index(INDEXES.conversationId).getAll(conversationId));
  const resourceIds = records.flatMap((record) => {
    if (!record || typeof record !== "object") return [];
    const id = (record as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  });
  const blobs = transaction.objectStore(RESOURCE_STORE_NAMES.resourceBlobs);
  const chunks = transaction.objectStore(RESOURCE_STORE_NAMES.resourceChunks);
  for (const id of resourceIds) {
    resources.delete(id);
    blobs.delete(id);
    await deleteKeys(chunks, INDEXES.resourceId, id);
  }
  const artifactsDeleted = await deleteKeys(
    transaction.objectStore(RESOURCE_STORE_NAMES.artifacts),
    INDEXES.conversationId,
    conversationId,
  );
  let conversationDeleted = false;
  if (deleteConversation) {
    const conversations = transaction.objectStore(RESOURCE_STORE_NAMES.conversations);
    conversationDeleted = (await requestResult(conversations.getKey(conversationId))) !== undefined;
    conversations.delete(conversationId);
  }
  await done;
  return { conversationDeleted, resourcesDeleted: resourceIds.length, artifactsDeleted };
}

export const resourceRepository = createIndexedDbResourceRepository();
