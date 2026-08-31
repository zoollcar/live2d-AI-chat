import { ResourceError } from "../errors";
import { RESOURCE_LIMITS } from "../limits";
import type { ValidatedResourceFile } from "../validation";
import { finalizeResourceBundle } from "./finalize";
import { extractOfficeAst, type OfficeAstLike, type OfficeExtraction } from "./office-extraction";
import type { OfficeWorkerResponse } from "./office-parser.worker";
import type { ResourceIngestionOptions } from "./types";

interface OfficeParserModuleLike {
  OfficeParser: {
    parseOffice(input: Uint8Array, options: Record<string, unknown>): Promise<OfficeAstLike>;
  };
}

export type OfficeParserLoader = () => Promise<OfficeParserModuleLike>;

export interface OfficeParserWorkerLike {
  onmessage: ((event: MessageEvent<OfficeWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

export type OfficeParserWorkerFactory = () => OfficeParserWorkerLike;

async function loadOfficeParser(): Promise<OfficeParserModuleLike> {
  return import("officeparser/slim") as Promise<unknown> as Promise<OfficeParserModuleLike>;
}

function createOfficeParserWorker(): OfficeParserWorkerLike {
  return new Worker(new URL("./office-parser.worker.ts", import.meta.url), {
    type: "module",
    name: "live2d-office-parser",
  });
}

export function parseOfficeInWorker(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
  createWorker: OfficeParserWorkerFactory = createOfficeParserWorker,
): Promise<OfficeExtraction> {
  return new Promise((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => finish(() => reject(
      options.signal?.reason ?? new DOMException("Office parsing was cancelled.", "AbortError"),
    ));
    const timer = globalThis.setTimeout(() => finish(() => reject(new ResourceError(
      "invalid_file",
      "Office parsing exceeded the processing time limit.",
    ))), RESOURCE_LIMITS.officeProcessingTimeoutMs);
    worker.onmessage = (event) => finish(() => {
      if (event.data.ok) resolve(event.data.extraction);
      else reject(new ResourceError("invalid_file", event.data.message));
    });
    worker.onerror = (event) => finish(() => reject(new ResourceError(
      "invalid_file",
      event.message || "The Office parsing worker failed.",
    )));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const bytes = file.bytes.slice();
    worker.postMessage({ kind: file.kind, bytes }, [bytes.buffer]);
  });
}

export async function ingestOfficeResource(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
  load?: OfficeParserLoader,
) {
  if (file.kind !== "docx" && file.kind !== "pptx") {
    throw new ResourceError("unsupported_file", "The Office adapter only accepts DOCX and PPTX resources.");
  }
  options.signal?.throwIfAborted();
  try {
    let extraction: OfficeExtraction;
    if (!load && typeof Worker !== "undefined") {
      extraction = await parseOfficeInWorker(file, options);
    } else {
      const { OfficeParser } = await (load ?? loadOfficeParser)();
      const ast = await OfficeParser.parseOffice(new Uint8Array(file.bytes), {
        fileType: file.kind,
        abortSignal: options.signal,
        extractAttachments: false,
        includeRawContent: false,
        ignoreComments: true,
        ignoreSlideMasters: true,
        ocr: false,
        onWarning: () => undefined,
        decompressionLimits: {
          maxUncompressedBytes: RESOURCE_LIMITS.maxOfficeUncompressedBytes,
          maxZipEntries: RESOURCE_LIMITS.maxArchiveEntries,
        },
      });
      extraction = await extractOfficeAst(ast, file.kind);
    }
    options.signal?.throwIfAborted();
    return await finalizeResourceBundle({
      file,
      options,
      kind: file.kind,
      sections: extraction.sections,
      metadata: extraction.metadata,
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof ResourceError) throw error;
    throw new ResourceError("invalid_file", `The ${file.kind.toUpperCase()} document could not be safely parsed.`, {
      cause: error,
    });
  }
}

export function ingestDocxResource(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
  load?: OfficeParserLoader,
) {
  if (file.kind !== "docx") throw new ResourceError("unsupported_file", "Expected a DOCX resource.");
  return ingestOfficeResource(file, options, load);
}

export function ingestPptxResource(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
  load?: OfficeParserLoader,
) {
  if (file.kind !== "pptx") throw new ResourceError("unsupported_file", "Expected a PPTX resource.");
  return ingestOfficeResource(file, options, load);
}
