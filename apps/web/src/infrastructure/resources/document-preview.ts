import type { ResourceBlobRecord, ResourceRecord } from "@/model/resource";
import { ResourceError } from "./errors";
import { RESOURCE_LIMITS } from "./limits";
import {
  assertOfficeRelationshipsSafe,
  inspectZipArchive,
  officeArchiveSafetyLimits,
  verifyZipArchiveContents,
} from "./zip-safety";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PDF_MIME = "application/pdf";
const PDF_MAX_CANVAS_SIDE = 4_096;
const PDF_MAX_CANVAS_PIXELS = 16_000_000;
const PDF_MAX_DEVICE_PIXEL_RATIO = 2;

const BLOCKED_PREVIEW_ELEMENTS = [
  "script",
  "iframe",
  "object",
  "embed",
  "base",
  "link",
  "meta",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "audio",
  "video",
  "source",
  "track",
  "foreignObject",
].join(",");

const URL_ATTRIBUTES = new Set([
  "action",
  "cite",
  "data",
  "formaction",
  "href",
  "poster",
  "src",
  "xlink:href",
]);

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;
const CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/gi;

export interface DocxPreviewRuntime {
  renderAsync(
    data: Blob,
    bodyContainer: HTMLElement,
    styleContainer?: HTMLElement,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface PptxPreviewViewer {
  readonly slideCount: number;
  goToSlide?(index: number, scrollOptions?: ScrollIntoViewOptions): Promise<void>;
  renderSlideToContainer?(
    index: number,
    container: HTMLElement,
    scale?: number,
  ): PptxPreviewSlideHandle | null;
  destroy(): void;
}

export interface PptxPreviewSlideHandle {
  readonly ready: Promise<void>;
  dispose(): void;
}

export interface PptxPreviewRuntime {
  PptxViewer: {
    open(
      input: ArrayBuffer,
      container: HTMLElement,
      options?: Record<string, unknown>,
    ): Promise<PptxPreviewViewer>;
  };
}

export interface OfficePreviewLoaders {
  loadDocxPreview(): Promise<DocxPreviewRuntime>;
  loadPptxPreview(): Promise<PptxPreviewRuntime>;
}

export interface RenderOfficePreviewOptions {
  signal?: AbortSignal;
  initialPageIndex?: number;
  styleContainer?: HTMLElement;
  loaders?: Partial<OfficePreviewLoaders>;
}

export interface OfficePreviewHandle {
  readonly kind: "docx" | "pptx";
  readonly pageCount?: number;
  showPage(pageIndex: number, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

export interface PdfPreviewViewport {
  width: number;
  height: number;
}

export interface PdfPreviewPage {
  getViewport(options: { scale: number }): PdfPreviewViewport;
  render(options: Record<string, unknown>): {
    promise: Promise<void>;
    cancel(extraDelay?: number): void;
  };
  cleanup?(): void;
}

export interface PdfPreviewDocument {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPreviewPage>;
  cleanup?(): Promise<void> | void;
}

export interface PdfPreviewLoadingTask {
  readonly promise: Promise<PdfPreviewDocument>;
  destroy(): Promise<void>;
}

export interface PdfPreviewRuntime {
  getDocument(options: Record<string, unknown>): PdfPreviewLoadingTask;
  GlobalWorkerOptions?: { workerSrc: string };
}

export type PdfPreviewLoader = () => Promise<PdfPreviewRuntime>;

export interface PdfCanvasSurface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

export interface RenderPdfPreviewOptions {
  signal?: AbortSignal;
  initialPageIndex?: number;
  maxCssWidth?: number;
  loadPdfPreview?: PdfPreviewLoader;
  createCanvasSurface?(document: Document): PdfCanvasSurface;
}

export interface PdfPreviewHandle {
  readonly kind: "pdf";
  readonly pageCount: number;
  showPage(pageIndex: number, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

function defaultDocxLoader(): Promise<DocxPreviewRuntime> {
  return import("docx-preview") as Promise<unknown> as Promise<DocxPreviewRuntime>;
}

async function defaultPptxLoader(): Promise<PptxPreviewRuntime> {
  return import("@aiden0z/pptx-renderer/browser") as Promise<unknown> as Promise<PptxPreviewRuntime>;
}

async function defaultPdfPreviewLoader(): Promise<PdfPreviewRuntime> {
  const module = typeof window === "undefined"
    ? await import("pdfjs-dist/legacy/build/pdf.mjs")
    : await import("pdfjs-dist");
  const pdfjs = module as unknown as PdfPreviewRuntime;
  if (typeof window !== "undefined" && pdfjs.GlobalWorkerOptions) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return pdfjs;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The preview was cancelled.", "AbortError");
}

function sanitizeCss(css: string): string {
  if (/expression\s*\(|behavior\s*:|-moz-binding\s*:|javascript\s*:/i.test(css)) return "";
  return css
    .replace(/@import[^;]*(?:;|$)/gi, "")
    .replace(CSS_URL, (_match, _quote: string, rawUrl: string) => {
      const url = rawUrl.trim();
      return url.startsWith("#") || url.startsWith("blob:") || SAFE_DATA_IMAGE.test(url)
        ? `url("${url.replace(/["\\\r\n]/g, "")}")`
        : "none";
    });
}

function isSafePassiveUrl(value: string): boolean {
  const normalized = value.trim();
  return normalized.startsWith("#") || normalized.startsWith("blob:") || SAFE_DATA_IMAGE.test(normalized);
}

/**
 * Removes active content and network-capable URLs emitted by third-party Office renderers.
 * The source Office bytes are still preflighted independently before either renderer loads.
 */
export function hardenRenderedOfficePreview(root: ParentNode): void {
  root.querySelectorAll(BLOCKED_PREVIEW_ELEMENTS).forEach((element) => element.remove());
  root.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "srcdoc" || name === "srcset") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (element.tagName.toLowerCase() === "a" && name === "href") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        const sanitized = sanitizeCss(attribute.value);
        if (!sanitized) element.removeAttribute(attribute.name);
        else if (sanitized !== attribute.value) element.setAttribute(attribute.name, sanitized);
        continue;
      }
      if (URL_ATTRIBUTES.has(name) && !isSafePassiveUrl(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName.toLowerCase() === "style" && element.textContent) {
      const sanitized = sanitizeCss(element.textContent);
      if (sanitized !== element.textContent) element.textContent = sanitized;
    }
  });
}

function assertPreviewInput(resource: ResourceRecord, storedBlob: ResourceBlobRecord): "docx" | "pptx" {
  if (resource.kind !== "docx" && resource.kind !== "pptx") {
    throw new ResourceError("unsupported_file", "Office preview only supports DOCX and PPTX resources.");
  }
  if (resource.status !== "ready") {
    throw new ResourceError("invalid_file", "Only ready resources can be previewed.");
  }
  const expectedMime = resource.kind === "docx" ? DOCX_MIME : PPTX_MIME;
  if (resource.mimeType !== expectedMime
    || storedBlob.mimeType !== expectedMime
    || storedBlob.resourceId !== resource.id
    || storedBlob.byteSize !== resource.byteSize
    || storedBlob.blob.size !== resource.byteSize) {
    throw new ResourceError("storage_failed", "The stored Office preview blob does not match its resource metadata.");
  }
  if (storedBlob.byteSize <= 0 || storedBlob.byteSize > RESOURCE_LIMITS.officeBytes) {
    throw new ResourceError("file_too_large", "The Office preview exceeds the allowed size.");
  }
  return resource.kind;
}

async function assertOfficePackage(
  bytes: Uint8Array,
  kind: "docx" | "pptx",
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const inspection = inspectZipArchive(bytes, officeArchiveSafetyLimits);
  const paths = new Set(inspection.entries.map((entry) => entry.path));
  const requiredPath = kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  if (!paths.has("[Content_Types].xml") || !paths.has(requiredPath)) {
    throw new ResourceError("invalid_file", `The stored file is not a valid ${kind.toUpperCase()} package.`);
  }
  const validatedBytes = await verifyZipArchiveContents(bytes, inspection, officeArchiveSafetyLimits, { signal });
  assertOfficeRelationshipsSafe(validatedBytes, inspection);
  return validatedBytes;
}

function renderedDocxPageCount(mount: HTMLElement): number | undefined {
  const pageCount = mount.querySelectorAll(".docx-wrapper > section, section.docx").length;
  return pageCount > 0 ? pageCount : undefined;
}

function clampPreviewPageIndex(pageIndex: number, pageCount: number): number {
  const finite = Number.isFinite(pageIndex) ? Math.trunc(pageIndex) : 0;
  return Math.min(Math.max(finite, 0), Math.max(pageCount - 1, 0));
}

function showDocxPage(mount: HTMLElement, pageIndex: number): void {
  const pages = [...mount.querySelectorAll<HTMLElement>(".docx-wrapper > section, section.docx")];
  if (pages.length === 0) return;
  const selected = clampPreviewPageIndex(pageIndex, pages.length);
  pages.forEach((page, index) => {
    page.hidden = index !== selected;
    page.setAttribute("aria-hidden", index === selected ? "false" : "true");
  });
}

function assertPdfPreviewInput(resource: ResourceRecord, storedBlob: ResourceBlobRecord): void {
  if (resource.kind !== "pdf") {
    throw new ResourceError("unsupported_file", "PDF preview only supports PDF resources.");
  }
  if (resource.status !== "ready") {
    throw new ResourceError("invalid_file", "Only ready resources can be previewed.");
  }
  if (resource.mimeType !== PDF_MIME
    || storedBlob.mimeType !== PDF_MIME
    || storedBlob.resourceId !== resource.id
    || storedBlob.byteSize !== resource.byteSize
    || storedBlob.blob.size !== resource.byteSize) {
    throw new ResourceError("storage_failed", "The stored PDF preview blob does not match its resource metadata.");
  }
  if (storedBlob.byteSize <= 0 || storedBlob.byteSize > RESOURCE_LIMITS.pdfBytes) {
    throw new ResourceError("file_too_large", "The PDF preview exceeds the allowed size.");
  }
}

function defaultCanvasSurface(document: Document): PdfCanvasSurface {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new ResourceError("invalid_file", "This browser cannot render a PDF preview.");
  return { canvas, context };
}

function cleanupPdfPage(page: PdfPreviewPage | undefined): void {
  try {
    page?.cleanup?.();
  } catch {
    // PDF.js cleanup must not block owned DOM and worker teardown.
  }
}

function cleanupPdfDocument(document: PdfPreviewDocument | undefined): void {
  try {
    void Promise.resolve(document?.cleanup?.()).catch(() => undefined);
  } catch {
    // PDF.js cleanup must not block owned DOM and worker teardown.
  }
}

function safePdfScale(
  viewport: PdfPreviewViewport,
  container: HTMLElement,
  maxCssWidth: number | undefined,
): { cssScale: number; outputScale: number } {
  if (!Number.isFinite(viewport.width)
    || !Number.isFinite(viewport.height)
    || viewport.width <= 0
    || viewport.height <= 0) {
    throw new ResourceError("invalid_file", "The PDF page has invalid dimensions.");
  }
  const availableWidth = maxCssWidth ?? (container.clientWidth > 0 ? container.clientWidth : 1_000);
  const boundedWidth = Math.min(Math.max(availableWidth, 240), 1_600);
  const sideScale = Math.min(
    PDF_MAX_CANVAS_SIDE / viewport.width,
    PDF_MAX_CANVAS_SIDE / viewport.height,
  );
  const pixelScale = Math.sqrt(PDF_MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
  const cssScale = Math.min(boundedWidth / viewport.width, sideScale, pixelScale);
  const devicePixelRatio = Math.min(
    Math.max(container.ownerDocument.defaultView?.devicePixelRatio ?? 1, 1),
    PDF_MAX_DEVICE_PIXEL_RATIO,
  );
  const outputScale = Math.min(
    devicePixelRatio,
    sideScale / cssScale,
    pixelScale / cssScale,
  );
  return { cssScale, outputScale };
}

export async function renderPdfResourcePreview(
  resource: ResourceRecord,
  storedBlob: ResourceBlobRecord,
  container: HTMLElement,
  options: RenderPdfPreviewOptions = {},
): Promise<PdfPreviewHandle> {
  assertPdfPreviewInput(resource, storedBlob);
  throwIfAborted(options.signal);
  const buffer = await storedBlob.blob.arrayBuffer();
  throwIfAborted(options.signal);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 5
    || bytes[0] !== 0x25
    || bytes[1] !== 0x50
    || bytes[2] !== 0x44
    || bytes[3] !== 0x46
    || bytes[4] !== 0x2d) {
    throw new ResourceError("invalid_file", "The stored file does not have a valid PDF signature.");
  }

  const pdfjs = await (options.loadPdfPreview ?? defaultPdfPreviewLoader)();
  throwIfAborted(options.signal);
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: true,
    stopAtErrors: true,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    useWorkerFetch: false,
  });
  const abortLoading = () => void loadingTask.destroy();
  options.signal?.addEventListener("abort", abortLoading, { once: true });
  let document: PdfPreviewDocument | undefined;
  let disposed = false;
  let renderGeneration = 0;
  let activeRender: ReturnType<PdfPreviewPage["render"]> | undefined;
  let activePage: PdfPreviewPage | undefined;
  let mount: HTMLDivElement | undefined;
  try {
    document = await loadingTask.promise;
    options.signal?.removeEventListener("abort", abortLoading);
    throwIfAborted(options.signal);
    if (!Number.isInteger(document.numPages) || document.numPages <= 0) {
      throw new ResourceError("invalid_file", "The PDF has no renderable pages.");
    }
    if (document.numPages > RESOURCE_LIMITS.maxPdfPages) {
      throw new ResourceError("too_many_pages", `The PDF has more than ${RESOURCE_LIMITS.maxPdfPages} pages.`);
    }

    mount = container.ownerDocument.createElement("div");
    mount.dataset.pdfPreview = resource.id;
    const surface = (options.createCanvasSurface ?? defaultCanvasSurface)(container.ownerDocument);
    surface.canvas.dataset.pdfPreviewCanvas = resource.id;
    surface.canvas.setAttribute("aria-label", `${resource.name} page preview`);
    mount.append(surface.canvas);
    container.append(mount);

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      renderGeneration += 1;
      options.signal?.removeEventListener("abort", dispose);
      options.signal?.removeEventListener("abort", abortLoading);
      try {
        activeRender?.cancel();
      } catch {
        // PDF.js cleanup is best-effort after the owned mount is detached.
      }
      cleanupPdfPage(activePage);
      activePage = undefined;
      activeRender = undefined;
      mount?.remove();
      cleanupPdfDocument(document);
      void loadingTask.destroy().catch(() => undefined);
    };
    options.signal?.addEventListener("abort", dispose, { once: true });

    const showPage = async (pageIndex: number, signal?: AbortSignal) => {
      if (disposed) return;
      throwIfAborted(options.signal);
      throwIfAborted(signal);
      const generation = renderGeneration += 1;
      try {
        activeRender?.cancel();
      } catch {
        // A completed PDF.js render may reject a late cancel; the generation guard still wins.
      }
      const page = await document?.getPage(clampPreviewPageIndex(pageIndex, document.numPages) + 1);
      if (!page || disposed || generation !== renderGeneration) {
        cleanupPdfPage(page);
        return;
      }
      throwIfAborted(options.signal);
      throwIfAborted(signal);
      cleanupPdfPage(activePage);
      activePage = page;
      const baseViewport = page.getViewport({ scale: 1 });
      const { cssScale, outputScale } = safePdfScale(baseViewport, container, options.maxCssWidth);
      const viewport = page.getViewport({ scale: cssScale * outputScale });
      surface.canvas.width = Math.max(1, Math.floor(viewport.width));
      surface.canvas.height = Math.max(1, Math.floor(viewport.height));
      surface.canvas.style.width = `${Math.max(1, Math.floor(viewport.width / outputScale))}px`;
      surface.canvas.style.height = `${Math.max(1, Math.floor(viewport.height / outputScale))}px`;
      const task = page.render({
        canvas: surface.canvas,
        canvasContext: surface.context,
        viewport,
        intent: "display",
        annotationMode: 0,
        background: "#ffffff",
        isEditing: false,
        recordImages: false,
        recordOperations: false,
      });
      activeRender = task;
      const abortPage = () => {
        try {
          task.cancel();
        } catch {
          // Cancellation is idempotent from the stage's perspective.
        }
      };
      signal?.addEventListener("abort", abortPage, { once: true });
      try {
        await task.promise;
        throwIfAborted(options.signal);
        throwIfAborted(signal);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (signal?.aborted) throw signal.reason ?? error;
        if (disposed || generation !== renderGeneration) return;
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortPage);
        cleanupPdfPage(page);
        if (activePage === page) activePage = undefined;
        if (activeRender === task) activeRender = undefined;
      }
    };

    await showPage(options.initialPageIndex ?? 0, options.signal);
    throwIfAborted(options.signal);
    if (disposed) throw new DOMException("The preview was cancelled.", "AbortError");
    return { kind: "pdf", pageCount: document.numPages, showPage, dispose };
  } catch (error) {
    mount?.remove();
    options.signal?.removeEventListener("abort", abortLoading);
    await loadingTask.destroy().catch(() => undefined);
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof ResourceError) throw error;
    throw new ResourceError("invalid_file", "The PDF preview could not be rendered safely.", { cause: error });
  }
}

