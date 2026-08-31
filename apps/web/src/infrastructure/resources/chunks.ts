import {
  createResourceChunkId,
  RESOURCE_CHUNK_TARGET_CHARS,
  resourceChunkSchema,
  type ResourceChunk,
  type ResourceLocator,
} from "@/model/resource";
import { ResourceError } from "./errors";
import { RESOURCE_LIMITS } from "./limits";

export interface ExtractedResourceSection {
  text: string;
  locator?: Omit<ResourceLocator, "startChar" | "endChar">;
}

function splitText(text: string, maxChars: number): string[] {
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const newline = window.lastIndexOf("\n");
    const whitespace = window.search(/\s(?=\S*$)/);
    const boundary = newline >= Math.floor(maxChars * 0.5)
      ? newline + 1
      : whitespace >= Math.floor(maxChars * 0.5)
        ? whitespace + 1
        : maxChars;
    result.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary);
  }
  if (remaining) result.push(remaining);
  return result;
}

export function buildResourceChunks(
  resourceId: string,
  sections: readonly ExtractedResourceSection[],
  targetChars = RESOURCE_CHUNK_TARGET_CHARS,
): ResourceChunk[] {
  if (!Number.isInteger(targetChars) || targetChars < 256 || targetChars > 100_000) {
    throw new RangeError("Resource chunk size must be between 256 and 100000 characters.");
  }
  const total = sections.reduce((sum, section) => sum + section.text.length, 0);
  if (total > RESOURCE_LIMITS.maxExtractedChars) {
    throw new ResourceError(
      "extracted_text_too_large",
      `Extracted text exceeds ${RESOURCE_LIMITS.maxExtractedChars.toLocaleString()} characters.`,
    );
  }

  const chunks: ResourceChunk[] = [];
  let globalOffset = 0;
  for (const section of sections) {
    const normalized = section.text
      .replace(/\r\n?/g, "\n")
      .split(String.fromCharCode(0))
      .join("")
      .trim();
    if (!normalized) continue;
    for (const part of splitText(normalized, targetChars)) {
      const index = chunks.length;
      const startChar = globalOffset;
      const endChar = startChar + part.length;
      chunks.push({
        id: createResourceChunkId(resourceId, index),
        resourceId,
        index,
        text: part,
        locator: { ...section.locator, startChar, endChar },
      });
      globalOffset = endChar;
    }
    globalOffset += 1;
  }
  return chunks;
}

export function extractedTextLength(chunks: readonly ResourceChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.text.length, 0);
}

export function validateResourceChunkSequence(
  resourceId: string,
  values: readonly ResourceChunk[],
): ResourceChunk[] {
  return values.map((value, index) => {
    const chunk = resourceChunkSchema.parse(value);
    if (chunk.resourceId !== resourceId
      || chunk.index !== index
      || chunk.id !== createResourceChunkId(resourceId, index)) {
      throw new ResourceError(
        "storage_failed",
        `Resource '${resourceId}' has an invalid or non-contiguous chunk sequence.`,
      );
    }
    return chunk;
  });
}
