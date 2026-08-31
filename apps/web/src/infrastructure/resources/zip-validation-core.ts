import { Inflate } from "fflate";
import { ResourceError } from "./errors";

const INPUT_CHUNK_BYTES = 4 * 1024;
const RATIO_CHECK_MIN_BYTES = 1024 * 1024;

export interface ZipStreamEntryInfo {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  crc32: number;
  dataOffset: number;
}

export interface ZipExpansionLimits {
  maxEntryBytes: number;
  maxUncompressedBytes: number;
  maxCompressionRatio: number;
}

export interface ZipStreamValidationOptions {
  deadline?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface ZipStreamValidationResult {
  entryCount: number;
  uncompressedBytes: number;
}

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < crcTable.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

function updateCrc32(crc: number, bytes: Uint8Array): number {
  const table = getCrcTable();
  let value = crc;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    value = table[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function throwIfStopped(options: ZipStreamValidationOptions): void {
  options.signal?.throwIfAborted();
  if (options.deadline !== undefined && (options.now ?? performance.now.bind(performance))() > options.deadline) {
    throw new ResourceError("unsafe_archive", "ZIP validation exceeded the processing time limit.");
  }
}

function assertOutputBounds(
  entry: ZipStreamEntryInfo,
  entryBytes: number,
  totalBytes: number,
  limits: ZipExpansionLimits,
): void {
  if (entryBytes > entry.uncompressedSize) {
    throw new ResourceError(
      "archive_integrity_failed",
      `ZIP entry '${entry.path}' expanded beyond its declared size.`,
    );
  }
  if (entryBytes > limits.maxEntryBytes) {
    throw new ResourceError("archive_too_large", `ZIP entry '${entry.path}' exceeds the per-entry size limit.`);
  }
  if (totalBytes > limits.maxUncompressedBytes) {
    throw new ResourceError("archive_too_large", "The ZIP archive exceeds the expanded size limit.");
  }
  const ratio = entryBytes / Math.max(1, entry.compressedSize);
  if (entryBytes > RATIO_CHECK_MIN_BYTES && ratio > limits.maxCompressionRatio) {
    throw new ResourceError("unsafe_archive", `ZIP entry '${entry.path}' has a suspicious compression ratio.`);
  }
}

/**
 * Expands each raw ZIP payload incrementally without retaining output. This is deliberately
 * independent of central-directory sizes: every emitted byte is counted and checksummed.
 */
export function validateZipEntryStreams(
  archive: Uint8Array,
  entries: readonly ZipStreamEntryInfo[],
  limits: ZipExpansionLimits,
  options: ZipStreamValidationOptions = {},
): ZipStreamValidationResult {
  let totalBytes = 0;

  for (const entry of entries) {
    throwIfStopped(options);
    const compressedEnd = entry.dataOffset + entry.compressedSize;
    if (!Number.isSafeInteger(entry.dataOffset)
      || !Number.isSafeInteger(compressedEnd)
      || entry.dataOffset < 0
      || compressedEnd > archive.byteLength) {
      throw new ResourceError("unsafe_archive", `ZIP entry '${entry.path}' points outside the archive.`);
    }

    let entryBytes = 0;
    let crc = 0xffffffff;
    let sawFinal = entry.compressionMethod === 0;
    const acceptOutput = (chunk: Uint8Array) => {
      throwIfStopped(options);
      entryBytes += chunk.byteLength;
      totalBytes += chunk.byteLength;
      assertOutputBounds(entry, entryBytes, totalBytes, limits);
      crc = updateCrc32(crc, chunk);
    };

    if (entry.compressionMethod === 0) {
      for (let offset = entry.dataOffset; offset < compressedEnd; offset += INPUT_CHUNK_BYTES) {
        throwIfStopped(options);
        acceptOutput(archive.subarray(offset, Math.min(offset + INPUT_CHUNK_BYTES, compressedEnd)));
      }
    } else if (entry.compressionMethod === 8) {
      const inflater = new Inflate((chunk, final) => {
        acceptOutput(chunk);
        sawFinal ||= final;
      });
      try {
        if (entry.compressedSize === 0) {
          inflater.push(new Uint8Array(), true);
        } else {
          for (let offset = entry.dataOffset; offset < compressedEnd; offset += INPUT_CHUNK_BYTES) {
            throwIfStopped(options);
            const end = Math.min(offset + INPUT_CHUNK_BYTES, compressedEnd);
            inflater.push(archive.subarray(offset, end), end === compressedEnd);
          }
        }
      } catch (error) {
        if (error instanceof ResourceError || options.signal?.aborted) throw error;
        throw new ResourceError("unsafe_archive", `ZIP entry '${entry.path}' contains invalid DEFLATE data.`, {
          cause: error,
        });
      }
    } else {
      throw new ResourceError(
        "unsafe_archive",
        `ZIP compression method ${entry.compressionMethod} is not supported.`,
      );
    }

    throwIfStopped(options);
    if (!sawFinal || entryBytes !== entry.uncompressedSize) {
      throw new ResourceError(
        "archive_integrity_failed",
        `ZIP entry '${entry.path}' has an unexpected expanded size.`,
      );
    }
    const actualCrc = (crc ^ 0xffffffff) >>> 0;
    if (actualCrc !== entry.crc32) {
      throw new ResourceError("archive_integrity_failed", `ZIP entry '${entry.path}' failed its CRC-32 check.`);
    }
  }

  return { entryCount: entries.length, uncompressedBytes: totalBytes };
}
