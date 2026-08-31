export type ImageInspectionErrorCode =
  | "capability-unavailable"
  | "resource-not-found"
  | "not-image"
  | "image-not-ready"
  | "image-data-missing"
  | "unsupported-image"
  | "decode-failed"
  | "encode-failed"
  | "invalid-question"
  | "empty-analysis"
  | "inspection-failed";

export class ImageInspectionError extends Error {
  readonly code: ImageInspectionErrorCode;

  constructor(code: ImageInspectionErrorCode, message: string) {
    super(message);
    this.name = "ImageInspectionError";
    this.code = code;
  }
}
