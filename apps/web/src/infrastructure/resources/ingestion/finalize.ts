import {
  createResourceId,
  resourceRecordSchema,
  type ResourceBundle,
} from "@/model/resource";
import { buildResourceChunks, extractedTextLength } from "../chunks";
import { sha256Blob } from "../hash";
import type { ResourceBundleInput } from "./types";

export async function finalizeResourceBundle(input: ResourceBundleInput): Promise<ResourceBundle> {
  input.options.signal?.throwIfAborted();
  const id = input.options.resourceId ?? createResourceId();
  const now = input.options.now ?? Date.now();
  const blob = input.blob ?? input.file.file;
  const chunks = buildResourceChunks(id, input.sections);
  const hash = await sha256Blob(blob);
  input.options.signal?.throwIfAborted();
  const resource = resourceRecordSchema.parse({
    id,
    conversationId: input.options.conversationId,
    kind: input.kind,
    origin: input.options.origin ?? "upload",
    name: input.file.file.name,
    mimeType: input.file.mimeType,
    extension: input.file.extension,
    status: "ready",
    byteSize: blob.size,
    originalByteSize: input.file.file.size,
    sha256: hash,
    originalSha256: input.originalSha256,
    textLength: extractedTextLength(chunks),
    chunkCount: chunks.length,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });
  return {
    resource,
    blob: {
      resourceId: id,
      blob,
      byteSize: blob.size,
      mimeType: input.file.mimeType,
    },
    chunks,
  };
}
