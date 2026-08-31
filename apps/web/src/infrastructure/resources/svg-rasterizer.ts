import { resourceRecordSchema, type ResourceBundle } from "@/model/resource";
import { extractedTextLength, validateResourceChunkSequence } from "./chunks";
import { ResourceError } from "./errors";
import { sha256Blob } from "./hash";
import { finalizeResourceBundle } from "./ingestion/finalize";
import { sanitizeSvgText } from "./ingestion/svg";
import { RESOURCE_LIMITS } from "./limits";

const SVG_MIME = "image/svg+xml";
const PNG_MIME = "image/png";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

interface RasterizerSuccess {
  type: "success";
  id: string;
  png: ArrayBuffer;
  width: number;
  height: number;
}

interface RasterizerFailure {
  type: "error";
  id: string;
  message: string;
}

export interface SvgRasterizerWorker {
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export type SvgRasterizerWorkerFactory = () => SvgRasterizerWorker;

export interface RasterizeSvgOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  workerFactory?: SvgRasterizerWorkerFactory;
}

export interface RasterizedSvg {
  png: Blob;
  width: number;
  height: number;
}

export interface CreateSvgPreviewBundleOptions extends RasterizeSvgOptions {
  resourceId?: string;
  name?: string;
  alt?: string;
  now?: number;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function defaultWorkerFactory(): SvgRasterizerWorker {
  return new Worker(new URL("./svg-rasterizer.worker.ts", import.meta.url), {
    type: "module",
    name: "live2d-svg-rasterizer",
  });
}

function createRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `svg-raster-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!isPng(bytes)
    || bytes.byteLength < 24
    || bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13
    || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function parseSuccess(value: unknown, requestId: string): RasterizerSuccess | RasterizerFailure {
  if (!value || typeof value !== "object") {
    throw new ResourceError("invalid_file", "The SVG rasterizer returned an invalid response.");
  }
  const candidate = value as {
    type?: unknown;
    id?: unknown;
    png?: unknown;
    width?: unknown;
    height?: unknown;
    message?: unknown;
  };
  if (candidate.id !== requestId) {
    throw new ResourceError("invalid_file", "The SVG rasterizer returned a mismatched response.");
  }
  if (candidate.type === "error" && typeof candidate.message === "string") {
    return { type: "error", id: requestId, message: candidate.message.slice(0, 500) };
  }
  if (candidate.type !== "success"
    || !(candidate.png instanceof ArrayBuffer)
    || typeof candidate.width !== "number"
    || typeof candidate.height !== "number"
    || !Number.isInteger(candidate.width)
    || !Number.isInteger(candidate.height)
    || candidate.width <= 0
    || candidate.height <= 0
    || candidate.width > RESOURCE_LIMITS.maxSvgDimension
    || candidate.height > RESOURCE_LIMITS.maxSvgDimension) {
    throw new ResourceError("invalid_file", "The SVG rasterizer returned invalid image metadata.");
  }
  const bytes = new Uint8Array(candidate.png);
  const pngSize = pngDimensions(bytes);
  if (!pngSize
    || pngSize.width !== candidate.width
    || pngSize.height !== candidate.height
    || bytes.byteLength > RESOURCE_LIMITS.imageBytes) {
    throw new ResourceError("invalid_file", "The SVG rasterizer returned an invalid PNG preview.");
  }
  return {
    type: "success",
    id: requestId,
    png: candidate.png,
    width: candidate.width,
    height: candidate.height,
  };
}

export async function rasterizeSanitizedSvg(
  svg: string,
  options: RasterizeSvgOptions = {},
): Promise<RasterizedSvg> {
  const timeoutMs = Math.min(
    options.timeoutMs ?? RESOURCE_LIMITS.svgProcessingTimeoutMs,
    RESOURCE_LIMITS.svgProcessingTimeoutMs,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("SVG rasterization timeout must be a positive number.");
  }
  options.signal?.throwIfAborted();
  const startedAt = monotonicNow();
  const sanitized = sanitizeSvgText(svg, {
    maxBytes: RESOURCE_LIMITS.svgBytes,
    signal: options.signal,
    timeoutMs,
  });
  const remainingMs = timeoutMs - (monotonicNow() - startedAt);
  if (remainingMs <= 0) {
    throw new ResourceError("unsafe_svg", "SVG rasterization timed out.");
  }

  let worker: SvgRasterizerWorker;
  try {
    worker = (options.workerFactory ?? defaultWorkerFactory)();
  } catch (error) {
    throw new ResourceError("invalid_file", "The SVG rasterization worker could not be started.", { cause: error });
  }
  const requestId = createRequestId();
  return await new Promise<RasterizedSvg>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        // A failed worker teardown must not prevent the caller promise from settling.
      }
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => settle(() => reject(
      options.signal?.reason ?? new DOMException("SVG rasterization was cancelled.", "AbortError"),
    ));
    const timer = setTimeout(() => settle(() => reject(
      new ResourceError("unsafe_svg", "SVG rasterization timed out."),
    )), remainingMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault();
      settle(() => reject(new ResourceError("invalid_file", "The SVG rasterization worker failed.")));
    };
    worker.onmessage = (event) => {
      try {
        const response = parseSuccess(event.data, requestId);
        if (response.type === "error") {
          settle(() => reject(new ResourceError("invalid_file", response.message)));
          return;
        }
        const bytes = new Uint8Array(response.png.byteLength);
        bytes.set(new Uint8Array(response.png));
        settle(() => resolve({
          png: new Blob([bytes], { type: PNG_MIME }),
          width: response.width,
          height: response.height,
        }));
      } catch (error) {
        settle(() => reject(error));
      }
    };
    try {
      worker.postMessage({
        type: "render",
        id: requestId,
        svg: sanitized.svg,
        maxDimension: RESOURCE_LIMITS.maxSvgDimension,
      });
    } catch (error) {
      settle(() => reject(new ResourceError("invalid_file", "The SVG rasterization request failed.", {
        cause: error,
      })));
    }
  });
}

function previewName(sourceName: string, requested?: string): string {
  const value = requested?.trim();
  if (requested !== undefined && !value) {
    throw new ResourceError("invalid_file", "The SVG preview name cannot be empty.");
  }
  const base = value ?? `${sourceName.replace(/\.svg$/i, "")}-preview`;
  const withExtension = base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
  if (withExtension.length > 500) {
    throw new ResourceError("invalid_file", "The SVG preview name is too long.");
  }
  return withExtension;
}

export async function createSvgRasterPreviewBundle(
  sourceBundle: ResourceBundle,
  options: CreateSvgPreviewBundleOptions = {},
): Promise<ResourceBundle> {
  const source = resourceRecordSchema.safeParse(sourceBundle.resource);
  const sourceByteLimit = source.success && source.data.origin === "generated"
    ? RESOURCE_LIMITS.generatedSvgBytes
    : RESOURCE_LIMITS.svgBytes;
  if (!source.success
    || source.data.kind !== "svg"
    || source.data.status !== "ready"
    || source.data.mimeType !== SVG_MIME
    || source.data.extension !== "svg"
    || source.data.byteSize <= 0
    || source.data.byteSize > sourceByteLimit
    || sourceBundle.blob.resourceId !== source.data.id
    || sourceBundle.blob.mimeType !== SVG_MIME
    || sourceBundle.blob.blob.type !== SVG_MIME
    || sourceBundle.blob.byteSize !== source.data.byteSize
    || sourceBundle.blob.blob.size !== source.data.byteSize) {
    throw new ResourceError("storage_failed", "The SVG preview source bundle is inconsistent.");
  }
  let sourceChunks;
  try {
    sourceChunks = validateResourceChunkSequence(source.data.id, sourceBundle.chunks);
  } catch (error) {
    throw new ResourceError("storage_failed", "The SVG preview source has invalid extracted chunks.", { cause: error });
  }
  if (sourceChunks.length !== source.data.chunkCount
    || extractedTextLength(sourceChunks) !== source.data.textLength) {
    throw new ResourceError("storage_failed", "The SVG preview source has incomplete extracted text.");
  }
  options.signal?.throwIfAborted();
  if (await sha256Blob(sourceBundle.blob.blob) !== source.data.sha256) {
    throw new ResourceError("storage_failed", "The SVG preview source failed integrity validation.");
  }
  let svg: string;
  try {
    svg = new TextDecoder("utf-8", { fatal: true }).decode(await sourceBundle.blob.blob.arrayBuffer());
  } catch (error) {
    throw new ResourceError("storage_failed", "The SVG preview source is not valid UTF-8.", { cause: error });
  }
  const alt = options.alt?.trim();
  if (options.alt !== undefined && (!alt || alt.length > 5_000)) {
    throw new ResourceError("invalid_file", "SVG preview alt text must contain at most 5000 characters.");
  }
  const rasterized = await rasterizeSanitizedSvg(svg, options);
  options.signal?.throwIfAborted();
  const file = new File([rasterized.png], previewName(source.data.name, options.name), { type: PNG_MIME });
  return finalizeResourceBundle({
    file: { file, extension: "png", mimeType: PNG_MIME },
    options: {
      conversationId: source.data.conversationId,
      origin: "generated",
      resourceId: options.resourceId,
      now: options.now,
      signal: options.signal,
    },
    kind: "image",
    sections: [],
    metadata: {
      width: rasterized.width,
      height: rasterized.height,
      ...(alt ? { description: alt } : {}),
    },
  });
}
