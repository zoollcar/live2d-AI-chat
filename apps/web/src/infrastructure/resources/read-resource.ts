import {
  RESOURCE_READ_MAX_CHARS,
  resourceLocatorSchema,
  type ReadResourceRequest,
  type ReadResourceResult,
  type ResourceChunk,
  type ResourceLocator,
  type ResourceRecord,
} from "@/model/resource";
import { ResourceError } from "./errors";

interface CursorPayload {
  v: 1;
  resourceId: string;
  chunkIndex: number;
  offset: number;
  includeSeparator?: boolean;
  locator?: ResourceLocator;
  query?: string;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

function encodeCursor(payload: CursorPayload): string {
  return encodeBase64Url(JSON.stringify(payload));
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    if (cursor.length > 2_000) throw new Error("Cursor is too long.");
    const value = JSON.parse(decodeBase64Url(cursor)) as Partial<CursorPayload>;
    if (value.v !== 1
      || typeof value.resourceId !== "string"
      || !Number.isInteger(value.chunkIndex)
      || (value.chunkIndex ?? -1) < 0
      || !Number.isInteger(value.offset)
      || (value.offset ?? -1) < 0
      || (value.includeSeparator !== undefined && typeof value.includeSeparator !== "boolean")
      || (value.query !== undefined
        && (typeof value.query !== "string"
          || value.query !== value.query.trim()
          || !value.query
          || value.query.length > 500))) {
      throw new Error("Invalid cursor payload.");
    }
    return {
      v: 1,
      resourceId: value.resourceId,
      chunkIndex: value.chunkIndex!,
      offset: value.offset!,
      ...(value.includeSeparator ? { includeSeparator: true } : {}),
      ...(value.locator === undefined ? {} : { locator: resourceLocatorSchema.parse(value.locator) }),
      ...(value.query === undefined ? {} : { query: value.query }),
    };
  } catch (error) {
    throw new ResourceError("invalid_cursor", "The resource cursor is invalid or expired.", { cause: error });
  }
}

function locatorMatches(chunk: ResourceChunk, target: ResourceLocator | undefined): boolean {
  if (!target) return true;
  const locator = chunk.locator;
  if (target.page !== undefined && locator.page !== target.page) return false;
  if (target.slide !== undefined && locator.slide !== target.slide) return false;
  if (target.label !== undefined && locator.label !== target.label) return false;
  if (target.startChar !== undefined && (locator.endChar ?? 0) <= target.startChar) return false;
  if (target.endChar !== undefined && (locator.startChar ?? Number.MAX_SAFE_INTEGER) >= target.endChar) return false;
  if (target.startSeconds !== undefined && (locator.endSeconds ?? 0) <= target.startSeconds) return false;
  if (target.endSeconds !== undefined && (locator.startSeconds ?? Number.MAX_SAFE_INTEGER) >= target.endSeconds) return false;
  return true;
}

