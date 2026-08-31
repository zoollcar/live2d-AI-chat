import type { ResourceBundle } from "@/model/resource";
import { ResourceError } from "../errors";
import { validateResourceFile } from "../validation";
import { ingestImageResource } from "./image";
import { ingestOfficeResource } from "./office";
import { ingestPdfResource } from "./pdf";
import { ingestSvgResource } from "./svg";
import { ingestTextResource } from "./text";
import type { ResourceIngestionOptions } from "./types";

export async function ingestResourceFile(
  file: File,
  options: ResourceIngestionOptions,
): Promise<ResourceBundle> {
  options.signal?.throwIfAborted();
  const validated = await validateResourceFile(file, options.signal);
  switch (validated.kind) {
    case "text":
      return ingestTextResource(validated, options);
    case "image":
      return ingestImageResource(validated, options);
    case "svg":
      return ingestSvgResource(validated, options);
    case "pdf":
      return ingestPdfResource(validated, options);
    case "docx":
    case "pptx":
      return ingestOfficeResource(validated, options);
    default:
      throw new ResourceError("unsupported_file", "No ingestion adapter is registered for this file.");
  }
}

export { ingestDocxResource, ingestOfficeResource, ingestPptxResource } from "./office";
export { ingestPdfResource } from "./pdf";
export { ingestTextResource } from "./text";
export { ingestImageResource } from "./image";
export { ingestSvgResource, sanitizeSvgText, type SvgSanitizationOptions } from "./svg";
export type { ResourceIngestionAdapter, ResourceIngestionOptions } from "./types";
