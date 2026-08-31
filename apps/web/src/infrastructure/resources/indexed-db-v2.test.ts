import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "@/model/artifact";
import {
  createPendingResource,
  type ResourceBundle,
} from "@/model/resource";
import { sha256Blob } from "./hash";
import {
  RESOURCE_STORE_NAMES,
  createIndexedDbResourceRepository,
  openLive2dDatabaseV2,
} from "./indexed-db-v2";

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function textBundle(): Promise<ResourceBundle> {
  const blob = new Blob(["hello"], { type: "text/plain" });
  return {
    resource: {
      id: "resource-ready",
      conversationId: "conversation-1",
      kind: "text",
      origin: "upload",
      name: "hello.txt",
      mimeType: "text/plain",
      extension: "txt",
      status: "ready",
      byteSize: blob.size,
      originalByteSize: blob.size,
      sha256: await sha256Blob(blob),
      textLength: 5,
      chunkCount: 1,
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    },
    blob: {
      resourceId: "resource-ready",
      blob,
      byteSize: blob.size,
      mimeType: "text/plain",
    },
    chunks: [{
      id: "resource-ready:0",
      resourceId: "resource-ready",
      index: 0,
      text: "hello",
      locator: { startChar: 0, endChar: 5 },
    }],
  };
}

describe("IndexedDB v2 resource repository", () => {
  it("creates all v2 stores and preserves the conversation updatedAt index", async () => {
    const database = await openLive2dDatabaseV2(new IDBFactory());
    expect([...database.objectStoreNames]).toEqual(expect.arrayContaining(Object.values(RESOURCE_STORE_NAMES)));
    const transaction = database.transaction(RESOURCE_STORE_NAMES.conversations, "readonly");
    expect(transaction.objectStore(RESOURCE_STORE_NAMES.conversations).indexNames.contains("updatedAt")).toBe(true);
    await transactionDone(transaction);
    database.close();
  });

  it("persists pending status, atomically updates it, and cascades conversation deletion", async () => {
    const database = await openLive2dDatabaseV2(new IDBFactory());
    const repository = createIndexedDbResourceRepository(async () => database);
    const conversationTransaction = database.transaction(RESOURCE_STORE_NAMES.conversations, "readwrite");
    const conversationDone = transactionDone(conversationTransaction);
    conversationTransaction.objectStore(RESOURCE_STORE_NAMES.conversations).put({
      id: "conversation-1",
      updatedAt: 1,
    });
    await conversationDone;

    const pending = createPendingResource({
      conversationId: "conversation-1",
      resourceId: "resource-pending",
      kind: "web",
      origin: "web",
      name: "Example",
      mimeType: "text/plain",
      extension: "txt",
      sourceUrl: "https://example.com",
      now: 1,
    });
    await repository.saveResourceMetadata(pending);
    await expect(repository.updateResource(pending.id, {
      status: "processing",
      metadata: { title: "Example article" },
    })).resolves.toMatchObject({
      status: "processing",
      metadata: { title: "Example article" },
    });
    const progressed = await repository.updateResource(pending.id, {
      metadata: { progress: { value: 0.5, label: "Extracting" } },
    });
    expect(progressed.metadata).toMatchObject({
      title: "Example article",
      progress: { value: 0.5, label: "Extracting" },
    });
    const progressedAgain = await repository.updateResource(pending.id, {
      metadata: { progress: { value: 0.75 } },
    });
    expect(progressedAgain.metadata.progress).toEqual({ value: 0.75, label: "Extracting" });
    await expect(repository.updateResource(pending.id, {
      status: "error",
      errorMessage: "Fetch failed.",
    })).resolves.toMatchObject({ status: "error", errorMessage: "Fetch failed." });
    const retried = await repository.updateResource(pending.id, { status: "processing" });
    expect(retried.status).toBe("processing");
    expect(retried.errorMessage).toBeUndefined();

    const bundle = await textBundle();
    await repository.saveResource(bundle);
    await expect(repository.readResource(bundle.resource.id)).resolves.toMatchObject({ text: "hello" });

    const artifact: ArtifactRecord = {
      id: "artifact-1",
      conversationId: "conversation-1",
      kind: "resource-view",
      title: "Hello",
      resourceId: bundle.resource.id,
      createdAt: 1,
      updatedAt: 1,
    };
    await repository.saveArtifact(artifact);
    await expect(repository.deleteConversationCascade("conversation-1")).resolves.toEqual({
      conversationDeleted: true,
      resourcesDeleted: 2,
      artifactsDeleted: 1,
    });
    await expect(repository.listResources("conversation-1")).resolves.toEqual([]);
    await expect(repository.listArtifacts("conversation-1")).resolves.toEqual([]);
    database.close();
  });

  it("rejects metadata-only ready records and inconsistent content hashes", async () => {
    const database = await openLive2dDatabaseV2(new IDBFactory());
    const repository = createIndexedDbResourceRepository(async () => database);
    const bundle = await textBundle();
    await expect(repository.saveResourceMetadata(bundle.resource)).rejects.toThrow("saveResource");
    const pending = createPendingResource({
      conversationId: "conversation-1",
      resourceId: "resource-pending",
      kind: "web",
      origin: "web",
      name: "Example",
      mimeType: "text/plain",
      extension: "txt",
      now: 1,
    });
    await repository.saveResourceMetadata(pending);
    await expect(repository.saveResourceMetadata(pending)).rejects.toThrow("already exists");
    await expect(repository.saveResource({
      ...bundle,
      resource: { ...bundle.resource, sha256: `sha256:${"0".repeat(64)}` },
    })).rejects.toThrow("internally inconsistent");
    database.close();
  });

  it("detects a structurally corrupt extracted-text sequence while reading", async () => {
    const database = await openLive2dDatabaseV2(new IDBFactory());
    const repository = createIndexedDbResourceRepository(async () => database);
    const bundle = await textBundle();
    await repository.saveResource(bundle);

    const transaction = database.transaction(RESOURCE_STORE_NAMES.resourceChunks, "readwrite");
    const done = transactionDone(transaction);
    const chunks = transaction.objectStore(RESOURCE_STORE_NAMES.resourceChunks);
    chunks.delete("resource-ready:0");
    chunks.add({ ...bundle.chunks[0], id: "resource-ready:corrupt" });
    await done;

    await expect(repository.readResource(bundle.resource.id)).rejects.toThrow("corrupt extracted text");
    database.close();
  });
});
