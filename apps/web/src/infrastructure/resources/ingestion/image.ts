import { ResourceError } from "../errors";
import { RESOURCE_LIMITS } from "../limits";
import type { ValidatedResourceFile } from "../validation";
import { finalizeResourceBundle } from "./finalize";
import type { ResourceIngestionOptions } from "./types";

export interface ImageDimensions {
  width: number;
  height: number;
}

export type ImageDimensionsReader = (blob: Blob, signal?: AbortSignal) => Promise<ImageDimensions>;

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = bytes[offset] << 8 | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return {
        height: bytes[offset + 3] << 8 | bytes[offset + 4],
        width: bytes[offset + 5] << 8 | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.byteLength < 25) return undefined;
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8X" && bytes.byteLength >= 30) {
    return {
      width: uint24LittleEndian(bytes, 24) + 1,
      height: uint24LittleEndian(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 " && bytes.byteLength >= 30
    && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: (bytes[26] | bytes[27] << 8) & 0x3fff,
      height: (bytes[28] | bytes[29] << 8) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  return undefined;
}

function encodedImageDimensions(file: ValidatedResourceFile): ImageDimensions {
  const dimensions = file.extension === "png"
    ? pngDimensions(file.bytes)
    : file.extension === "jpg" || file.extension === "jpeg"
      ? jpegDimensions(file.bytes)
      : file.extension === "webp"
        ? webpDimensions(file.bytes)
        : undefined;
  if (!dimensions) throw new ResourceError("invalid_file", "The image header has no valid dimensions.");
  return dimensions;
}

function assertSafeDimensions(dimensions: ImageDimensions): void {
  if (!Number.isInteger(dimensions.width)
    || !Number.isInteger(dimensions.height)
    || dimensions.width <= 0
    || dimensions.height <= 0) {
    throw new ResourceError("invalid_file", "The image has invalid dimensions.");
  }
  if (dimensions.width > RESOURCE_LIMITS.maxImageWidth
    || dimensions.height > RESOURCE_LIMITS.maxImageHeight
    || dimensions.width * dimensions.height > RESOURCE_LIMITS.maxImagePixels) {
    throw new ResourceError(
      "invalid_file",
      `The decoded image exceeds the ${RESOURCE_LIMITS.maxImagePixels.toLocaleString()} pixel limit.`,
    );
  }
}

async function browserImageDimensions(blob: Blob, signal?: AbortSignal): Promise<ImageDimensions> {
  signal?.throwIfAborted();
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }
  if (typeof Image === "undefined" || typeof URL === "undefined") {
    throw new ResourceError("invalid_file", "This browser cannot inspect image dimensions.");
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<ImageDimensions>((resolve, reject) => {
      const image = new Image();
      const abort = () => {
        image.src = "";
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      image.onload = () => {
        signal?.removeEventListener("abort", abort);
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      };
      image.onerror = () => {
        signal?.removeEventListener("abort", abort);
        reject(new ResourceError("invalid_file", "The image could not be decoded."));
      };
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function ingestImageResource(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
  readDimensions: ImageDimensionsReader = browserImageDimensions,
) {
  assertSafeDimensions(encodedImageDimensions(file));
  const dimensions = await readDimensions(file.file, options.signal);
  assertSafeDimensions(dimensions);
  return finalizeResourceBundle({
    file,
    options,
    kind: "image",
    sections: [],
    metadata: dimensions,
  });
}
