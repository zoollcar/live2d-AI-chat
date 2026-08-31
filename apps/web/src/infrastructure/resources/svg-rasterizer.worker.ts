import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasmUrl from "@resvg/resvg-wasm/index_bg.wasm?url";
import { RESOURCE_LIMITS } from "./limits";

interface RenderRequest {
  type: "render";
  id: string;
  svg: string;
  maxDimension: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
let wasmReady: Promise<void> | undefined;

function initializeWasm(): Promise<void> {
  wasmReady ??= initWasm(fetch(wasmUrl));
  return wasmReady;
}

function isRenderRequest(value: unknown): value is RenderRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RenderRequest>;
  return candidate.type === "render"
    && typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= 200
    && typeof candidate.svg === "string"
    && candidate.maxDimension === RESOURCE_LIMITS.maxSvgDimension;
}

async function renderSvg(request: RenderRequest): Promise<void> {
  let renderer: InstanceType<typeof Resvg> | undefined;
  let image: ReturnType<InstanceType<typeof Resvg>["render"]> | undefined;
  try {
    if (new TextEncoder().encode(request.svg).byteLength > RESOURCE_LIMITS.svgBytes) {
      throw new Error("source_too_large");
    }
    await initializeWasm();
    renderer = new Resvg(request.svg, {
      dpi: 96,
      fitTo: { mode: "original" },
      font: {
        fontBuffers: [],
        loadSystemFonts: false,
        defaultFontFamily: "sans-serif",
        sansSerifFamily: "sans-serif",
        serifFamily: "serif",
        monospaceFamily: "monospace",
      },
    });
    if (!Number.isFinite(renderer.width)
      || !Number.isFinite(renderer.height)
      || renderer.width <= 0
      || renderer.height <= 0
      || renderer.width > request.maxDimension
      || renderer.height > request.maxDimension) {
      throw new Error("invalid_dimensions");
    }
    if (renderer.imagesToResolve().length > 0) {
      throw new Error("external_resource");
    }
    image = renderer.render();
    const png = Uint8Array.from(image.asPng());
    if (png.byteLength <= 0 || png.byteLength > RESOURCE_LIMITS.imageBytes) {
      throw new Error("output_too_large");
    }
    const buffer = png.buffer;
    workerScope.postMessage({
      type: "success",
      id: request.id,
      png: buffer,
      width: image.width,
      height: image.height,
    }, [buffer]);
  } catch {
    workerScope.postMessage({
      type: "error",
      id: request.id,
      message: "The sanitized SVG could not be rasterized safely.",
    });
  } finally {
    image?.free();
    renderer?.free();
  }
}

workerScope.onmessage = (event) => {
  if (!isRenderRequest(event.data)) {
    workerScope.postMessage({
      type: "error",
      id: "invalid-request",
      message: "The SVG rasterizer received an invalid request.",
    });
    return;
  }
  void renderSvg(event.data);
};
