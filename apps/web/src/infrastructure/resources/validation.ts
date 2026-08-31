import type { ResourceKind } from "@/model/resource";
import { ResourceError } from "./errors";
import { RESOURCE_LIMITS } from "./limits";
import {
  assertOfficeRelationshipsSafe,
  inspectZipArchive,
  officeArchiveSafetyLimits,
  verifyZipArchiveContents,
} from "./zip-safety";

export interface ValidatedResourceFile {
  file: File;
  bytes: Uint8Array;
  kind: Exclude<ResourceKind, "web" | "video-transcript">;
  extension: string;
  mimeType: string;
}

interface FileRule {
  kind: ValidatedResourceFile["kind"];
  mimeType: string;
  maxBytes: number;
}

const extensionRules: Record<string, FileRule> = {
  pdf: { kind: "pdf", mimeType: "application/pdf", maxBytes: RESOURCE_LIMITS.pdfBytes },
  docx: {
    kind: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    maxBytes: RESOURCE_LIMITS.officeBytes,
  },
  pptx: {
    kind: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    maxBytes: RESOURCE_LIMITS.officeBytes,
  },
  txt: { kind: "text", mimeType: "text/plain", maxBytes: RESOURCE_LIMITS.textBytes },
  md: { kind: "text", mimeType: "text/markdown", maxBytes: RESOURCE_LIMITS.textBytes },
  json: { kind: "text", mimeType: "application/json", maxBytes: RESOURCE_LIMITS.textBytes },
  png: { kind: "image", mimeType: "image/png", maxBytes: RESOURCE_LIMITS.imageBytes },
  jpg: { kind: "image", mimeType: "image/jpeg", maxBytes: RESOURCE_LIMITS.imageBytes },
  jpeg: { kind: "image", mimeType: "image/jpeg", maxBytes: RESOURCE_LIMITS.imageBytes },
  webp: { kind: "image", mimeType: "image/webp", maxBytes: RESOURCE_LIMITS.imageBytes },
  svg: { kind: "svg", mimeType: "image/svg+xml", maxBytes: RESOURCE_LIMITS.svgBytes },
};

function fileExtension(name: string): string {
  return name.trim().toLowerCase().match(/\.([a-z0-9]{1,12})$/)?.[1] ?? "";
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function assertMagic(kind: ValidatedResourceFile["kind"], extension: string, bytes: Uint8Array): void {
  if (kind === "pdf" && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    throw new ResourceError("invalid_file", "The file does not have a valid PDF signature.");
  }
  if ((kind === "docx" || kind === "pptx") && !startsWith(bytes, [0x50, 0x4b])) {
    throw new ResourceError("invalid_file", "The Office document is not a ZIP-based OOXML file.");
  }
  if (kind === "image") {
    const valid = extension === "png"
      ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : extension === "jpg" || extension === "jpeg"
        ? startsWith(bytes, [0xff, 0xd8, 0xff])
        : extension === "webp"
          ? startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
            && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
          : false;
    if (!valid) throw new ResourceError("invalid_file", "The image signature does not match a supported format.");
  }
  if (kind === "text" || kind === "svg") {
    const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
    if (sample.includes(0)) throw new ResourceError("invalid_file", "Text resources must not contain binary NUL bytes.");
  }
}

export async function validateResourceFile(file: File, signal?: AbortSignal): Promise<ValidatedResourceFile> {
  signal?.throwIfAborted();
  const extension = fileExtension(file.name);
  const rule = extensionRules[extension];
  if (!rule) {
    throw new ResourceError(
      "unsupported_file",
      "Supported files are PDF, DOCX, PPTX, TXT, MD, JSON, PNG, JPEG, WebP, and SVG.",
    );
  }
  if (file.size <= 0) throw new ResourceError("invalid_file", "The selected file is empty.");
  if (file.size > rule.maxBytes) {
    throw new ResourceError("file_too_large", `${file.name} exceeds the ${(rule.maxBytes / 1024 / 1024).toFixed(0)} MiB limit.`);
  }

  let bytes: Uint8Array = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  assertMagic(rule.kind, extension, bytes);
  if (rule.kind === "docx" || rule.kind === "pptx") {
    const inspection = inspectZipArchive(bytes, officeArchiveSafetyLimits);
    const paths = new Set(inspection.entries.map((entry) => entry.path));
    const documentPath = rule.kind === "docx" ? "word/document.xml" : "ppt/presentation.xml";
    if (!paths.has("[Content_Types].xml") || !paths.has(documentPath)) {
      throw new ResourceError("invalid_file", `The ZIP is not a valid ${rule.kind.toUpperCase()} package.`);
    }
    bytes = await verifyZipArchiveContents(bytes, inspection, officeArchiveSafetyLimits, { signal });
    assertOfficeRelationshipsSafe(bytes, inspection);
  }

  const suppliedMime = file.type.trim().toLowerCase();
  if (suppliedMime && suppliedMime !== "application/octet-stream") {
    const compatible = suppliedMime === rule.mimeType
      || (rule.kind === "text" && (suppliedMime.startsWith("text/") || suppliedMime === "application/json"));
    if (!compatible) throw new ResourceError("invalid_file", "The file extension and media type do not match.");
  }

  return { file, bytes, kind: rule.kind, extension, mimeType: rule.mimeType };
}
