/// <reference lib="webworker" />

import { OfficeParser } from "officeparser/slim";
import { RESOURCE_LIMITS } from "../limits";
import { extractOfficeAst, type OfficeAstLike, type OfficeExtraction } from "./office-extraction";

interface OfficeWorkerRequest {
  kind: "docx" | "pptx";
  bytes: Uint8Array;
}

export type OfficeWorkerResponse =
  | { ok: true; extraction: OfficeExtraction }
  | { ok: false; message: string };

self.onmessage = (event: MessageEvent<OfficeWorkerRequest>) => {
  const { kind, bytes } = event.data;
  void OfficeParser.parseOffice(bytes, {
    fileType: kind,
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
  }).then((ast) => extractOfficeAst(ast as OfficeAstLike, kind))
    .then((extraction) => self.postMessage({ ok: true, extraction } satisfies OfficeWorkerResponse))
    .catch((error) => self.postMessage({
      ok: false,
      message: error instanceof Error ? error.message.slice(0, 2_000) : "Office parsing failed.",
    } satisfies OfficeWorkerResponse));
};