export async function renderOfficeResourcePreview(
  resource: ResourceRecord,
  storedBlob: ResourceBlobRecord,
  container: HTMLElement,
  options: RenderOfficePreviewOptions = {},
): Promise<OfficePreviewHandle> {
  const kind = assertPreviewInput(resource, storedBlob);
  throwIfAborted(options.signal);

  let buffer = await storedBlob.blob.arrayBuffer();
  throwIfAborted(options.signal);
  const validatedBytes = await assertOfficePackage(new Uint8Array(buffer), kind, options.signal);
  buffer = validatedBytes.buffer.slice(
    validatedBytes.byteOffset,
    validatedBytes.byteOffset + validatedBytes.byteLength,
  ) as ArrayBuffer;

  const document = container.ownerDocument;
  const bodyMount = document.createElement("div");
  bodyMount.dataset.officePreview = resource.id;
  const styleMount = document.createElement("div");
  styleMount.dataset.officePreviewStyles = resource.id;
  container.append(bodyMount);
  (options.styleContainer ?? container).append(styleMount);

  let disposed = false;
  let viewer: PptxPreviewViewer | undefined;
  let viewerDestroyed = false;
  let renderedSlide: PptxPreviewSlideHandle | undefined;
  const MutationObserverConstructor = document.defaultView?.MutationObserver;
  const observers = MutationObserverConstructor
    ? [bodyMount, styleMount].map((mount) => {
      const observer = new MutationObserverConstructor(() => hardenRenderedOfficePreview(mount));
      observer.observe(mount, { attributes: true, childList: true, subtree: true });
      return observer;
    })
    : [];
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      options.signal?.removeEventListener("abort", dispose);
      observers.forEach((observer) => observer.disconnect());
      bodyMount.remove();
      styleMount.remove();
    }
    if (viewer && !viewerDestroyed) {
      viewerDestroyed = true;
      try {
        viewer.destroy();
      } catch {
        // Third-party cleanup must not prevent owned DOM and observers from being released.
      }
    }
    try {
      renderedSlide?.dispose();
    } catch {
      // A detached slide snapshot has its own lifecycle outside the viewer.
    }
    renderedSlide = undefined;
  };
  options.signal?.addEventListener("abort", dispose, { once: true });

  try {
    if (kind === "docx") {
      const runtime = await (options.loaders?.loadDocxPreview ?? defaultDocxLoader)();
      throwIfAborted(options.signal);
      await runtime.renderAsync(storedBlob.blob, bodyMount, styleMount, {
        inWrapper: true,
        breakPages: true,
        debug: false,
        experimental: false,
        useBase64URL: true,
        renderChanges: false,
        renderComments: false,
        renderAltChunks: false,
      });
      throwIfAborted(options.signal);
      hardenRenderedOfficePreview(bodyMount);
      hardenRenderedOfficePreview(styleMount);
      const pageCount = renderedDocxPageCount(bodyMount) ?? resource.metadata.pageCount;
      if (pageCount !== undefined && pageCount > RESOURCE_LIMITS.maxPdfPages) {
        throw new ResourceError("too_many_pages", `The document has more than ${RESOURCE_LIMITS.maxPdfPages} pages.`);
      }
      const showPage = async (pageIndex: number, signal?: AbortSignal) => {
        if (disposed) return;
        throwIfAborted(options.signal);
        throwIfAborted(signal);
        showDocxPage(bodyMount, pageIndex);
      };
      await showPage(options.initialPageIndex ?? 0, options.signal);
      return { kind: "docx", pageCount, showPage, dispose };
    }

    const runtime = await (options.loaders?.loadPptxPreview ?? defaultPptxLoader)();
    throwIfAborted(options.signal);
    const viewerMount = document.createElement("div");
    viewerMount.dataset.officePreviewViewer = resource.id;
    const selectedSlideMount = document.createElement("div");
    selectedSlideMount.dataset.officePreviewSelectedSlide = resource.id;
    bodyMount.append(viewerMount, selectedSlideMount);
    viewer = await runtime.PptxViewer.open(buffer, viewerMount, {
      fitMode: "contain",
      lazyMedia: true,
      lazySlides: true,
      pdfjs: false,
      renderMode: "slide",
      signal: options.signal,
      zipLimits: {
        maxEntries: 4_000,
        maxEntryUncompressedBytes: RESOURCE_LIMITS.maxArchiveEntryBytes,
        maxTotalUncompressedBytes: RESOURCE_LIMITS.maxOfficeUncompressedBytes,
        maxMediaBytes: RESOURCE_LIMITS.maxArchiveEntryBytes,
        maxConcurrency: 4,
      },
    });
    throwIfAborted(options.signal);
    if (viewer.slideCount > RESOURCE_LIMITS.maxSlides) {
      throw new ResourceError("too_many_slides", `The presentation has more than ${RESOURCE_LIMITS.maxSlides} slides.`);
    }
    hardenRenderedOfficePreview(bodyMount);
    hardenRenderedOfficePreview(styleMount);
    const pageCount = viewer.slideCount || resource.metadata.slideCount;
    const supportsReadySlide = typeof viewer.renderSlideToContainer === "function";
    viewerMount.hidden = supportsReadySlide;
    selectedSlideMount.hidden = !supportsReadySlide;
    let slideGeneration = 0;
    const showPage = async (pageIndex: number, signal?: AbortSignal) => {
      if (disposed) return;
      throwIfAborted(options.signal);
      throwIfAborted(signal);
      const selectedPageIndex = pageCount === undefined
        ? Math.max(0, Math.trunc(pageIndex))
        : clampPreviewPageIndex(pageIndex, pageCount);
      const generation = slideGeneration += 1;
      if (supportsReadySlide) {
        const pendingMount = document.createElement("div");
        pendingMount.dataset.officePreviewSlide = String(selectedPageIndex);
        selectedSlideMount.append(pendingMount);
        const pendingSlide = viewer?.renderSlideToContainer?.(selectedPageIndex, pendingMount);
        if (!pendingSlide) {
          pendingMount.remove();
          throw new ResourceError("invalid_file", "The selected slide could not be rendered safely.");
        }
        const abortSlide = () => {
          try {
            pendingSlide.dispose();
          } catch {
            // The slide handle may already have finished or been released.
          }
          pendingMount.remove();
        };
        options.signal?.addEventListener("abort", abortSlide, { once: true });
        signal?.addEventListener("abort", abortSlide, { once: true });
        let adopted = false;
        try {
          await pendingSlide.ready;
          throwIfAborted(options.signal);
          throwIfAborted(signal);
          if (disposed || generation !== slideGeneration) {
            abortSlide();
            return;
          }
          try {
            renderedSlide?.dispose();
          } catch {
            // Replacing a completed slide must not prevent the new slide from displaying.
          }
          renderedSlide = pendingSlide;
          adopted = true;
          selectedSlideMount.replaceChildren(pendingMount);
        } finally {
          options.signal?.removeEventListener("abort", abortSlide);
          signal?.removeEventListener("abort", abortSlide);
          if (!adopted) abortSlide();
        }
      } else if (pageCount !== undefined) {
        await viewer?.goToSlide?.(clampPreviewPageIndex(pageIndex, pageCount), {
          behavior: "instant",
          block: "center",
        });
      }
      throwIfAborted(options.signal);
      throwIfAborted(signal);
      hardenRenderedOfficePreview(bodyMount);
      hardenRenderedOfficePreview(styleMount);
    };
    await showPage(options.initialPageIndex ?? 0, options.signal);
    return { kind: "pptx", pageCount, showPage, dispose };
  } catch (error) {
    dispose();
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof ResourceError) throw error;
    throw new ResourceError("invalid_file", `The ${kind.toUpperCase()} preview could not be rendered safely.`, {
      cause: error,
    });
  }
}
