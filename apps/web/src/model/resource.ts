import { z } from "zod";
import type { ResourceRef } from "@live2d-chat/shared";

export const resourceKinds = [
  "pdf",
  "docx",
  "pptx",
  "text",
  "image",
  "svg",
  "web",
  "video-transcript",
] as const;

export type ResourceKind = (typeof resourceKinds)[number];

export const resourceOrigins = ["upload", "generated", "web", "video"] as const;
export type ResourceOrigin = (typeof resourceOrigins)[number];
export const resourceStatuses = ["pending", "processing", "ready", "error"] as const;
export type ResourceStatus = (typeof resourceStatuses)[number];

export const RESOURCE_ID_PATTERN = /^(?!(?:__proto__|prototype|constructor)$)[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const RESOURCE_READ_MAX_CHARS = 12_000;
export const RESOURCE_CHUNK_TARGET_CHARS = 4_000;

export const httpUrlSchema = z.string().url().max(4_000).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}, "Only HTTP and HTTPS URLs without embedded credentials are supported.");

export const resourceLocatorSchema = z.object({
  page: z.number().int().positive().max(300).optional(),
  slide: z.number().int().positive().max(300).optional(),
  startChar: z.number().int().nonnegative().optional(),
  endChar: z.number().int().nonnegative().optional(),
  startSeconds: z.number().finite().nonnegative().optional(),
  endSeconds: z.number().finite().nonnegative().optional(),
  label: z.string().trim().max(500).optional(),
}).strict().superRefine((locator, context) => {
  if (locator.page !== undefined && locator.slide !== undefined) {
    context.addIssue({ code: "custom", message: "A locator cannot target both a page and a slide." });
  }
  if (locator.endChar !== undefined && locator.startChar !== undefined && locator.endChar < locator.startChar) {
    context.addIssue({ code: "custom", message: "endChar must not be earlier than startChar." });
  }
  if (locator.endSeconds !== undefined
    && locator.startSeconds !== undefined
    && locator.endSeconds < locator.startSeconds) {
    context.addIssue({ code: "custom", message: "endSeconds must not be earlier than startSeconds." });
  }
});

export type ResourceLocator = z.infer<typeof resourceLocatorSchema>;

export const resourceMetadataSchema = z.object({
  pageCount: z.number().int().positive().max(300).optional(),
  slideCount: z.number().int().positive().max(300).optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
  durationSeconds: z.number().finite().nonnegative().optional(),
  title: z.string().trim().max(1_000).optional(),
  author: z.string().trim().max(1_000).optional(),
  description: z.string().trim().max(5_000).optional(),
  progress: z.object({
    value: z.number().finite().min(0).max(1).optional(),
    label: z.string().trim().min(1).max(200).optional(),
  }).strict().optional(),
  providerJob: z.object({
    provider: z.literal("supadata"),
    id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/),
    language: z.string().trim().min(2).max(35).optional(),
  }).strict().optional(),
}).strict();

export type ResourceMetadata = z.infer<typeof resourceMetadataSchema>;

export const resourceRecordSchema = z.object({
  id: z.string().regex(RESOURCE_ID_PATTERN),
  conversationId: z.string().trim().min(1).max(100),
  kind: z.enum(resourceKinds),
  origin: z.enum(resourceOrigins),
  name: z.string().trim().min(1).max(500),
  mimeType: z.string().trim().min(1).max(200),
  extension: z.string().regex(/^[a-z0-9]{1,12}$/),
  status: z.enum(resourceStatuses),
  errorMessage: z.string().trim().min(1).max(2_000).optional(),
  byteSize: z.number().int().nonnegative(),
  originalByteSize: z.number().int().nonnegative(),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  originalSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  textLength: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  sourceUrl: httpUrlSchema.optional(),
  metadata: resourceMetadataSchema.default({}),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((resource, context) => {
  if (resource.updatedAt < resource.createdAt) {
    context.addIssue({ code: "custom", message: "updatedAt must not be earlier than createdAt.", path: ["updatedAt"] });
  }
  if (resource.status === "ready" && !resource.sha256) {
    context.addIssue({ code: "custom", message: "Ready resources require a SHA-256 hash.", path: ["sha256"] });
  }
  if (resource.status === "error" && !resource.errorMessage) {
    context.addIssue({ code: "custom", message: "Failed resources require an error message.", path: ["errorMessage"] });
  }
  if (resource.status !== "error" && resource.errorMessage) {
    context.addIssue({
      code: "custom",
      message: "Only failed resources may retain an error message.",
      path: ["errorMessage"],
    });
  }
  if (resource.kind === "svg" && resource.status === "ready" && !resource.originalSha256) {
    context.addIssue({
      code: "custom",
      message: "Sanitized SVG resources require the hash of their original input.",
      path: ["originalSha256"],
    });
  }
  if (resource.kind !== "svg" && resource.originalSha256) {
    context.addIssue({
      code: "custom",
      message: "Only sanitized SVG resources may retain an original input hash.",
      path: ["originalSha256"],
    });
  }
});

export type ResourceRecord = z.infer<typeof resourceRecordSchema>;

export const resourceChunkSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,220}$/),
  resourceId: z.string().regex(RESOURCE_ID_PATTERN),
  index: z.number().int().nonnegative(),
  text: z.string().min(1).max(100_000),
  locator: resourceLocatorSchema,
}).strict();

export type ResourceChunk = z.infer<typeof resourceChunkSchema>;

export interface ResourceBlobRecord {
  resourceId: string;
  blob: Blob;
  byteSize: number;
  mimeType: string;
}

export interface ResourceBundle {
  resource: ResourceRecord;
  blob: ResourceBlobRecord;
  chunks: ResourceChunk[];
}

export interface ReadResourceRequest {
  cursor?: string;
  locator?: ResourceLocator;
  query?: string;
  maxChars?: number;
}

export interface ReadResourceResult {
  resource: Pick<ResourceRecord, "id" | "kind" | "name" | "mimeType" | "metadata" | "status">;
  text: string;
  locator?: ResourceLocator;
  nextCursor?: string;
  truncated: boolean;
}

export function createResourceId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `resource-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createPendingResource(input: {
  conversationId: string;
  kind: ResourceKind;
  origin: ResourceOrigin;
  name: string;
  mimeType: string;
  extension: string;
  sourceUrl?: string;
  resourceId?: string;
  now?: number;
}): ResourceRecord {
  const now = input.now ?? Date.now();
  return resourceRecordSchema.parse({
    id: input.resourceId ?? createResourceId(),
    conversationId: input.conversationId,
    kind: input.kind,
    origin: input.origin,
    name: input.name,
    mimeType: input.mimeType,
    extension: input.extension,
    status: "pending",
    byteSize: 0,
    originalByteSize: 0,
    textLength: 0,
    chunkCount: 0,
    sourceUrl: input.sourceUrl,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
}

export function createResourceChunkId(resourceId: string, index: number): string {
  return `${resourceId}:${index}`;
}

export function toResourceRef(resource: ResourceRecord, status: ResourceStatus = resource.status): ResourceRef {
  return {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    mediaType: resource.mimeType,
    size: resource.originalByteSize,
    status,
  };
}
