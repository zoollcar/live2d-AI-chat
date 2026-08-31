import type { ResourceBlobRecord, ResourceRecord } from "@/model/resource";
import { STAGE_WORKSPACE_MAX_ARTIFACTS } from "@/model/stage-workspace";
import {
  hardenRenderedOfficePreview,
  renderOfficeResourcePreview,
  renderPdfResourcePreview,
} from "./document-preview";
import { ResourceError } from "./errors";

export type StageOriginalDocumentKind = "pdf" | "docx" | "pptx";

export interface StageDocumentPreviewMountOptions {
  initialPageIndex: number;
  signal?: AbortSignal;
}

export interface StageDocumentPreviewHandle {
  readonly pageCount?: number;
  showPage(pageIndex: number, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

export interface StageDocumentPreviewSource {
  readonly kind: StageOriginalDocumentKind;
  mount(
    container: HTMLElement,
    options: StageDocumentPreviewMountOptions,
  ): Promise<StageDocumentPreviewHandle>;
}

export interface StageDocumentPreviewSourceOptions {
  renderOfficePreview?: typeof renderOfficeResourcePreview;
  renderPdfPreview?: typeof renderPdfResourcePreview;
}

interface RegisteredPreview {
  token: object;
  source: StageDocumentPreviewSource;
}

interface OfficeMount {
  body: HTMLElement;
  frame: HTMLIFrameElement;
  styles: HTMLElement;
  publishSnapshot(): void;
  dispose(): void;
}

const OFFICE_SNAPSHOT_MAX_ELEMENTS = 50_000;
const OFFICE_SNAPSHOT_MAX_DATA_IMAGE_CHARS = 8_000_000;
const OFFICE_SNAPSHOT_MAX_HTML_CHARS = 12_000_000;
const SAFE_SNAPSHOT_DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;
const SNAPSHOT_CSS_URL = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
const SNAPSHOT_IMAGE_SET = /(?:-webkit-)?image-set\([^)]*\)/gi;
const SNAPSHOT_EXTERNAL_SCHEME = /(?:https?|ftp|file|blob|javascript|vbscript):/i;
const BLOCKED_SNAPSHOT_ELEMENTS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "fencedframe",
  "object",
  "embed",
  "portal",
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
  "animate",
  "animateMotion",
  "animateTransform",
  "discard",
  "set",
  "template",
  "noscript",
  "noembed",
  "noframes",
  "listing",
  "plaintext",
  "title",
  "xmp",
].join(",");
const SNAPSHOT_URL_ATTRIBUTES = new Set([
  "action",
  "cite",
  "data",
  "formaction",
  "href",
  "ping",
  "poster",
  "src",
  "xlink:href",
]);
const OFFICE_SNAPSHOT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data:",
  "media-src 'none'",
  "navigate-to 'none'",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
].join("; ");
const OFFICE_SNAPSHOT_BASE_CSS = [
  ":root { color-scheme: light; background: #fff; }",
  "html, body { min-height: 100%; margin: 0; background: #fff; color: #17131d; }",
  "body { overflow: auto; }",
  "img, svg { max-width: 100%; height: auto; }",
  "[hidden], [aria-hidden=\"true\"] { display: none !important; }",
].join("\n");

const previewRegistry = new Map<string, RegisteredPreview>();

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The preview was cancelled.", "AbortError");
}

