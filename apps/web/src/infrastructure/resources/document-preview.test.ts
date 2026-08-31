// @vitest-environment jsdom

import { resourceRecordSchema, type ResourceBlobRecord, type ResourceRecord } from "@/model/resource";
import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  renderOfficeResourcePreview,
  renderPdfResourcePreview,
  type DocxPreviewRuntime,
  type PdfCanvasSurface,
  type PdfPreviewDocument,
  type PdfPreviewRuntime,
  type PptxPreviewRuntime,
} from "./document-preview";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function officeFixture(kind: "docx" | "pptx", relationship?: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    "[Content_Types].xml": new TextEncoder().encode("<Types />"),
    [kind === "docx" ? "word/document.xml" : "ppt/presentation.xml"]: new TextEncoder().encode("<root />"),
  };
  if (relationship) {
    entries[kind === "docx" ? "word/_rels/document.xml.rels" : "ppt/_rels/presentation.xml.rels"] = new TextEncoder().encode(`
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${relationship}
      </Relationships>
    `);
  }
  return zipSync(entries, { level: 0 });
}

function readyOfficeResource(kind: "docx" | "pptx", bytes: Uint8Array): {
  resource: ResourceRecord;
  storedBlob: ResourceBlobRecord;
} {
  const mimeType = kind === "docx" ? DOCX_MIME : PPTX_MIME;
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: mimeType });
  const resource = resourceRecordSchema.parse({
    id: `${kind}-resource`,
    conversationId: "conversation-1",
    kind,
    origin: "upload",
    name: `sample.${kind}`,
    mimeType,
    extension: kind,
    status: "ready",
    byteSize: blob.size,
    originalByteSize: blob.size,
    sha256: `sha256:${"a".repeat(64)}`,
    textLength: 0,
    chunkCount: 0,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  });
  return {
    resource,
    storedBlob: { resourceId: resource.id, blob, byteSize: blob.size, mimeType },
  };
}

function readyPdfResource(): {
  resource: ResourceRecord;
  storedBlob: ResourceBlobRecord;
} {
  const blob = new Blob(["%PDF-1.7\npreview"], { type: "application/pdf" });
  const resource = resourceRecordSchema.parse({
    id: "pdf-resource",
    conversationId: "conversation-1",
    kind: "pdf",
    origin: "upload",
    name: "sample.pdf",
    mimeType: "application/pdf",
    extension: "pdf",
    status: "ready",
    byteSize: blob.size,
    originalByteSize: blob.size,
    sha256: `sha256:${"b".repeat(64)}`,
    textLength: 0,
    chunkCount: 0,
    metadata: { pageCount: 3 },
    createdAt: 1,
    updatedAt: 1,
  });
  return {
    resource,
    storedBlob: { resourceId: resource.id, blob, byteSize: blob.size, mimeType: "application/pdf" },
  };
}

function canvasSurface(): PdfCanvasSurface {
  return {
    canvas: document.createElement("canvas"),
    context: {} as CanvasRenderingContext2D,
  };
}

