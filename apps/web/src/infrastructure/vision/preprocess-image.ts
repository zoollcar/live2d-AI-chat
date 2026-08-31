import { ImageInspectionError } from "./errors";

export const VISION_MAX_IMAGE_SIDE = 2_048;
const MAX_SOURCE_IMAGE_SIDE = 12_000;
const MAX_SOURCE_IMAGE_PIXELS = 40_000_000;
const MAX_PREPARED_IMAGE_BYTES = 12 * 1024 * 1024;
const OUTPUT_QUALITY = 0.86;

export const visionInputMediaTypes = ["image/png", "image/jpeg", "image/webp"] as const;
export type VisionInputMediaType = (typeof visionInputMediaTypes)[number];
export type VisionOutputMediaType = "image/jpeg" | "image/webp";

export interface PreparedVisionImage {
  bytes: Uint8Array;
  mediaType: VisionOutputMediaType;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}

export interface DecodedVisionImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

export interface VisionImageRasterizer {
  decode(blob: Blob, signal?: AbortSignal): Promise<DecodedVisionImage>;
  encode(
    source: CanvasImageSource,
    width: number,
    height: number,
    mediaType: VisionOutputMediaType,
    quality: number,
    signal?: AbortSignal,
  ): Promise<Blob>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Image inspection was cancelled.", "AbortError");
  }
}

async function decodeWithImageElement(blob: Blob, signal?: AbortSignal): Promise<DecodedVisionImage> {
  if (typeof Image === "undefined"
    || typeof URL === "undefined"
    || typeof URL.createObjectURL !== "function"
    || typeof URL.revokeObjectURL !== "function") {
    throw new ImageInspectionError("decode-failed", "This browser cannot decode the image for inspection.");
  }
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        image.src = "";
        reject(new DOMException("Image inspection was cancelled.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      image.onload = () => {
        cleanup();
        resolve();
      };
      image.onerror = () => {
        cleanup();
        reject(new ImageInspectionError("decode-failed", "The image could not be decoded for inspection."));
      };
      image.src = objectUrl;
    });
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      close() {
        image.src = "";
        URL.revokeObjectURL(objectUrl);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

async function browserDecode(blob: Blob, signal?: AbortSignal): Promise<DecodedVisionImage> {
  throwIfAborted(signal);
  if (typeof createImageBitmap !== "function") return decodeWithImageElement(blob, signal);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch (error) {
    if (signal?.aborted) throwIfAborted(signal);
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ImageInspectionError("decode-failed", "The image could not be decoded for inspection.");
  }
  if (signal?.aborted) {
    bitmap.close();
    throwIfAborted(signal);
  }
  return {
    source: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    close: () => bitmap.close(),
  };
}

function drawCanvas(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
  opaque: boolean,
): void {
  if (opaque) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(source, 0, 0, width, height);
}

function htmlCanvasBlob(
  canvas: HTMLCanvasElement,
  mediaType: VisionOutputMediaType,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ImageInspectionError("encode-failed", "The browser could not encode the inspection image."));
    }, mediaType, quality);
  });
}

async function browserEncode(
  source: CanvasImageSource,
  width: number,
  height: number,
  mediaType: VisionOutputMediaType,
  quality: number,
  signal?: AbortSignal,
): Promise<Blob> {
  throwIfAborted(signal);
  let encoded: Blob;
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: mediaType !== "image/jpeg" });
    if (!context) throw new ImageInspectionError("encode-failed", "This browser cannot prepare images for inspection.");
    drawCanvas(context, source, width, height, mediaType === "image/jpeg");
    encoded = await htmlCanvasBlob(canvas, mediaType, quality);
    if (encoded.type !== mediaType && mediaType === "image/webp") {
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";
      encoded = await htmlCanvasBlob(canvas, "image/jpeg", quality);
    }
  } else if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: mediaType !== "image/jpeg" });
    if (!context) throw new ImageInspectionError("encode-failed", "This browser cannot prepare images for inspection.");
    drawCanvas(context, source, width, height, mediaType === "image/jpeg");
    encoded = await canvas.convertToBlob({ type: mediaType, quality });
    if (encoded.type !== mediaType && mediaType === "image/webp") {
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.globalCompositeOperation = "source-over";
      encoded = await canvas.convertToBlob({ type: "image/jpeg", quality });
    }
  } else {
    throw new ImageInspectionError("encode-failed", "This browser cannot prepare images for inspection.");
  }
  throwIfAborted(signal);
  return encoded;
}

