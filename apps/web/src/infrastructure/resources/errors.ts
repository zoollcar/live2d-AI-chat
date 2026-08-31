export type ResourceErrorCode =
  | "unsupported_file"
  | "invalid_file"
  | "file_too_large"
  | "too_many_pages"
  | "too_many_slides"
  | "extracted_text_too_large"
  | "unsafe_svg"
  | "unsafe_archive"
  | "archive_too_large"
  | "archive_integrity_failed"
  | "resource_not_found"
  | "invalid_cursor"
  | "storage_failed";

export class ResourceError extends Error {
  readonly code: ResourceErrorCode;

  constructor(code: ResourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ResourceError";
    this.code = code;
  }
}

export function asResourceError(error: unknown, fallback: string): ResourceError {
  if (error instanceof ResourceError) return error;
  return new ResourceError(
    "invalid_file",
    error instanceof Error ? error.message : fallback,
    error instanceof Error ? { cause: error } : undefined,
  );
}