describe("renderOfficeResourcePreview", () => {
  it("lazily renders DOCX into owned mounts and removes active renderer output", async () => {
    const { resource, storedBlob } = readyOfficeResource("docx", officeFixture("docx"));
    const container = document.createElement("div");
    const styleContainer = document.createElement("div");
    const sentinel = document.createElement("span");
    container.append(sentinel);
    let receivedOptions: Record<string, unknown> | undefined;
    const runtime: DocxPreviewRuntime = {
      async renderAsync(_data, body, styles, options) {
        receivedOptions = options;
        const wrapper = document.createElement("div");
        wrapper.className = "docx-wrapper";
        const page = document.createElement("section");
        page.className = "docx";
        page.setAttribute("onclick", "alert(1)");
        page.setAttribute("style", "color: red; background: url(https://tracker.invalid/pixel)");
        const link = document.createElement("a");
        link.href = "https://example.invalid";
        link.textContent = "external";
        const image = document.createElement("img");
        image.src = "javascript:alert(1)";
        const script = document.createElement("script");
        script.textContent = "alert(1)";
        page.append(link, image, script);
        const secondPage = document.createElement("section");
        secondPage.className = "docx";
        secondPage.textContent = "Second page";
        wrapper.append(page, secondPage);
        body.append(wrapper);
        const sheet = document.createElement("style");
        sheet.textContent = "@import 'https://tracker.invalid/a.css'; .x { background: url(/track); }";
        styles?.append(sheet);
      },
    };

    const handle = await renderOfficeResourcePreview(resource, storedBlob, container, {
      styleContainer,
      initialPageIndex: 1,
      loaders: { loadDocxPreview: async () => runtime },
    });

    expect(handle).toMatchObject({ kind: "docx", pageCount: 2 });
    expect(receivedOptions).toMatchObject({
      useBase64URL: true,
      renderAltChunks: false,
      renderComments: false,
      renderChanges: false,
    });
    const mount = container.querySelector<HTMLElement>("[data-office-preview]");
    expect(mount?.querySelector("script")).toBeNull();
    expect(mount?.querySelector("section")?.hasAttribute("onclick")).toBe(false);
    expect(mount?.querySelector("section")?.getAttribute("style")).toBe("color: red; background: none");
    expect(mount?.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(mount?.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(styleContainer.textContent).not.toContain("@import");
    expect(styleContainer.textContent).toContain("background: none");
    const renderedPages = mount?.querySelectorAll<HTMLElement>("section.docx");
    expect(renderedPages?.[0]?.hidden).toBe(true);
    expect(renderedPages?.[1]?.hidden).toBe(false);
    await handle.showPage(0);
    expect(renderedPages?.[0]?.hidden).toBe(false);
    expect(renderedPages?.[1]?.hidden).toBe(true);

    handle.dispose();
    expect([...container.children]).toContain(sentinel);
    expect(container.querySelector("[data-office-preview]")).toBeNull();
    expect(styleContainer.querySelector("[data-office-preview-styles]")).toBeNull();
  });

  it("uses bounded, lazy single-slide PPTX rendering and destroys it on cancellation", async () => {
    const { resource, storedBlob } = readyOfficeResource("pptx", officeFixture("pptx"));
    const container = document.createElement("div");
    const controller = new AbortController();
    const destroy = vi.fn();
    const goToSlide = vi.fn(async () => undefined);
    let receivedOptions: Record<string, unknown> | undefined;
    const runtime: PptxPreviewRuntime = {
      PptxViewer: {
        async open(_data, mount, options) {
          receivedOptions = options;
          mount.append(document.createElement("script"));
          return { slideCount: 3, goToSlide, destroy };
        },
      },
    };

    const handle = await renderOfficeResourcePreview(resource, storedBlob, container, {
      signal: controller.signal,
      initialPageIndex: 2,
      loaders: { loadPptxPreview: async () => runtime },
    });

    expect(handle).toMatchObject({ kind: "pptx", pageCount: 3 });
    expect(receivedOptions).toMatchObject({
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
      renderMode: "slide",
      zipLimits: {
        maxEntries: 4_000,
        maxConcurrency: 4,
      },
    });
    expect(goToSlide).toHaveBeenCalledWith(2, { behavior: "instant", block: "center" });
    await handle.showPage(1);
    expect(goToSlide).toHaveBeenLastCalledWith(1, { behavior: "instant", block: "center" });
    expect(container.querySelector("script")).toBeNull();

    controller.abort(new DOMException("cancelled", "AbortError"));
    expect(destroy).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-office-preview]")).toBeNull();
  });

  it("awaits a lazy PPTX slide handle before exposing the selected slide", async () => {
    const { resource, storedBlob } = readyOfficeResource("pptx", officeFixture("pptx"));
    const container = document.createElement("div");
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const disposeSlide = vi.fn();
    const destroy = vi.fn();
    const renderSlideToContainer = vi.fn((_index: number, mount: HTMLElement) => {
      mount.textContent = "Asynchronous slide";
      return { ready, dispose: disposeSlide };
    });
    const runtime: PptxPreviewRuntime = {
      PptxViewer: {
        async open() {
          return { slideCount: 2, renderSlideToContainer, destroy };
        },
      },
    };

    let settled = false;
    const rendering = renderOfficeResourcePreview(resource, storedBlob, container, {
      initialPageIndex: 1,
      loaders: { loadPptxPreview: async () => runtime },
    }).then((handle) => {
      settled = true;
      return handle;
    });
    await vi.waitFor(() => expect(renderSlideToContainer).toHaveBeenCalledWith(
      1,
      expect.any(HTMLElement),
    ));
    expect(settled).toBe(false);
    resolveReady?.();
    const handle = await rendering;

    expect(container.textContent).toContain("Asynchronous slide");
    handle.dispose();
    expect(disposeSlide).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("rejects mismatched storage before loading a renderer", async () => {
    const { resource, storedBlob } = readyOfficeResource("docx", officeFixture("docx"));
    const loadDocxPreview = vi.fn<() => Promise<DocxPreviewRuntime>>();
    const badBlob = { ...storedBlob, resourceId: "different-resource" };

    await expect(renderOfficeResourcePreview(resource, badBlob, document.createElement("div"), {
      loaders: { loadDocxPreview },
    })).rejects.toMatchObject({ code: "storage_failed" });
    expect(loadDocxPreview).not.toHaveBeenCalled();
  });

  it("rejects stored Office external relationships before loading a renderer", async () => {
    const bytes = officeFixture("docx", `
      <Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
        Target="https://tracker.invalid/pixel.png" TargetMode="External"/>
    `);
    const { resource, storedBlob } = readyOfficeResource("docx", bytes);
    const loadDocxPreview = vi.fn<() => Promise<DocxPreviewRuntime>>();

    await expect(renderOfficeResourcePreview(resource, storedBlob, document.createElement("div"), {
      loaders: { loadDocxPreview },
    })).rejects.toMatchObject({ code: "unsafe_archive" });
    expect(loadDocxPreview).not.toHaveBeenCalled();
  });

  it("destroys a PPTX viewer that resolves after cancellation", async () => {
    const { resource, storedBlob } = readyOfficeResource("pptx", officeFixture("pptx"));
    const container = document.createElement("div");
    const controller = new AbortController();
    const destroy = vi.fn();
    let resolveOpen: ((viewer: { slideCount: number; destroy(): void }) => void) | undefined;
    let markOpenStarted: (() => void) | undefined;
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const runtime: PptxPreviewRuntime = {
      PptxViewer: {
        open: async () => {
          markOpenStarted?.();
          return await new Promise((resolve) => {
            resolveOpen = resolve;
          });
        },
      },
    };

    const rendering = renderOfficeResourcePreview(resource, storedBlob, container, {
      signal: controller.signal,
      loaders: { loadPptxPreview: async () => runtime },
    });
    await openStarted;
    controller.abort(new DOMException("cancelled", "AbortError"));
    resolveOpen?.({ slideCount: 1, destroy });

    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    expect(destroy).toHaveBeenCalledOnce();
    expect(container.querySelector("[data-office-preview]")).toBeNull();
  });
});

describe("renderPdfResourcePreview", () => {
  it("loads safe PDF.js settings and lazily renders only the selected canvas page", async () => {
    const { resource, storedBlob } = readyPdfResource();
    const container = document.createElement("div");
    const destroy = vi.fn(async () => undefined);
    const cleanupDocument = vi.fn();
    const pages = new Map<number, { render: ReturnType<typeof vi.fn>; cleanup: ReturnType<typeof vi.fn> }>();
    const getPage = vi.fn(async (pageNumber: number) => {
      const render = vi.fn((_options: Record<string, unknown>) => ({
        promise: Promise.resolve(),
        cancel: vi.fn(),
      }));
      const cleanup = vi.fn();
      pages.set(pageNumber, { render, cleanup });
      return {
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render,
        cleanup,
      };
    });
    const pdfDocument: PdfPreviewDocument = { numPages: 3, getPage, cleanup: cleanupDocument };
    let getDocumentOptions: Record<string, unknown> | undefined;
    const runtime: PdfPreviewRuntime = {
      getDocument(options) {
        getDocumentOptions = options;
        return { promise: Promise.resolve(pdfDocument), destroy };
      },
    };
    const surface = canvasSurface();

    const handle = await renderPdfResourcePreview(resource, storedBlob, container, {
      initialPageIndex: 1,
      maxCssWidth: 600,
      loadPdfPreview: async () => runtime,
      createCanvasSurface: () => surface,
    });

    expect(getDocumentOptions).toMatchObject({
      isEvalSupported: false,
      enableXfa: false,
      disableRange: true,
      disableStream: true,
      disableAutoFetch: true,
      useWorkerFetch: false,
    });
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(getPage).toHaveBeenCalledWith(2);
    expect(pages.get(2)?.render).toHaveBeenCalledWith(expect.objectContaining({
      canvas: surface.canvas,
      annotationMode: 0,
      intent: "display",
      isEditing: false,
    }));
    expect(container.querySelector("canvas")).toBe(surface.canvas);

    await handle.showPage(2);
    expect(getPage).toHaveBeenCalledTimes(2);
    expect(getPage).toHaveBeenLastCalledWith(3);
    handle.dispose();
    expect(container.querySelector("[data-pdf-preview]")).toBeNull();
    expect(cleanupDocument).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalled();
  });

  it("cancels an in-flight page render and tears down PDF.js when aborted", async () => {
    const { resource, storedBlob } = readyPdfResource();
    const controller = new AbortController();
    const destroy = vi.fn(async () => undefined);
    let rejectRender: ((error: unknown) => void) | undefined;
    const cancel = vi.fn(() => rejectRender?.(new DOMException("cancelled", "AbortError")));
    const render = vi.fn(() => ({
      promise: new Promise<void>((_resolve, reject) => {
        rejectRender = reject;
      }),
      cancel,
    }));
    const pdfDocument: PdfPreviewDocument = {
      numPages: 1,
      async getPage() {
        return {
          getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
          render,
          cleanup: vi.fn(),
        };
      },
    };
    const runtime: PdfPreviewRuntime = {
      getDocument: () => ({ promise: Promise.resolve(pdfDocument), destroy }),
    };

    const rendering = renderPdfResourcePreview(resource, storedBlob, document.createElement("div"), {
      signal: controller.signal,
      loadPdfPreview: async () => runtime,
      createCanvasSurface: canvasSurface,
    });
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    controller.abort(new DOMException("closed", "AbortError"));

    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });

  it("rejects a non-PDF signature before loading PDF.js", async () => {
    const { resource, storedBlob } = readyPdfResource();
    const invalidBlob = new Blob(["not-a-pdf-content"], { type: "application/pdf" });
    const loadPdfPreview = vi.fn<() => Promise<PdfPreviewRuntime>>();
    await expect(renderPdfResourcePreview(
      { ...resource, byteSize: invalidBlob.size, originalByteSize: invalidBlob.size },
      { ...storedBlob, blob: invalidBlob, byteSize: invalidBlob.size },
      document.createElement("div"),
      { loadPdfPreview },
    )).rejects.toMatchObject({ code: "invalid_file" });
    expect(loadPdfPreview).not.toHaveBeenCalled();
  });
});
