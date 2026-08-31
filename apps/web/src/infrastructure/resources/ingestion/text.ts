import { ResourceError } from "../errors";
import type { ValidatedResourceFile } from "../validation";
import { finalizeResourceBundle } from "./finalize";
import type { ResourceIngestionOptions } from "./types";

export async function ingestTextResource(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
) {
  options.signal?.throwIfAborted();
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (error) {
    throw new ResourceError("invalid_file", "Text files must use valid UTF-8 encoding.", { cause: error });
  }
  text = text.replace(/^\uFEFF/, "");
  return finalizeResourceBundle({
    file,
    options,
    kind: "text",
    sections: [{ text }],
  });
}
