// @vitest-environment jsdom

import { resourceRecordSchema, type ResourceBlobRecord, type ResourceRecord } from "@/model/resource";
import { describe, expect, it, vi } from "vitest";
import type { OfficePreviewHandle, RenderOfficePreviewOptions } from "./document-preview";
import { createStageDocumentPreviewSource } from "./stage-document-preview";

const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

function readyOfficeResource(kind: "docx" | "pptx"): {
  resource: ResourceRecord;
  storedBlob: ResourceBlobRecord;
} {
  const mimeType = OFFICE_MIME[kind];
  const blob = new Blob(["office preview"], { type: mimeType });
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

describe("stage Office document preview", () => {
  it.each(["docx", "pptx"] as const)(
    "publishes %s pages only as hardened snapshots in an empty sandbox iframe",
    async (kind) => {
      const { resource, storedBlob } = readyOfficeResource(kind);
      const container = document.createElement("div");
      document.body.append(container);
      const disposeRenderer = vi.fn();
      let rendererWasDetached = false;
      const showPage = vi.fn(async (pageIndex: number) => {
        const page = container.ownerDocument.createElement("p");
        page.className = "current-page";
        page.textContent = `Page ${pageIndex + 1}`;
        page.setAttribute("onclick", "location='https://navigate.invalid'");
        rendererBody?.replaceChildren(page);
      });
      let rendererBody: HTMLElement | undefined;
      const renderOfficePreview = vi.fn(async (
        _resource: ResourceRecord,
        _blob: ResourceBlobRecord,
        body: HTMLElement,
        options: RenderOfficePreviewOptions = {},
      ): Promise<OfficePreviewHandle> => {
        rendererBody = body;
        rendererWasDetached = body.ownerDocument !== document
          && body.ownerDocument.defaultView === null
          && options.styleContainer?.ownerDocument === body.ownerDocument
          && options.styleContainer.ownerDocument.defaultView === null;
        const page = document.createElement("section");
        page.className = "current-page";
        page.textContent = "Page 1";
        page.setAttribute("onclick", "alert(1)");
        page.setAttribute("style", "background:url(https://tracker.invalid/pixel)");
        const script = document.createElement("script");
        script.textContent = "alert(1)";
        const nestedFrame = document.createElement("iframe");
        nestedFrame.src = "https://frame.invalid";
        const externalImage = document.createElement("img");
        externalImage.src = "blob:https://files.invalid/image";
        const link = document.createElement("a");
        link.href = "javascript:alert(1)";
        link.textContent = "Unsafe link";
        const template = document.createElement("template");
        template.innerHTML = "<script src=\"https://script.invalid/a.js\"></script>";
        const rawText = document.createElement("noembed");
        rawText.textContent = '</noembed><meta http-equiv="refresh" content="0;url=https://refresh.invalid">';
        const comment = document.createComment(
          '--><meta http-equiv="refresh" content="0;url=https://comment.invalid"><!--',
        );
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        canvas.setAttribute("aria-label", "Rendered slide");
        canvas.toDataURL = vi.fn(() => "data:image/png;base64,aGVsbG8=");
        page.append(script, nestedFrame, externalImage, link, template, rawText, comment, canvas);
        body.append(page);

        const style = document.createElement("style");
        style.textContent = [
          "@import 'https://styles.invalid/main.css';",
          ".external { background-image: url(https://tracker.invalid/pixel); }",
          ".blob { background-image: url(blob:https://files.invalid/background); }",
          ".safe { color: rgb(20, 20, 20); }",
        ].join("\n");
        options.styleContainer?.append(style);
        return {
          kind,
          pageCount: 2,
          showPage,
          dispose: disposeRenderer,
        };
      });
      const source = createStageDocumentPreviewSource(resource, storedBlob, { renderOfficePreview });
      const handle = await source?.mount(container, { initialPageIndex: 0 });
      const frame = container.querySelector<HTMLIFrameElement>("iframe.stage-document-original-frame");

      expect(frame).not.toBeNull();
      expect(frame?.getAttribute("sandbox")).toBe("");
      expect((frame?.getAttribute("sandbox") ?? "missing").split(/\s+/).filter(Boolean)).toHaveLength(0);
      expect(frame?.hasAttribute("allow")).toBe(false);
      expect(frame?.hasAttribute("src")).toBe(false);
      expect(frame?.referrerPolicy).toBe("no-referrer");
      expect(container.children).toHaveLength(1);
      expect(rendererWasDetached).toBe(true);

      const firstSnapshot = frame?.srcdoc ?? "";
      const firstDocument = new DOMParser().parseFromString(firstSnapshot, "text/html");
      expect(firstDocument.querySelector("script, iframe, object, embed, template, form, noembed")).toBeNull();
      expect(firstDocument.querySelector('meta[http-equiv="refresh"]')).toBeNull();
      expect(firstDocument.querySelector("[onclick], [srcdoc], [srcset]")).toBeNull();
      expect(firstDocument.querySelector("canvas")).toBeNull();
      expect(firstDocument.querySelector('img[src^="data:image/png"]')?.getAttribute("src"))
        .toBe("data:image/png;base64,aGVsbG8=");
      expect(firstDocument.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"))
        .toContain("default-src 'none'");
      expect(firstSnapshot).not.toMatch(/(?:https?|blob|javascript):/i);
      expect(firstSnapshot).not.toContain("@import");
      expect(firstSnapshot).not.toContain("refresh.invalid");
      expect(firstSnapshot).not.toContain("comment.invalid");

      await handle?.showPage(1);
      expect(showPage).toHaveBeenCalledWith(1, undefined);
      expect(frame?.srcdoc).toContain("Page 2");
      expect(frame?.srcdoc).not.toContain("navigate.invalid");

      handle?.dispose();
      expect(disposeRenderer).toHaveBeenCalledOnce();
      expect(container.querySelector("iframe")).toBeNull();
      container.remove();
    },
  );

  it("removes the sandbox snapshot and renderer when its mount is aborted", async () => {
    const { resource, storedBlob } = readyOfficeResource("docx");
    const container = document.createElement("div");
    const controller = new AbortController();
    const dispose = vi.fn();
    const source = createStageDocumentPreviewSource(resource, storedBlob, {
      renderOfficePreview: async (_resource, _blob, body) => {
        body.textContent = "Rendered document";
        return { kind: "docx", pageCount: 1, showPage: async () => undefined, dispose };
      },
    });

    await source?.mount(container, { initialPageIndex: 0, signal: controller.signal });
    expect(container.querySelector('iframe[sandbox=""]')).not.toBeNull();
    controller.abort(new DOMException("closed", "AbortError"));
    expect(dispose).toHaveBeenCalledOnce();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
