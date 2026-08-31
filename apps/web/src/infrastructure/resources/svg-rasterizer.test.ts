// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { ingestSvgResource } from "./ingestion/svg";
import {
  createSvgRasterPreviewBundle,
  rasterizeSanitizedSvg,
  type SvgRasterizerWorker,
} from "./svg-rasterizer";
import { validateResourceFile } from "./validation";

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

class FakeWorker implements SvgRasterizerWorker {
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
  onerror: ((event: ErrorEvent) => unknown) | null = null;
  readonly terminate = vi.fn();
  posted?: Record<string, unknown>;

  constructor(private readonly onPost?: (worker: FakeWorker, message: Record<string, unknown>) => void) {}

  postMessage(value: unknown): void {
    this.posted = value as Record<string, unknown>;
    this.onPost?.(this, this.posted);
  }

  succeed(message: Record<string, unknown>, width = 16, height = 10): void {
    const png = pngHeader(width, height).buffer;
    this.onmessage?.(new MessageEvent("message", {
      data: { type: "success", id: message.id, png, width, height },
    }));
  }

  fail(): void {
    this.onerror?.(new ErrorEvent("error", { message: "worker crashed" }));
  }
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><rect width="16" height="10"/></svg>';

describe("SVG rasterizer", () => {
  it("sends only sanitized SVG to the worker and validates its PNG result", async () => {
    const worker = new FakeWorker((instance, message) => instance.succeed(message));
    const result = await rasterizeSanitizedSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><script>bad()</script><rect/></svg>',
      { workerFactory: () => worker },
    );

    expect(worker.posted).toMatchObject({ type: "render", maxDimension: 4_096 });
    expect(worker.posted?.svg).not.toContain("script");
    expect(result).toMatchObject({ width: 16, height: 10, png: { type: "image/png", size: 24 } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("builds a generated PNG ResourceBundle in the source conversation", async () => {
    const validated = await validateResourceFile(new File([svg], "drawing.svg", { type: "image/svg+xml" }));
    const source = await ingestSvgResource(validated, {
      conversationId: "conversation-1",
      resourceId: "drawing-source",
      origin: "generated",
      now: 1,
    });
    const worker = new FakeWorker((instance, message) => instance.succeed(message));
    const preview = await createSvgRasterPreviewBundle(source, {
      resourceId: "drawing-preview",
      alt: "Safe drawing preview",
      now: 2,
      workerFactory: () => worker,
    });

    expect(preview.resource).toMatchObject({
      id: "drawing-preview",
      conversationId: "conversation-1",
      kind: "image",
      origin: "generated",
      name: "drawing-preview.png",
      mimeType: "image/png",
      status: "ready",
      byteSize: 24,
      metadata: { width: 16, height: 10, description: "Safe drawing preview" },
    });
    expect(preview.blob).toMatchObject({ resourceId: "drawing-preview", mimeType: "image/png", byteSize: 24 });
    expect(preview.chunks).toEqual([]);
  });

  it("terminates the worker when cancellation wins", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const pending = rasterizeSanitizedSvg(svg, {
      signal: controller.signal,
      workerFactory: () => worker,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("enforces a hard timeout by terminating an unresponsive worker", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const pending = rasterizeSanitizedSvg(svg, {
        timeoutMs: 500,
        workerFactory: () => worker,
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: "unsafe_svg" });
      await vi.advanceTimersByTimeAsync(501);
      await rejection;
      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects empty or unsafe input before starting a worker", async () => {
    const workerFactory = vi.fn<() => SvgRasterizerWorker>();
    await expect(rasterizeSanitizedSvg("", { workerFactory })).rejects.toMatchObject({ code: "invalid_file" });
    await expect(rasterizeSanitizedSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.invalid/x)"/></svg>',
      { workerFactory },
    )).rejects.toMatchObject({ code: "unsafe_svg" });
    expect(workerFactory).not.toHaveBeenCalled();
  });

  it("terminates and reports worker execution errors", async () => {
    const worker = new FakeWorker((instance) => queueMicrotask(() => instance.fail()));
    await expect(rasterizeSanitizedSvg(svg, {
      workerFactory: () => worker,
    })).rejects.toThrow("worker failed");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects PNG headers that disagree with worker metadata", async () => {
    const worker = new FakeWorker((instance, message) => {
      instance.onmessage?.(new MessageEvent("message", {
        data: {
          type: "success",
          id: message.id,
          png: pngHeader(15, 10).buffer,
          width: 16,
          height: 10,
        },
      }));
    });

    await expect(rasterizeSanitizedSvg(svg, {
      workerFactory: () => worker,
    })).rejects.toThrow("invalid PNG preview");
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
