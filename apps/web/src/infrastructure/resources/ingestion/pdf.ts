import { ResourceError } from "../errors";
import { RESOURCE_LIMITS } from "../limits";
import type { ValidatedResourceFile } from "../validation";
import { finalizeResourceBundle } from "./finalize";
import type { ResourceIngestionOptions } from "./types";

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfDocumentProxyLike {
  numPages: number;
  getPage(page: number): Promise<{
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
    cleanup?(): void;
  }>;
  getMetadata?(): Promise<{ info?: Record<string, unknown>; metadata?: unknown }>;
}

interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentProxyLike>;
  destroy(): Promise<void>;
}

export interface PdfJsLike {
  getDocument(options: Record<string, unknown>): PdfLoadingTaskLike;
  GlobalWorkerOptions?: { workerSrc: string };
}

export type PdfJsLoader = () => Promise<PdfJsLike>;

async function loadPdfJs(): Promise<PdfJsLike> {
  const module = typeof window === "undefined"
    ? await import("pdfjs-dist/legacy/build/pdf.mjs")
    : await import("pdfjs-dist");
  const pdfjs = module as unknown as PdfJsLike;
  if (typeof window !== "undefined" && pdfjs.GlobalWorkerOptions) {
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return pdfjs;
}

function pdfInfoString(info: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = info?.[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_000) : undefined;
}

export async function ingestPdfResource(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
  load: PdfJsLoader = loadPdfJs,
) {
  options.signal?.throwIfAborted();
  const pdfjs = await load();
  const task = pdfjs.getDocument({
    data: new Uint8Array(file.bytes),
    isEvalSupported: false,
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: true,
    stopAtErrors: true,
  });
  const abort = () => void task.destroy();
  options.signal?.addEventListener("abort", abort, { once: true });
  let document: PdfDocumentProxyLike | undefined;
  try {
    document = await task.promise;
    if (!Number.isInteger(document.numPages) || document.numPages <= 0) {
      throw new ResourceError("invalid_file", "The PDF has no readable pages.");
    }
    if (document.numPages > RESOURCE_LIMITS.maxPdfPages) {
      throw new ResourceError(
        "too_many_pages",
        `The PDF has more than ${RESOURCE_LIMITS.maxPdfPages} pages.`,
      );
    }
    const sections: Array<{ text: string; locator: { page: number; label: string } }> = [];
    let extractedChars = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      options.signal?.throwIfAborted();
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        let text = "";
        for (const item of content.items) {
          if (typeof item.str !== "string") continue;
          text += item.str;
          text += item.hasEOL ? "\n" : " ";
        }
        text = text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
        extractedChars += text.length;
        if (extractedChars > RESOURCE_LIMITS.maxExtractedChars) {
          throw new ResourceError("extracted_text_too_large", "The PDF contains too much extracted text.");
        }
        sections.push({ text, locator: { page: pageNumber, label: `Page ${pageNumber}` } });
      } finally {
        page.cleanup?.();
      }
    }
    const metadata = await document.getMetadata?.().catch(() => undefined);
    return await finalizeResourceBundle({
      file,
      options,
      kind: "pdf",
      sections,
      metadata: {
        pageCount: document.numPages,
        title: pdfInfoString(metadata?.info, "Title"),
        author: pdfInfoString(metadata?.info, "Author"),
      },
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof ResourceError) throw error;
    throw new ResourceError("invalid_file", "The PDF could not be safely parsed.", { cause: error });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await task.destroy().catch(() => undefined);
  }
}