function sameLocator(left: ResourceLocator | undefined, right: ResourceLocator | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function needsChunkSeparator(previous: ResourceChunk, current: ResourceChunk): boolean {
  const previousEnd = previous.locator.endChar;
  const currentStart = current.locator.startChar;
  return previousEnd === undefined || currentStart === undefined || currentStart > previousEnd;
}

function resultLocator(
  first: { chunk: ResourceChunk; offset: number } | undefined,
  last: { chunk: ResourceChunk; consumed: number; offset: number } | undefined,
): ResourceLocator | undefined {
  if (!first || !last) return undefined;
  const firstLocator = first.chunk.locator;
  const lastLocator = last.chunk.locator;
  return {
    ...((firstLocator.page !== undefined && firstLocator.page === lastLocator.page)
      ? { page: firstLocator.page }
      : {}),
    ...((firstLocator.slide !== undefined && firstLocator.slide === lastLocator.slide)
      ? { slide: firstLocator.slide }
      : {}),
    ...((firstLocator.label !== undefined && firstLocator.label === lastLocator.label)
      ? { label: firstLocator.label }
      : {}),
    startChar: (firstLocator.startChar ?? 0) + first.offset,
    endChar: (lastLocator.startChar ?? 0) + last.offset + last.consumed,
    ...(firstLocator.startSeconds === undefined ? {} : { startSeconds: firstLocator.startSeconds }),
    ...(lastLocator.endSeconds === undefined ? {} : { endSeconds: lastLocator.endSeconds }),
  };
}

export function readResourceChunks(
  resource: ResourceRecord,
  chunks: readonly ResourceChunk[],
  request: ReadResourceRequest = {},
): ReadResourceResult {
  const maxChars = request.maxChars ?? RESOURCE_READ_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars <= 0 || maxChars > RESOURCE_READ_MAX_CHARS) {
    throw new RangeError(`maxChars must be between 1 and ${RESOURCE_READ_MAX_CHARS}.`);
  }
  const query = request.query?.trim();
  if (request.query !== undefined && (!query || request.query.length > 500)) {
    throw new RangeError("query must contain between 1 and 500 characters.");
  }

  const cursor = request.cursor ? decodeCursor(request.cursor) : undefined;
  if (cursor && cursor.resourceId !== resource.id) {
    throw new ResourceError("invalid_cursor", "The cursor belongs to a different resource.");
  }
  if (cursor && request.locator && !sameLocator(cursor.locator, request.locator)) {
    throw new ResourceError("invalid_cursor", "The cursor locator does not match this read request.");
  }
  if (cursor && query !== undefined && cursor.query !== query) {
    throw new ResourceError("invalid_cursor", "The cursor query does not match this read request.");
  }
  const locator = request.locator ?? cursor?.locator;
  const effectiveQuery = query ?? cursor?.query;
  const queryNeedle = effectiveQuery?.toLowerCase();
  const ordered = [...chunks]
    .filter((chunk) => chunk.resourceId === resource.id
      && locatorMatches(chunk, locator)
      && (!queryNeedle || chunk.text.toLowerCase().includes(queryNeedle)))
    .sort((left, right) => left.index - right.index);

  let startPosition = 0;
  if (cursor) {
    startPosition = ordered.findIndex((chunk) => chunk.index >= cursor.chunkIndex);
    if (startPosition < 0) startPosition = ordered.length;
  }

  let remaining = maxChars;
  let text = "";
  let next: CursorPayload | undefined;
  let first: { chunk: ResourceChunk; offset: number } | undefined;
  let last: { chunk: ResourceChunk; consumed: number; offset: number } | undefined;

  for (let position = startPosition; position < ordered.length && remaining > 0; position += 1) {
    const chunk = ordered[position];
    const initialOffset = cursor && chunk.index === cursor.chunkIndex ? cursor.offset : 0;
    if (initialOffset > chunk.text.length) {
      throw new ResourceError("invalid_cursor", "The cursor points beyond the stored resource text.");
    }
    const separator = position > startPosition
      ? (needsChunkSeparator(ordered[position - 1], chunk) ? "\n" : "")
      : cursor?.includeSeparator
        ? "\n"
        : "";
    if (separator) {
      text += separator;
      remaining -= separator.length;
      if (remaining === 0) {
        next = {
          v: 1,
          resourceId: resource.id,
          chunkIndex: chunk.index,
          offset: initialOffset,
          locator,
          query: effectiveQuery,
        };
        break;
      }
    }
    const available = chunk.text.slice(initialOffset);
    const consumed = Math.min(available.length, remaining);
    if (!first) first = { chunk, offset: initialOffset };
    text += available.slice(0, consumed);
    remaining -= consumed;
    last = { chunk, consumed, offset: initialOffset };
    if (consumed < available.length) {
      next = {
        v: 1,
        resourceId: resource.id,
        chunkIndex: chunk.index,
        offset: initialOffset + consumed,
        locator,
        query: effectiveQuery,
      };
      break;
    }
    const following = ordered[position + 1];
    if (remaining === 0 && following) {
      next = {
        v: 1,
        resourceId: resource.id,
        chunkIndex: following.index,
        offset: 0,
        ...(needsChunkSeparator(chunk, following) ? { includeSeparator: true } : {}),
        locator,
        query: effectiveQuery,
      };
    }
  }

  return {
    resource: {
      id: resource.id,
      kind: resource.kind,
      name: resource.name,
      mimeType: resource.mimeType,
      metadata: resource.metadata,
      status: resource.status,
    },
    text,
    locator: resultLocator(first, last),
    nextCursor: next ? encodeCursor(next) : undefined,
    truncated: Boolean(next),
  };
}