function sanitizeSnapshotCss(css: string): string {
  if (/expression\s*\(|behavior\s*:|-moz-binding\s*:|javascript\s*:/i.test(css)) return "";
  return css
    .replace(/@import[^;]*(?:;|$)/gi, "")
    .replace(SNAPSHOT_IMAGE_SET, "none")
    .replace(SNAPSHOT_CSS_URL, (_match, _quote: string, rawUrl: string) => {
      const url = rawUrl.trim();
      const safeDataImage = url.length <= OFFICE_SNAPSHOT_MAX_DATA_IMAGE_CHARS
        && SAFE_SNAPSHOT_DATA_IMAGE.test(url);
      return url.startsWith("#") || safeDataImage
        ? `url("${url.replace(/["\\\r\n]/g, "")}")`
        : "none";
    })
    .replace(/(?:https?|ftp|file|blob|javascript|vbscript):[^\s;)}"']*/gi, "")
    .replace(/[<>]/g, "");
}

function safeSnapshotUrl(element: Element, attributeName: string, value: string): boolean {
  const normalized = value.trim();
  if (normalized.length > OFFICE_SNAPSHOT_MAX_DATA_IMAGE_CHARS) return false;
  if (SAFE_SNAPSHOT_DATA_IMAGE.test(normalized)) {
    const tagName = element.tagName.toLowerCase();
    return tagName === "img" || tagName === "image";
  }
  return normalized.startsWith("#")
    && (attributeName === "href" || attributeName === "xlink:href")
    && element.namespaceURI === "http://www.w3.org/2000/svg";
}

function hardenSnapshotTree(root: ParentNode): void {
  hardenRenderedOfficePreview(root);
  root.querySelectorAll(BLOCKED_SNAPSHOT_ELEMENTS).forEach((element) => element.remove());
  root.querySelectorAll("*").forEach((element) => {
    if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") {
      element.remove();
      return;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on")
        || name.startsWith("xmlns")
        || name === "allow"
        || name === "autofocus"
        || name === "download"
        || name === "srcdoc"
        || name === "srcset"
        || name === "target") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        const sanitized = sanitizeSnapshotCss(value);
        if (sanitized) element.setAttribute(attribute.name, sanitized);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (SNAPSHOT_URL_ATTRIBUTES.has(name)) {
        if (!safeSnapshotUrl(element, name, value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (SNAPSHOT_EXTERNAL_SCHEME.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (/url\s*\(/i.test(value)) {
        const sanitized = sanitizeSnapshotCss(value);
        if (!sanitized) {
          element.removeAttribute(attribute.name);
        } else {
          element.setAttribute(attribute.name, sanitized);
        }
      }
    }
    if (element.tagName.toLowerCase() === "style") {
      const sanitized = sanitizeSnapshotCss(element.textContent ?? "");
      if (sanitized) element.textContent = sanitized;
      else element.remove();
    }
  });
}

function removeNonSnapshotNodes(root: Node): void {
  const document = root.ownerDocument;
  if (!document) return;
  const walker = document.createTreeWalker(root, 0xffffffff);
  const removals: Node[] = [];
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType !== 1 && node.nodeType !== 3) removals.push(node);
    node = walker.nextNode();
  }
  removals.forEach((candidate) => candidate.parentNode?.removeChild(candidate));
}

function snapshotCanvasElements(source: ParentNode, clone: ParentNode): void {
  const sourceCanvases = [...source.querySelectorAll<HTMLCanvasElement>("canvas")];
  const clonedCanvases = [...clone.querySelectorAll<HTMLCanvasElement>("canvas")];
  clonedCanvases.forEach((canvas, index) => {
    const sourceCanvas = sourceCanvases[index];
    if (!sourceCanvas) {
      canvas.remove();
      return;
    }
    try {
      const dataUrl = sourceCanvas.toDataURL("image/png");
      if (dataUrl.length > OFFICE_SNAPSHOT_MAX_DATA_IMAGE_CHARS
        || !SAFE_SNAPSHOT_DATA_IMAGE.test(dataUrl)) {
        canvas.remove();
        return;
      }
      const image = canvas.ownerDocument.createElement("img");
      image.src = dataUrl;
      image.alt = sourceCanvas.getAttribute("aria-label") ?? "";
      if (sourceCanvas.width > 0) image.width = sourceCanvas.width;
      if (sourceCanvas.height > 0) image.height = sourceCanvas.height;
      if (sourceCanvas.className) image.className = sourceCanvas.className;
      const inlineStyle = sanitizeSnapshotCss(sourceCanvas.getAttribute("style") ?? "");
      if (inlineStyle) image.setAttribute("style", inlineStyle);
      canvas.replaceWith(image);
    } catch {
      canvas.remove();
    }
  });
}

function serializeOfficeSnapshot(body: HTMLElement, styles: HTMLElement): string {
  hardenRenderedOfficePreview(body);
  hardenRenderedOfficePreview(styles);
  const bodyClone = body.cloneNode(true) as HTMLElement;
  const stylesClone = styles.cloneNode(true) as HTMLElement;
  snapshotCanvasElements(body, bodyClone);
  snapshotCanvasElements(styles, stylesClone);
  removeNonSnapshotNodes(bodyClone);
  removeNonSnapshotNodes(stylesClone);
  hardenSnapshotTree(bodyClone);
  hardenSnapshotTree(stylesClone);

  const elementCount = bodyClone.querySelectorAll("*").length + stylesClone.querySelectorAll("*").length;
  if (elementCount > OFFICE_SNAPSHOT_MAX_ELEMENTS) {
    throw new ResourceError("invalid_file", "The Office preview snapshot is too complex to display safely.");
  }

  const document = body.ownerDocument.implementation.createHTMLDocument("");
  document.documentElement.lang = "en";
  const charset = document.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const csp = document.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", OFFICE_SNAPSHOT_CSP);
  const baseStyle = document.createElement("style");
  baseStyle.textContent = OFFICE_SNAPSHOT_BASE_CSS;
  document.head.replaceChildren(charset, csp, baseStyle);

  const renderedStyles = [...stylesClone.querySelectorAll("style"), ...bodyClone.querySelectorAll("style")];
  renderedStyles.forEach((style) => {
    const css = sanitizeSnapshotCss(style.textContent ?? "");
    style.remove();
    if (!css) return;
    const copy = document.createElement("style");
    copy.textContent = css;
    document.head.append(copy);
  });
  document.body.replaceChildren(...[...bodyClone.childNodes]);

  const html = `<!doctype html>\n${document.documentElement.outerHTML}`;
  if (html.length > OFFICE_SNAPSHOT_MAX_HTML_CHARS) {
    throw new ResourceError("invalid_file", "The Office preview snapshot is too large to display safely.");
  }
  return html;
}

function officeMount(container: HTMLElement, title: string): OfficeMount {
  const document = container.ownerDocument;
  const renderDocument = document.implementation.createHTMLDocument("");
  const renderCsp = renderDocument.createElement("meta");
  renderCsp.setAttribute("http-equiv", "Content-Security-Policy");
  renderCsp.setAttribute("content", OFFICE_SNAPSHOT_CSP);
  renderDocument.head.append(renderCsp);
  const styles = renderDocument.createElement("div");
  const body = renderDocument.createElement("div");
  body.className = "stage-document-original-body";
  renderDocument.body.append(styles, body);

  const frame = document.createElement("iframe");
  frame.className = "stage-document-original-frame";
  frame.title = `${title} original preview`;
  frame.loading = "lazy";
  frame.referrerPolicy = "no-referrer";
  frame.setAttribute("sandbox", "");
  container.append(frame);

  return {
    body,
    frame,
    styles,
    publishSnapshot() {
      frame.srcdoc = serializeOfficeSnapshot(body, styles);
    },
    dispose() {
      frame.removeAttribute("srcdoc");
      frame.remove();
      renderDocument.body.replaceChildren();
    },
  };
}

export function createStageDocumentPreviewSource(
  resource: ResourceRecord,
  storedBlob: ResourceBlobRecord,
  sourceOptions: StageDocumentPreviewSourceOptions = {},
): StageDocumentPreviewSource | undefined {
  if (resource.kind !== "pdf" && resource.kind !== "docx" && resource.kind !== "pptx") return undefined;
  const kind = resource.kind;
  return {
    kind,
    async mount(container, options) {
      if (kind === "pdf") {
        return (sourceOptions.renderPdfPreview ?? renderPdfResourcePreview)(
          resource,
          storedBlob,
          container,
          options,
        );
      }
      const ownedMount = officeMount(container, resource.name);
      try {
        const handle = await (sourceOptions.renderOfficePreview ?? renderOfficeResourcePreview)(
          resource,
          storedBlob,
          ownedMount.body,
          {
            ...options,
            styleContainer: ownedMount.styles,
          },
        );
        throwIfAborted(options.signal);
        ownedMount.publishSnapshot();
        let disposed = false;
        let pageGeneration = 0;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          pageGeneration += 1;
          options.signal?.removeEventListener("abort", dispose);
          handle.dispose();
          ownedMount.dispose();
        };
        options.signal?.addEventListener("abort", dispose, { once: true });
        return {
          pageCount: handle.pageCount,
          async showPage(pageIndex, signal) {
            if (disposed) return;
            throwIfAborted(options.signal);
            throwIfAborted(signal);
            const generation = pageGeneration += 1;
            await handle.showPage(pageIndex, signal);
            if (disposed || generation !== pageGeneration) return;
            throwIfAborted(options.signal);
            throwIfAborted(signal);
            ownedMount.publishSnapshot();
          },
          dispose,
        };
      } catch (error) {
        ownedMount.dispose();
        throw error;
      }
    },
  };
}

/**
 * Keeps original bytes out of StageArtifact and the Zustand workspace. The
 * disposer is token-bound so replacing a loaded artifact cannot unregister a
 * newer preview for the same artifact id.
 */
export function registerStageDocumentPreviewSource(
  artifactId: string,
  source: StageDocumentPreviewSource,
): () => void {
  const token = {};
  previewRegistry.delete(artifactId);
  previewRegistry.set(artifactId, { token, source });
  while (previewRegistry.size > STAGE_WORKSPACE_MAX_ARTIFACTS) {
    const oldestArtifactId = previewRegistry.keys().next().value as string | undefined;
    if (!oldestArtifactId) break;
    previewRegistry.delete(oldestArtifactId);
  }
  return () => {
    if (previewRegistry.get(artifactId)?.token === token) previewRegistry.delete(artifactId);
  };
}

export function getStageDocumentPreviewSource(
  artifactId: string,
): StageDocumentPreviewSource | undefined {
  return previewRegistry.get(artifactId)?.source;
}
