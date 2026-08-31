import { unzipSync } from "fflate";
import { ResourceError, type ResourceErrorCode } from "./errors";
import { RESOURCE_LIMITS } from "./limits";
import {
  validateZipEntryStreams,
  type ZipStreamEntryInfo,
} from "./zip-validation-core";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR_HEADER = 0x08074b50;
const MAX_EOCD_SEARCH = 65_557;
const SUPPORTED_GENERAL_FLAGS = 0x080e;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const UNIX_PLATFORM = 3;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_SYMLINK_TYPE = 0xa000;
const DEFAULT_VALIDATION_TIMEOUT_MS = RESOURCE_LIMITS.officeProcessingTimeoutMs;
const MAX_RELATIONSHIP_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_RELATIONSHIP_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_RELATIONSHIP_ELEMENTS = 20_000;
const RELATIONSHIP_TAG = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const EXTERNAL_TARGET = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[\\/]{2})/;

export interface ZipSafetyLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

export type ZipEntryInfo = ZipStreamEntryInfo;

export interface ZipInspection {
  entries: ZipEntryInfo[];
  compressedBytes: number;
  uncompressedBytes: number;
}

export interface ZipValidationWorker {
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export type ZipValidationWorkerFactory = () => ZipValidationWorker;

export interface VerifyZipArchiveOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  workerFactory?: ZipValidationWorkerFactory;
}

export const defaultArchiveSafetyLimits: ZipSafetyLimits = {
  maxArchiveBytes: RESOURCE_LIMITS.maxArchiveBytes,
  maxEntries: RESOURCE_LIMITS.maxArchiveEntries,
  maxEntryBytes: RESOURCE_LIMITS.maxArchiveEntryBytes,
  maxUncompressedBytes: RESOURCE_LIMITS.maxArchiveUncompressedBytes,
  maxCompressionRatio: RESOURCE_LIMITS.maxCompressionRatio,
};

export const officeArchiveSafetyLimits: ZipSafetyLimits = {
  ...defaultArchiveSafetyLimits,
  maxArchiveBytes: RESOURCE_LIMITS.officeBytes,
  maxUncompressedBytes: RESOURCE_LIMITS.maxOfficeUncompressedBytes,
};