export const browserVisionImageRasterizer: VisionImageRasterizer = {
  decode: browserDecode,
  encode: browserEncode,
};

function validatedInputMediaType(value: string): VisionInputMediaType {
  const normalized = value.trim().toLowerCase();
  if (!visionInputMediaTypes.includes(normalized as VisionInputMediaType)) {
    throw new ImageInspectionError(
      "unsupported-image",
      "Image inspection supports uploaded PNG, JPEG, and WebP files only.",
    );
  }
  return normalized as VisionInputMediaType;
}

export async function preprocessImageForVision(
  blob: Blob,
  declaredMediaType: string,
  signal?: AbortSignal,
  rasterizer: VisionImageRasterizer = browserVisionImageRasterizer,
): Promise<PreparedVisionImage> {
  throwIfAborted(signal);
  if (blob.size <= 0) {
    throw new ImageInspectionError("decode-failed", "The image data is empty.");
  }
  const inputMediaType = validatedInputMediaType(declaredMediaType);
  let decoded: DecodedVisionImage;
  try {
    decoded = await rasterizer.decode(blob, signal);
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    if (error instanceof ImageInspectionError) throw error;
    throw new ImageInspectionError("decode-failed", "The image could not be decoded for inspection.");
  }
  try {
    throwIfAborted(signal);
    const { width: originalWidth, height: originalHeight } = decoded;
    if (!Number.isInteger(originalWidth)
      || !Number.isInteger(originalHeight)
      || originalWidth <= 0
      || originalHeight <= 0
      || originalWidth > MAX_SOURCE_IMAGE_SIDE
      || originalHeight > MAX_SOURCE_IMAGE_SIDE
      || originalWidth * originalHeight > MAX_SOURCE_IMAGE_PIXELS) {
      throw new ImageInspectionError("decode-failed", "The decoded image dimensions are unsafe.");
    }
    const scale = Math.min(1, VISION_MAX_IMAGE_SIDE / Math.max(originalWidth, originalHeight));
    const width = Math.max(1, Math.round(originalWidth * scale));
    const height = Math.max(1, Math.round(originalHeight * scale));
    const requestedMediaType: VisionOutputMediaType = inputMediaType === "image/jpeg" ? "image/jpeg" : "image/webp";
    let encoded: Blob;
    try {
      encoded = await rasterizer.encode(
        decoded.source,
        width,
        height,
        requestedMediaType,
        OUTPUT_QUALITY,
        signal,
      );
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      if (error instanceof ImageInspectionError) throw error;
      throw new ImageInspectionError("encode-failed", "The image could not be re-encoded for inspection.");
    }
    throwIfAborted(signal);
    if (encoded.size <= 0 || encoded.size > MAX_PREPARED_IMAGE_BYTES) {
      throw new ImageInspectionError("encode-failed", "The prepared inspection image has an invalid size.");
    }
    if (encoded.type !== "image/jpeg" && encoded.type !== "image/webp") {
      throw new ImageInspectionError("encode-failed", "The browser returned an unsupported inspection image format.");
    }
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    throwIfAborted(signal);
    return {
      bytes,
      mediaType: encoded.type,
      width,
      height,
      originalWidth,
      originalHeight,
    };
  } finally {
    decoded.close();
  }
}
