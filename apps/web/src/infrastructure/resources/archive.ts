import { unzip, Zip, ZipPassThrough, type AsyncTerminable } from "fflate";
import { z } from "zod";
import { artifactRecordSchema, type ArtifactRecord } from "@/model/artifact";
import {
  RESOURCE_ID_PATTERN,
  resourceChunkSchema,
  resourceRecordSchema,
  type ResourceBundle,
  type ResourceRecord,
} from "@/model/resource";
import {
  parseConversationExport,
  type ConversationExport,
} from "@/model/conversation";
import { ResourceError } from "./errors";
import { extractedTextLength, validateResourceChunkSequence } from "./chunks";
import { sha256 } from "./hash";
import { RESOURCE_LIMITS } from "./limits";
import {
  assertInflatedEntriesMatchInspection,
  assertSafeArchivePath,
  defaultArchiveSafetyLimits,
  inspectZipArchive,
  verifyZipArchiveContents,
} from "./zip-safety";

export const RESOURCE_ARCHIVE_FORMAT = "live2d-chat-archive";
export const RESOURCE_ARCHIVE_VERSION = 2;
export const RESOURCE_ARCHIVE_MANIFEST = "manifest.json";
const ZIP_INPUT_CHUNK_BYTES = 256 * 1024;

const archiveEntryRoles = [
  "conversations",
  "resource-metadata",
  "resource-original",
  "resource-extracted",
  "artifact-metadata",
] as const;