function findEndOfCentralDirectory(view: DataView): number {
  const lowerBound = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function assertSafeArchivePath(path: string): void {
  if (!path
    || path.length > 1_000
    || path.includes("\0")
    || path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
    || hasControlCharacters(path)) {
    throw new ResourceError("unsafe_archive", `Archive entry has an unsafe path: '${path}'.`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === ""
    || segment === "."
    || segment === ".."
    || segment === "__proto__"
    || segment === "prototype"
    || segment === "constructor")) {
    throw new ResourceError("unsafe_archive", `Archive entry has an unsafe path: '${path}'.`);
  }
}

export function inspectZipArchive(
  bytes: Uint8Array,
  limits: ZipSafetyLimits = defaultArchiveSafetyLimits,
): ZipInspection {
  if (bytes.byteLength > limits.maxArchiveBytes) {
    throw new ResourceError("archive_too_large", "The ZIP archive exceeds the compressed size limit.");
  }
  if (bytes.byteLength < 22) throw new ResourceError("unsafe_archive", "The ZIP archive is truncated.");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new ResourceError("unsafe_archive", "The ZIP central directory was not found.");

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount) {
    throw new ResourceError("unsafe_archive", "Multi-disk ZIP archives are not supported.");
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ResourceError("unsafe_archive", "ZIP64 archives are not supported.");
  }
  if (entryCount > limits.maxEntries) {
    throw new ResourceError("archive_too_large", `The ZIP archive contains more than ${limits.maxEntries} entries.`);
  }
  if (eocd + 22 + commentLength !== bytes.byteLength
    || directoryOffset + directorySize !== eocd
    || directoryOffset + directorySize > bytes.byteLength) {
    throw new ResourceError("unsafe_archive", "The ZIP central directory points outside the archive.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntryInfo[] = [];
  const paths = new Set<string>();
  const localRanges: Array<{ start: number; end: number; path: string }> = [];
  let offset = directoryOffset;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      throw new ResourceError("unsafe_archive", "The ZIP central directory is malformed.");
    }
    const versionMadeBy = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const startingDisk = view.getUint16(offset + 34, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.byteLength) {
      throw new ResourceError("unsafe_archive", "The ZIP entry metadata is truncated.");
    }
    if ((flags & 0x1) !== 0) throw new ResourceError("unsafe_archive", "Encrypted ZIP entries are not supported.");
    if ((flags & ~SUPPORTED_GENERAL_FLAGS) !== 0) {
      throw new ResourceError("unsafe_archive", "A ZIP entry uses unsupported general-purpose flags.");
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new ResourceError("unsafe_archive", `ZIP compression method ${compressionMethod} is not supported.`);
    }
    if (compressionMethod === 0 && (flags & 0x0006) !== 0) {
      throw new ResourceError("unsafe_archive", "Stored ZIP entries must not declare DEFLATE options.");
    }
    if (startingDisk !== 0) throw new ResourceError("unsafe_archive", "Multi-disk ZIP entries are not supported.");
    if ((versionMadeBy >>> 8) === UNIX_PLATFORM
      && ((externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK_TYPE) {
      throw new ResourceError("unsafe_archive", "Symbolic links are not supported in ZIP archives.");
    }
    let path: string;
    try {
      path = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch (error) {
      throw new ResourceError("unsafe_archive", "A ZIP entry name is not valid UTF-8.", { cause: error });
    }
    const isDirectory = path.endsWith("/");
    const normalizedPath = isDirectory ? path.slice(0, -1) : path;
    assertSafeArchivePath(normalizedPath);
    if (paths.has(path)) throw new ResourceError("unsafe_archive", `Duplicate ZIP entry '${path}'.`);
    paths.add(path);

    if (localHeaderOffset + 30 > directoryOffset
      || view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER) {
      throw new ResourceError("unsafe_archive", `ZIP entry '${path}' has an invalid local header.`);
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localCompressionMethod = view.getUint16(localHeaderOffset + 8, true);
    const localCrc32 = view.getUint32(localHeaderOffset + 14, true);
    const localCompressedSize = view.getUint32(localHeaderOffset + 18, true);
    const localUncompressedSize = view.getUint32(localHeaderOffset + 22, true);
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const localDataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags
      || localCompressionMethod !== compressionMethod
      || localDataOffset + compressedSize > directoryOffset) {
      throw new ResourceError("unsafe_archive", `ZIP entry '${path}' has inconsistent local metadata.`);
    }
    let localPath: string;
    try {
      localPath = decoder.decode(bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength));
    } catch (error) {
      throw new ResourceError("unsafe_archive", "A ZIP local entry name is not valid UTF-8.", { cause: error });
    }
    if (localPath !== path) {
      throw new ResourceError("unsafe_archive", `ZIP entry '${path}' has mismatched local and central paths.`);
    }

    const usesDataDescriptor = (flags & DATA_DESCRIPTOR_FLAG) !== 0;
    if (!usesDataDescriptor) {
      if (localCrc32 !== crc32
        || localCompressedSize !== compressedSize
        || localUncompressedSize !== uncompressedSize) {
        throw new ResourceError("unsafe_archive", `ZIP entry '${path}' has mismatched local and central sizes or CRC.`);
      }
    } else if ((localCrc32 !== 0 && localCrc32 !== crc32)
      || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
      || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)) {
      throw new ResourceError("unsafe_archive", `ZIP entry '${path}' has inconsistent local descriptor metadata.`);
    }

    let localRecordEnd = localDataOffset + compressedSize;
    if (usesDataDescriptor) {
      const descriptorOffset = localRecordEnd;
      const matchesDescriptor = (valueOffset: number) => valueOffset + 12 <= directoryOffset
        && view.getUint32(valueOffset, true) === crc32
        && view.getUint32(valueOffset + 4, true) === compressedSize
        && view.getUint32(valueOffset + 8, true) === uncompressedSize;
      const signedValueOffset = descriptorOffset + 4;
      const hasValidSignedDescriptor = descriptorOffset + 4 <= directoryOffset
        && view.getUint32(descriptorOffset, true) === DATA_DESCRIPTOR_HEADER
        && matchesDescriptor(signedValueOffset);
      const valueOffset = hasValidSignedDescriptor
        ? signedValueOffset
        : matchesDescriptor(descriptorOffset)
          ? descriptorOffset
          : undefined;
      if (valueOffset === undefined) {
        throw new ResourceError("unsafe_archive", `ZIP entry '${path}' has an invalid data descriptor.`);
      }
      localRecordEnd = valueOffset + 12;
    }
    localRanges.push({ start: localHeaderOffset, end: localRecordEnd, path });

    if (!isDirectory) {
      if (compressionMethod === 0 && compressedSize !== uncompressedSize) {
        throw new ResourceError("unsafe_archive", `Stored ZIP entry '${path}' has inconsistent sizes.`);
      }
      if (uncompressedSize > limits.maxEntryBytes) {
        throw new ResourceError("archive_too_large", `ZIP entry '${path}' exceeds the per-entry size limit.`);
      }
      const ratio = uncompressedSize / Math.max(1, compressedSize);
      if (uncompressedSize > 1024 * 1024 && ratio > limits.maxCompressionRatio) {
        throw new ResourceError("unsafe_archive", `ZIP entry '${path}' has a suspicious compression ratio.`);
      }
      compressedBytes += compressedSize;
      uncompressedBytes += uncompressedSize;
      if (uncompressedBytes > limits.maxUncompressedBytes) {
        throw new ResourceError("archive_too_large", "The ZIP archive exceeds the expanded size limit.");
      }
      entries.push({
        path,
        compressedSize,
        uncompressedSize,
        compressionMethod,
        crc32,
        dataOffset: localDataOffset,
      });
    } else if (compressedSize !== 0 || uncompressedSize !== 0 || crc32 !== 0) {
      throw new ResourceError("unsafe_archive", `ZIP directory entry '${path}' must be empty.`);
    }
    offset = nextOffset;
  }

  if (offset !== directoryOffset + directorySize) {
    throw new ResourceError("unsafe_archive", "The ZIP central directory contains trailing or missing metadata.");
  }
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    const previous = localRanges[index - 1];
    const current = localRanges[index];
    if (current.start < previous.end) {
      throw new ResourceError(
        "unsafe_archive",
        `ZIP entries '${previous.path}' and '${current.path}' have overlapping local data.`,
      );
    }
  }

  return { entries, compressedBytes, uncompressedBytes };
}

