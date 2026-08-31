import { z } from "zod";
import type { ArtifactRef } from "@live2d-chat/shared";
import { httpUrlSchema, RESOURCE_ID_PATTERN, resourceLocatorSchema } from "./resource";

export const artifactKinds = [
  "resource-view",
  "svg-drawing",
  "sticker",
] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

export const artifactRecordSchema = z.object({
  id: z.string().regex(RESOURCE_ID_PATTERN),
  conversationId: z.string().trim().min(1).max(100),
  kind: z.enum(artifactKinds),
  title: z.string().trim().min(1).max(500),
  resourceId: z.string().regex(RESOURCE_ID_PATTERN),
  previewResourceId: z.string().regex(RESOURCE_ID_PATTERN).optional(),
  sourceUrl: httpUrlSchema.optional(),
  locator: resourceLocatorSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().refine((artifact) => artifact.updatedAt >= artifact.createdAt, {
  message: "updatedAt must not be earlier than createdAt.",
  path: ["updatedAt"],
}).refine((artifact) => artifact.previewResourceId !== artifact.resourceId, {
  message: "An artifact preview must be a separate inert resource.",
  path: ["previewResourceId"],
});

export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;

export function createArtifactId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `artifact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function toArtifactRef(artifact: ArtifactRecord): ArtifactRef {
  return {
    id: artifact.id,
    resourceId: artifact.resourceId,
    kind: artifact.kind,
  };
}