const archiveEntrySchema = z.object({
  path: z.string().min(1).max(1_000),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative().max(RESOURCE_LIMITS.maxArchiveEntryBytes),
  mediaType: z.string().trim().min(1).max(200),
  role: z.enum(archiveEntryRoles),
  resourceId: z.string().regex(RESOURCE_ID_PATTERN).optional(),
  artifactId: z.string().regex(RESOURCE_ID_PATTERN).optional(),
  sanitized: z.literal(true).optional(),
  originalSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).strict().superRefine((entry, context) => {
  if (entry.role.startsWith("resource-") && !entry.resourceId) {
    context.addIssue({ code: "custom", message: "Resource archive entries require resourceId." });
  }
  if (!entry.role.startsWith("resource-") && entry.resourceId) {
    context.addIssue({ code: "custom", message: "Only resource entries may declare resourceId." });
  }
  if (entry.role === "artifact-metadata" && !entry.artifactId) {
    context.addIssue({ code: "custom", message: "Artifact archive entries require artifactId." });
  }
  if (entry.role !== "artifact-metadata" && entry.artifactId) {
    context.addIssue({ code: "custom", message: "Only artifact entries may declare artifactId." });
  }
  if ((entry.sanitized || entry.originalSha256) && entry.role !== "resource-original") {
    context.addIssue({ code: "custom", message: "Sanitization markers are only valid on original resource entries." });
  }
  if (Boolean(entry.sanitized) !== Boolean(entry.originalSha256)) {
    context.addIssue({ code: "custom", message: "Sanitized entries require the original input hash." });
  }
});

export type ResourceArchiveEntry = z.infer<typeof archiveEntrySchema>;

const archiveManifestSchema = z.object({
  format: z.literal(RESOURCE_ARCHIVE_FORMAT),
  version: z.literal(RESOURCE_ARCHIVE_VERSION),
  exportedAt: z.string().datetime(),
  entries: z.array(archiveEntrySchema).min(1).max(RESOURCE_LIMITS.maxArchiveEntries - 1),
}).strict();

export type ResourceArchiveManifest = z.infer<typeof archiveManifestSchema>;

const extractedResourceSchema = z.object({
  version: z.literal(1),
  resourceId: z.string().regex(RESOURCE_ID_PATTERN),
  chunks: z.array(resourceChunkSchema).max(10_000),
}).strict();

export interface ExportResourceArchiveInput {
  conversations: ConversationExport | string;
  resources: readonly ResourceBundle[];
  artifacts: readonly ArtifactRecord[];
  exportedAt?: string;
  signal?: AbortSignal;
}

export interface ImportedResourceArchive {
  manifest?: ResourceArchiveManifest;
  conversations: ConversationExport;
  resources: ResourceBundle[];
  artifacts: ArtifactRecord[];
  legacyJson: boolean;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function jsonValue(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new ResourceError("archive_integrity_failed", `${label} is not valid UTF-8 JSON.`, { cause: error });
  }
}

function archiveValue<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ResourceError(
      "archive_integrity_failed",
      `${label} is invalid at ${issue.path.join(".") || "root"}: ${issue.message}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function parseConversationPayload(payload: ConversationExport | string): ConversationExport {
  return typeof payload === "string"
    ? parseConversationExport(payload)
    : parseConversationExport(JSON.stringify(payload));
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Archive processing was cancelled.", "AbortError");
}

function runTerminable<T>(
  start: (callback: (error: Error | null, value: T) => void) => AsyncTerminable,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let terminate: AsyncTerminable | undefined;
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => settle(() => {
      terminate?.();
      reject(signal ? abortError(signal) : new DOMException("Archive processing was cancelled.", "AbortError"));
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      terminate = start((error, value) => settle(() => {
        if (error) reject(error);
        else resolve(value);
      }));
    } catch (error) {
      settle(() => reject(error));
    }
  });
}

class IncrementalZipWriter {
  private readonly archive: Zip;
  private readonly output: ArrayBuffer[] = [];
  private readonly paths = new Set<string>();
  private outputBytes = 0;
  private projectedZipBytes = 22;
  private projectedUncompressedBytes = 0;
  private entryCount = 0;
  private failure: unknown;
  private result: Blob | undefined;
  private resolveFinal: ((blob: Blob) => void) | undefined;
  private rejectFinal: ((error: unknown) => void) | undefined;

  constructor(private readonly signal?: AbortSignal) {
    this.archive = new Zip((error, chunk, final) => {
      if (error) {
        this.fail(error);
        return;
      }
      if (this.failure || this.result) return;
      this.outputBytes += chunk.byteLength;
      if (this.outputBytes > RESOURCE_LIMITS.maxArchiveBytes) {
        this.fail(new ResourceError("archive_too_large", "The generated ZIP archive exceeds the size limit."));
        return;
      }
      const copy = Uint8Array.from(chunk);
      this.output.push(copy.buffer);
      if (final) {
        this.result = new Blob(this.output, { type: "application/zip" });
        this.cleanup();
        this.resolveFinal?.(this.result);
      }
    });
    if (signal?.aborted) this.fail(abortError(signal));
    else signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  private readonly onAbort = () => this.fail(this.signal
    ? abortError(this.signal)
    : new DOMException("Archive processing was cancelled.", "AbortError"));

  private cleanup(): void {
    this.signal?.removeEventListener("abort", this.onAbort);
  }

  private fail(error: unknown): void {
    if (this.failure || this.result) return;
    this.failure = error;
    this.cleanup();
    try {
      this.archive.terminate();
    } catch {
      // The ZIP stream may already have emitted its terminal chunk.
    }
    this.rejectFinal?.(error);
  }

  private throwIfUnavailable(): void {
    this.signal?.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.result) throw new ResourceError("storage_failed", "The ZIP archive has already been finalized.");
  }

  writeEntry(path: string, bytes: Uint8Array): void {
    this.throwIfUnavailable();
    assertSafeArchivePath(path);
    if (this.paths.has(path)) throw new ResourceError("unsafe_archive", `Duplicate archive entry '${path}'.`);
    if (bytes.byteLength > RESOURCE_LIMITS.maxArchiveEntryBytes) {
      throw new ResourceError("archive_too_large", `Archive entry '${path}' exceeds the per-entry size limit.`);
    }
    const nextEntryCount = this.entryCount + 1;
    if (nextEntryCount > RESOURCE_LIMITS.maxArchiveEntries) {
      throw new ResourceError("archive_too_large", "The export contains too many archive entries.");
    }
    const nextUncompressedBytes = this.projectedUncompressedBytes + bytes.byteLength;
    if (nextUncompressedBytes > RESOURCE_LIMITS.maxArchiveUncompressedBytes) {
      throw new ResourceError("archive_too_large", "The export exceeds the archive size limit.");
    }
    const encodedPathBytes = new TextEncoder().encode(path).byteLength;
    // ZipPassThrough emits a local header, signed data descriptor, central header and EOCD.
    const nextProjectedZipBytes = this.projectedZipBytes + bytes.byteLength + 92 + (2 * encodedPathBytes);
    if (nextProjectedZipBytes > RESOURCE_LIMITS.maxArchiveBytes) {
      throw new ResourceError("archive_too_large", "The generated ZIP archive exceeds the size limit.");
    }

    this.paths.add(path);
    this.entryCount = nextEntryCount;
    this.projectedUncompressedBytes = nextUncompressedBytes;
    this.projectedZipBytes = nextProjectedZipBytes;
    const entry = new ZipPassThrough(path);
    this.archive.add(entry);
    this.throwIfUnavailable();
    if (bytes.byteLength === 0) {
      entry.push(new Uint8Array(), true);
      this.throwIfUnavailable();
      return;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += ZIP_INPUT_CHUNK_BYTES) {
      this.throwIfUnavailable();
      const end = Math.min(offset + ZIP_INPUT_CHUNK_BYTES, bytes.byteLength);
      entry.push(bytes.subarray(offset, end), end === bytes.byteLength);
    }
    this.throwIfUnavailable();
  }

  finalize(): Promise<Blob> {
    try {
      this.throwIfUnavailable();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
      try {
        this.archive.end();
        if (this.failure) reject(this.failure);
        else if (this.result) resolve(this.result);
      } catch (error) {
        this.fail(error);
      }
    });
  }

  abort(error: unknown): void {
    this.fail(error);
  }
}

function unzipAsync(data: Uint8Array, signal?: AbortSignal): Promise<Record<string, Uint8Array>> {
  return runTerminable((callback) => unzip(data, callback), signal);
}

function safeResourcePath(resourceId: string, file: string): string {
  if (!RESOURCE_ID_PATTERN.test(resourceId)) throw new ResourceError("unsafe_archive", "Resource id is unsafe for export.");
  const path = `resources/${resourceId}/${file}`;
  assertSafeArchivePath(path);
  return path;
}

function safeArtifactPath(artifactId: string): string {
  if (!RESOURCE_ID_PATTERN.test(artifactId)) throw new ResourceError("unsafe_archive", "Artifact id is unsafe for export.");
  const path = `artifacts/${artifactId}/artifact.json`;
  assertSafeArchivePath(path);
  return path;
}

function hasCompatibleArtifactResources(
  artifact: ArtifactRecord,
  resources: ReadonlyMap<string, ResourceRecord>,
): boolean {
  const resource = resources.get(artifact.resourceId);
  const preview = artifact.previewResourceId ? resources.get(artifact.previewResourceId) : undefined;
  return Boolean(resource
    && resource.conversationId === artifact.conversationId
    && (!artifact.previewResourceId
      || (preview?.conversationId === artifact.conversationId && preview.kind === "image"))
    && (artifact.kind !== "svg-drawing" || resource.kind === "svg")
    && (artifact.kind !== "sticker" || resource.kind === "image"));
}

async function addEntry(
  writer: IncrementalZipWriter,
  entries: ResourceArchiveEntry[],
  input: Omit<ResourceArchiveEntry, "sha256" | "byteSize">,
  bytes: Uint8Array,
  knownSha256?: string,
): Promise<void> {
  assertSafeArchivePath(input.path);
  if (input.path === RESOURCE_ARCHIVE_MANIFEST) throw new ResourceError("unsafe_archive", "Manifest path is reserved.");
  if (bytes.byteLength > RESOURCE_LIMITS.maxArchiveEntryBytes) {
    throw new ResourceError("archive_too_large", `Archive entry '${input.path}' exceeds the per-entry size limit.`);
  }
  const entry = { ...input, byteSize: bytes.byteLength, sha256: knownSha256 ?? await sha256(bytes) };
  writer.writeEntry(input.path, bytes);
  entries.push(entry);
}

export async function exportResourceArchiveV2(input: ExportResourceArchiveInput): Promise<Blob> {
  input.signal?.throwIfAborted();
  const conversations = parseConversationPayload(input.conversations);
  const conversationIds = new Set(conversations.conversations.map((conversation) => conversation.id));
  const writer = new IncrementalZipWriter(input.signal);
  const entries: ResourceArchiveEntry[] = [];
  try {
    await addEntry(writer, entries, {
      path: "conversations.json",
      mediaType: "application/json",
      role: "conversations",
    }, jsonBytes(conversations));

    const resourceIds = new Set<string>();
    const resourceRecords = new Map<string, ResourceRecord>();
    for (const bundle of input.resources) {
      input.signal?.throwIfAborted();
      const resource = resourceRecordSchema.parse(bundle.resource);
      if (!conversationIds.has(resource.conversationId)) {
        throw new ResourceError("archive_integrity_failed", `Resource '${resource.id}' belongs to an unexported conversation.`);
      }
      if (resourceIds.has(resource.id)) {
        throw new ResourceError("archive_integrity_failed", `Duplicate resource '${resource.id}'.`);
      }
      resourceIds.add(resource.id);
      resourceRecords.set(resource.id, resource);
      if (bundle.blob.resourceId !== resource.id
        || bundle.blob.byteSize !== resource.byteSize
        || bundle.blob.mimeType !== resource.mimeType
        || bundle.blob.blob.size !== resource.byteSize
        || bundle.chunks.length !== resource.chunkCount
        || extractedTextLength(bundle.chunks) !== resource.textLength) {
        throw new ResourceError("archive_integrity_failed", `Resource '${resource.id}' bundle is inconsistent.`);
      }
      const original: Uint8Array = new Uint8Array(await bundle.blob.blob.arrayBuffer());
      input.signal?.throwIfAborted();
      const originalSha256 = await sha256(original);
      if (resource.status !== "ready" || !resource.sha256 || originalSha256 !== resource.sha256) {
        throw new ResourceError("archive_integrity_failed", `Resource '${resource.id}' does not match its stored hash.`);
      }
      let chunks;
      try {
        chunks = validateResourceChunkSequence(resource.id, bundle.chunks);
      } catch (error) {
        throw new ResourceError("archive_integrity_failed", `Resource '${resource.id}' has invalid chunks.`, {
          cause: error,
        });
      }
      await addEntry(writer, entries, {
        path: safeResourcePath(resource.id, "resource.json"),
        mediaType: "application/json",
        role: "resource-metadata",
        resourceId: resource.id,
      }, jsonBytes(resource));
      await addEntry(writer, entries, {
        path: safeResourcePath(resource.id, `original.${resource.extension}`),
        mediaType: resource.mimeType,
        role: "resource-original",
        resourceId: resource.id,
        ...(resource.kind === "svg" ? {
          sanitized: true as const,
          originalSha256: resource.originalSha256,
        } : {}),
      }, original, originalSha256);
      await addEntry(writer, entries, {
        path: safeResourcePath(resource.id, "extracted.json"),
        mediaType: "application/json",
        role: "resource-extracted",
        resourceId: resource.id,
      }, jsonBytes({ version: 1, resourceId: resource.id, chunks }));
    }

    const artifactIds = new Set<string>();
    for (const value of input.artifacts) {
      input.signal?.throwIfAborted();
      const artifact = artifactRecordSchema.parse(value);
      if (artifactIds.has(artifact.id)) {
        throw new ResourceError("archive_integrity_failed", `Duplicate artifact '${artifact.id}'.`);
      }
      artifactIds.add(artifact.id);
      if (!conversationIds.has(artifact.conversationId)
        || !hasCompatibleArtifactResources(artifact, resourceRecords)) {
        throw new ResourceError("archive_integrity_failed", `Artifact '${artifact.id}' has an unexported reference.`);
      }
      await addEntry(writer, entries, {
        path: safeArtifactPath(artifact.id),
        mediaType: "application/json",
        role: "artifact-metadata",
        artifactId: artifact.id,
      }, jsonBytes(artifact));
    }

    const manifest = archiveManifestSchema.parse({
      format: RESOURCE_ARCHIVE_FORMAT,
      version: RESOURCE_ARCHIVE_VERSION,
      exportedAt: input.exportedAt ?? new Date().toISOString(),
      entries,
    });
    writer.writeEntry(RESOURCE_ARCHIVE_MANIFEST, jsonBytes(manifest));
    input.signal?.throwIfAborted();
    const zipped = await writer.finalize();
    input.signal?.throwIfAborted();
    return zipped;
  } catch (error) {
    writer.abort(error);
    throw error;
  }
}

async function verifyManifestFiles(
  manifest: ResourceArchiveManifest,
  files: Record<string, Uint8Array>,
): Promise<void> {
  const expected = new Set([RESOURCE_ARCHIVE_MANIFEST]);
  for (const entry of manifest.entries) {
    assertSafeArchivePath(entry.path);
    if (expected.has(entry.path)) throw new ResourceError("archive_integrity_failed", `Duplicate manifest path '${entry.path}'.`);
    expected.add(entry.path);
    const bytes = files[entry.path];
    if (!bytes || bytes.byteLength !== entry.byteSize || await sha256(bytes) !== entry.sha256) {
      throw new ResourceError("archive_integrity_failed", `Archive entry '${entry.path}' failed integrity validation.`);
    }
  }
  const actual = Object.keys(files);
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) {
    throw new ResourceError("archive_integrity_failed", "The ZIP contains entries that are absent from manifest.json.");
  }
}

function oneEntry(
  entries: readonly ResourceArchiveEntry[],
  role: ResourceArchiveEntry["role"],
  owner?: { resourceId?: string; artifactId?: string },
): ResourceArchiveEntry {
  const matches = entries.filter((entry) => entry.role === role
    && (owner?.resourceId === undefined || entry.resourceId === owner.resourceId)
    && (owner?.artifactId === undefined || entry.artifactId === owner.artifactId));
  if (matches.length !== 1) {
    throw new ResourceError("archive_integrity_failed", `Expected exactly one '${role}' archive entry.`);
  }
  return matches[0];
}

function importLegacyJson(text: string): ImportedResourceArchive {
  return {
    conversations: parseConversationExport(text),
    resources: [],
    artifacts: [],
    legacyJson: true,
  };
}

export async function importResourceArchive(
  input: Blob | Uint8Array | string,
  signal?: AbortSignal,
): Promise<ImportedResourceArchive> {
  signal?.throwIfAborted();
  if (typeof input === "string") return importLegacyJson(input);
  // Import owns its working buffer because worker validation transfers it temporarily.
  let bytes: Uint8Array = input instanceof Blob
    ? new Uint8Array(await input.arrayBuffer())
    : Uint8Array.from(input);
  if (bytes.byteLength > RESOURCE_LIMITS.maxArchiveBytes) {
    throw new ResourceError("archive_too_large", "The selected archive exceeds the size limit.");
  }
  const first = bytes.find((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d);
  if (first === 0x7b) {
    return importLegacyJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  const inspection = inspectZipArchive(bytes, defaultArchiveSafetyLimits);
  bytes = await verifyZipArchiveContents(bytes, inspection, defaultArchiveSafetyLimits, { signal });
  let files: Record<string, Uint8Array>;
  try {
    files = await unzipAsync(bytes, signal);
  } catch (error) {
    if (signal?.aborted) throw abortError(signal);
    throw new ResourceError("unsafe_archive", "The ZIP archive could not be safely expanded.", { cause: error });
  }
  signal?.throwIfAborted();
  assertInflatedEntriesMatchInspection(files, inspection, defaultArchiveSafetyLimits);
  const manifestBytes = files[RESOURCE_ARCHIVE_MANIFEST];
  if (!manifestBytes) throw new ResourceError("archive_integrity_failed", "The ZIP has no root manifest.json.");
  const manifest = archiveValue(
    archiveManifestSchema,
    jsonValue(manifestBytes, "manifest.json"),
    "manifest.json",
  );
  await verifyManifestFiles(manifest, files);

  const conversationsEntry = oneEntry(manifest.entries, "conversations");
  if (conversationsEntry.path !== "conversations.json" || conversationsEntry.mediaType !== "application/json") {
    throw new ResourceError("archive_integrity_failed", "The conversations entry has an invalid path or media type.");
  }
  const conversations = parseConversationExport(
    new TextDecoder("utf-8", { fatal: true }).decode(files[conversationsEntry.path]),
  );
  const conversationIds = new Set(conversations.conversations.map((conversation) => conversation.id));

  const resourceIds = new Set(manifest.entries.flatMap((entry) => entry.resourceId ? [entry.resourceId] : []));
  const resources: ResourceBundle[] = [];
  for (const resourceId of resourceIds) {
    const metadataEntry = oneEntry(manifest.entries, "resource-metadata", { resourceId });
    const originalEntry = oneEntry(manifest.entries, "resource-original", { resourceId });
    const extractedEntry = oneEntry(manifest.entries, "resource-extracted", { resourceId });
    const resource = archiveValue(
      resourceRecordSchema,
      jsonValue(files[metadataEntry.path], metadataEntry.path),
      metadataEntry.path,
    );
    const extracted = archiveValue(
      extractedResourceSchema,
      jsonValue(files[extractedEntry.path], extractedEntry.path),
      extractedEntry.path,
    );
    const original = files[originalEntry.path];
    if (resource.id !== resourceId
      || metadataEntry.path !== safeResourcePath(resourceId, "resource.json")
      || metadataEntry.mediaType !== "application/json"
      || originalEntry.path !== safeResourcePath(resourceId, `original.${resource.extension}`)
      || extractedEntry.path !== safeResourcePath(resourceId, "extracted.json")
      || extractedEntry.mediaType !== "application/json"
      || extracted.resourceId !== resourceId
      || original.byteLength !== resource.byteSize
      || originalEntry.mediaType !== resource.mimeType
      || resource.status !== "ready"
      || !resource.sha256
      || await sha256(original) !== resource.sha256
      || (resource.kind === "svg"
        ? originalEntry.sanitized !== true || originalEntry.originalSha256 !== resource.originalSha256
        : originalEntry.sanitized !== undefined
          || originalEntry.originalSha256 !== undefined
      || resource.originalByteSize !== resource.byteSize)
      || extracted.chunks.length !== resource.chunkCount
      || extractedTextLength(extracted.chunks) !== resource.textLength
      || !conversationIds.has(resource.conversationId)) {
      throw new ResourceError("archive_integrity_failed", `Resource '${resourceId}' failed cross-reference validation.`);
    }
    const originalBlobBytes = new Uint8Array(original.byteLength);
    originalBlobBytes.set(original);
    let chunks;
    try {
      chunks = validateResourceChunkSequence(resourceId, extracted.chunks);
    } catch (error) {
      throw new ResourceError("archive_integrity_failed", `Resource '${resourceId}' has invalid chunks.`, {
        cause: error,
      });
    }
    resources.push({
      resource,
      blob: {
        resourceId,
        blob: new Blob([originalBlobBytes], { type: resource.mimeType }),
        byteSize: original.byteLength,
        mimeType: resource.mimeType,
      },
      chunks,
    });
  }

  const artifactEntries = manifest.entries.filter((entry) => entry.role === "artifact-metadata");
  const artifacts = artifactEntries.map((entry) => {
    const artifact = archiveValue(
      artifactRecordSchema,
      jsonValue(files[entry.path], entry.path),
      entry.path,
    );
    if (entry.artifactId !== artifact.id
      || entry.path !== safeArtifactPath(artifact.id)
      || entry.mediaType !== "application/json") {
      throw new ResourceError("archive_integrity_failed", `Artifact entry '${entry.path}' has inconsistent identity.`);
    }
    return artifact;
  });
  const artifactIds = new Set<string>();
  const importedResourceRecords = new Map(resources.map((bundle) => [bundle.resource.id, bundle.resource]));
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.id)
      || !conversationIds.has(artifact.conversationId)
      || !hasCompatibleArtifactResources(artifact, importedResourceRecords)) {
      throw new ResourceError("archive_integrity_failed", `Artifact '${artifact.id}' failed cross-reference validation.`);
    }
    artifactIds.add(artifact.id);
  }

  return { manifest, conversations, resources, artifacts, legacyJson: false };
}