const RESOURCE_ERROR_CODES = new Set<ResourceErrorCode>([
  "unsupported_file",
  "invalid_file",
  "file_too_large",
  "too_many_pages",
  "too_many_slides",
  "extracted_text_too_large",
  "unsafe_svg",
  "unsafe_archive",
  "archive_too_large",
  "archive_integrity_failed",
  "resource_not_found",
  "invalid_cursor",
  "storage_failed",
]);

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultValidationWorkerFactory(): ZipValidationWorker {
  return new Worker(new URL("./zip-validation.worker.ts", import.meta.url), {
    type: "module",
    name: "live2d-zip-validator",
  });
}

function validationRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `zip-validation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function validationTimeout(options: VerifyZipArchiveOptions): number {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS, DEFAULT_VALIDATION_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("ZIP validation timeout must be a positive number.");
  }
  return timeoutMs;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("ZIP validation was cancelled.", "AbortError");
}

function transferableArchiveBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.buffer instanceof ArrayBuffer
    && bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return Uint8Array.from(bytes).buffer;
}

/**
 * Verifies actual expanded size and CRC in an isolated worker before any general ZIP or Office
 * parser receives the archive. The validated buffer is transferred back to avoid retaining a
 * second full archive copy.
 */
export async function verifyZipArchiveContents(
  bytes: Uint8Array,
  inspection: ZipInspection,
  limits: ZipSafetyLimits = defaultArchiveSafetyLimits,
  options: VerifyZipArchiveOptions = {},
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const timeoutMs = validationTimeout(options);
  const canUseWorker = options.workerFactory || typeof Worker !== "undefined";
  if (!canUseWorker) {
    const startedAt = monotonicNow();
    validateZipEntryStreams(bytes, inspection.entries, limits, {
      signal: options.signal,
      deadline: startedAt + timeoutMs,
      now: monotonicNow,
    });
    return bytes;
  }

  return new Promise((resolve, reject) => {
    const requestId = validationRequestId();
    let worker: ZipValidationWorker;
    let settled = false;
    try {
      worker = (options.workerFactory ?? defaultValidationWorkerFactory)();
    } catch (error) {
      reject(new ResourceError("unsafe_archive", "The ZIP validation worker could not be started.", { cause: error }));
      return;
    }

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(options.signal!)));
    const timer = globalThis.setTimeout(() => finish(() => reject(new ResourceError(
      "unsafe_archive",
      "ZIP validation exceeded the processing time limit.",
    ))), timeoutMs);

    worker.onmessage = (event) => {
      if (!event.data || typeof event.data !== "object") {
        finish(() => reject(new ResourceError("unsafe_archive", "The ZIP validator returned an invalid response.")));
        return;
      }
      const response = event.data as {
        type?: unknown;
        id?: unknown;
        bytes?: unknown;
        code?: unknown;
        message?: unknown;
      };
      if (response.id !== requestId) {
        finish(() => reject(new ResourceError("unsafe_archive", "The ZIP validator returned a mismatched response.")));
        return;
      }
      if (response.type === "success" && response.bytes instanceof ArrayBuffer) {
        const responseBytes = response.bytes;
        finish(() => resolve(new Uint8Array(responseBytes)));
        return;
      }
      if (response.type === "error"
        && typeof response.code === "string"
        && RESOURCE_ERROR_CODES.has(response.code as ResourceErrorCode)
        && typeof response.message === "string") {
        const responseMessage = response.message;
        finish(() => reject(new ResourceError(
          response.code as ResourceErrorCode,
          responseMessage.slice(0, 1_000),
        )));
        return;
      }
      finish(() => reject(new ResourceError("unsafe_archive", "The ZIP validator returned an invalid response.")));
    };
    worker.onerror = (event) => finish(() => reject(new ResourceError(
      "unsafe_archive",
      event.message || "The ZIP validation worker failed.",
    )));

    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const buffer = transferableArchiveBuffer(bytes);
    try {
      worker.postMessage({
        type: "validate",
        id: requestId,
        bytes: buffer,
        entries: inspection.entries,
        limits: {
          maxEntryBytes: limits.maxEntryBytes,
          maxUncompressedBytes: limits.maxUncompressedBytes,
          maxCompressionRatio: limits.maxCompressionRatio,
        },
        timeoutMs,
      }, [buffer]);
    } catch (error) {
      finish(() => reject(new ResourceError("unsafe_archive", "The ZIP archive could not be sent for validation.", {
        cause: error,
      })));
    }
  });
}

export function assertInflatedEntriesMatchInspection(
  files: Record<string, Uint8Array>,
  inspection: ZipInspection,
  limits: ZipSafetyLimits = defaultArchiveSafetyLimits,
): void {
  const expected = new Map(inspection.entries.map((entry) => [entry.path, entry]));
  let total = 0;
  for (const [path, data] of Object.entries(files)) {
    assertSafeArchivePath(path.endsWith("/") ? path.slice(0, -1) : path);
    const entry = expected.get(path);
    if (!entry) throw new ResourceError("unsafe_archive", `Unexpected inflated ZIP entry '${path}'.`);
    if (data.byteLength !== entry.uncompressedSize || data.byteLength > limits.maxEntryBytes) {
      throw new ResourceError("archive_integrity_failed", `ZIP entry '${path}' has an unexpected expanded size.`);
    }
    total += data.byteLength;
    if (total > limits.maxUncompressedBytes) {
      throw new ResourceError("archive_too_large", "The ZIP archive exceeds the expanded size limit.");
    }
  }
  if (Object.keys(files).length !== inspection.entries.length) {
    throw new ResourceError("archive_integrity_failed", "The ZIP archive entry count changed while inflating.");
  }
}

function decodeXmlAttribute(value: string): string {
  return value.replace(/&([^;\s]{1,32});/g, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const isHex = normalized.startsWith("#x");
    const radix = isHex ? 16 : 10;
    const digits = isHex ? normalized.slice(2) : normalized.slice(1);
    const validDigits = isHex ? /^[0-9a-f]+$/i.test(digits) : /^[0-9]+$/.test(digits);
    if (!normalized.startsWith("#") || !digits || !validDigits) {
      throw new ResourceError("unsafe_archive", `Office relationship contains an unsupported XML entity '${entity}'.`);
    }
    const codePoint = Number.parseInt(digits, radix);
    if (!Number.isSafeInteger(codePoint)
      || codePoint <= 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new ResourceError("unsafe_archive", "Office relationship contains an invalid XML character reference.");
    }
    return String.fromCodePoint(codePoint);
  });
}

function parseRelationshipAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const elementName = tag.match(/^<(?:[A-Za-z_][\w.-]*:)?Relationship\b/i)?.[0];
  if (!elementName) {
    throw new ResourceError("unsafe_archive", "Office relationship XML is malformed.");
  }
  let offset = elementName.length;
  while (offset < tag.length) {
    while (/\s/.test(tag[offset] ?? "")) offset += 1;
    if (tag[offset] === ">") return attributes;
    if (tag[offset] === "/" && tag[offset + 1] === ">") return attributes;

    const name = tag.slice(offset).match(/^[A-Za-z_][A-Za-z0-9_.:-]*/)?.[0];
    if (!name) throw new ResourceError("unsafe_archive", "Office relationship XML has an invalid attribute.");
    offset += name.length;
    while (/\s/.test(tag[offset] ?? "")) offset += 1;
    if (tag[offset] !== "=") {
      throw new ResourceError("unsafe_archive", "Office relationship XML has an unassigned attribute.");
    }
    offset += 1;
    while (/\s/.test(tag[offset] ?? "")) offset += 1;
    const quote = tag[offset];
    if (quote !== '"' && quote !== "'") {
      throw new ResourceError("unsafe_archive", "Office relationship XML attributes must be quoted.");
    }
    const end = tag.indexOf(quote, offset + 1);
    if (end < 0) throw new ResourceError("unsafe_archive", "Office relationship XML has an unterminated attribute.");
    const normalizedName = name.toLowerCase();
    if (attributes.has(normalizedName)) {
      throw new ResourceError("unsafe_archive", `Office relationship repeats attribute '${name}'.`);
    }
    attributes.set(normalizedName, decodeXmlAttribute(tag.slice(offset + 1, end)));
    offset = end + 1;
  }
  throw new ResourceError("unsafe_archive", "Office relationship XML has an unterminated element.");
}

/**
 * Rejects relationships that could make an Office renderer fetch outside the package.
 * Only small `.rels` parts selected from the already-inspected central directory are inflated.
 */
export function assertOfficeRelationshipsSafe(
  bytes: Uint8Array,
  inspection: ZipInspection = inspectZipArchive(bytes, officeArchiveSafetyLimits),
): void {
  const relationshipEntries = inspection.entries.filter((entry) => entry.path.toLowerCase().endsWith(".rels"));
  if (relationshipEntries.length === 0) return;

  let relationshipBytes = 0;
  for (const entry of relationshipEntries) {
    if (entry.uncompressedSize > MAX_RELATIONSHIP_ENTRY_BYTES) {
      throw new ResourceError("archive_too_large", `Office relationship part '${entry.path}' exceeds the size limit.`);
    }
    relationshipBytes += entry.uncompressedSize;
    if (relationshipBytes > MAX_RELATIONSHIP_TOTAL_BYTES) {
      throw new ResourceError("archive_too_large", "Office relationship parts exceed the expanded size limit.");
    }
  }

  const relationshipPaths = new Set(relationshipEntries.map((entry) => entry.path));
  let inflated: Record<string, Uint8Array>;
  try {
    inflated = unzipSync(bytes, { filter: (file) => relationshipPaths.has(file.name) });
  } catch (error) {
    throw new ResourceError("unsafe_archive", "Office relationship parts could not be inspected safely.", { cause: error });
  }
  const relationshipInspection: ZipInspection = {
    entries: relationshipEntries,
    compressedBytes: relationshipEntries.reduce((total, entry) => total + entry.compressedSize, 0),
    uncompressedBytes: relationshipBytes,
  };
  assertInflatedEntriesMatchInspection(inflated, relationshipInspection, {
    ...officeArchiveSafetyLimits,
    maxEntryBytes: MAX_RELATIONSHIP_ENTRY_BYTES,
    maxUncompressedBytes: MAX_RELATIONSHIP_TOTAL_BYTES,
  });

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let relationshipCount = 0;
  for (const entry of relationshipEntries) {
    let xml: string;
    try {
      xml = decoder.decode(inflated[entry.path]);
    } catch (error) {
      throw new ResourceError("unsafe_archive", `Office relationship part '${entry.path}' is not valid UTF-8.`, {
        cause: error,
      });
    }
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
      throw new ResourceError("unsafe_archive", "Office relationship parts must not declare a DOCTYPE or entity.");
    }
    for (const match of xml.matchAll(RELATIONSHIP_TAG)) {
      relationshipCount += 1;
      if (relationshipCount > MAX_RELATIONSHIP_ELEMENTS) {
        throw new ResourceError("archive_too_large", "The Office package contains too many relationships.");
      }
      const attributes = parseRelationshipAttributes(match[0]);
      const targetMode = attributes.get("targetmode")?.trim().toLowerCase();
      const target = attributes.get("target")?.trim();
      if (!target) throw new ResourceError("unsafe_archive", "Office relationship is missing its target.");
      if (targetMode && targetMode !== "internal" && targetMode !== "external") {
        throw new ResourceError("unsafe_archive", `Office relationship has unsupported TargetMode '${targetMode}'.`);
      }
      if (targetMode === "external" || EXTERNAL_TARGET.test(target) || hasControlCharacters(target)) {
        throw new ResourceError("unsafe_archive", "Office packages with external relationships are not supported.");
      }
    }
  }
}
