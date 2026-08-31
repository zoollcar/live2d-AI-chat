/// <reference lib="webworker" />

import type { ResourceErrorCode } from "./errors";
import { ResourceError } from "./errors";
import {
  validateZipEntryStreams,
  type ZipExpansionLimits,
  type ZipStreamEntryInfo,
} from "./zip-validation-core";

interface ZipValidationWorkerRequest {
  type: "validate";
  id: string;
  bytes: ArrayBuffer;
  entries: ZipStreamEntryInfo[];
  limits: ZipExpansionLimits;
  timeoutMs: number;
}

type ZipValidationWorkerResponse =
  | { type: "success"; id: string; bytes: ArrayBuffer }
  | { type: "error"; id: string; code: ResourceErrorCode; message: string };

function isRequest(value: unknown): value is ZipValidationWorkerRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ZipValidationWorkerRequest>;
  return candidate.type === "validate"
    && typeof candidate.id === "string"
    && candidate.id.length > 0
    && candidate.id.length <= 200
    && candidate.bytes instanceof ArrayBuffer
    && Array.isArray(candidate.entries)
    && Boolean(candidate.limits)
    && typeof candidate.timeoutMs === "number"
    && Number.isFinite(candidate.timeoutMs)
    && candidate.timeoutMs > 0;
}

function safeFailure(error: unknown): { code: ResourceErrorCode; message: string } {
  if (error instanceof ResourceError) {
    return { code: error.code, message: error.message.slice(0, 1_000) };
  }
  return { code: "unsafe_archive", message: "The ZIP archive could not be validated safely." };
}

self.onmessage = (event: MessageEvent<unknown>) => {
  if (!isRequest(event.data)) {
    self.postMessage({
      type: "error",
      id: "invalid-request",
      code: "unsafe_archive",
      message: "The ZIP validator received an invalid request.",
    } satisfies ZipValidationWorkerResponse);
    return;
  }

  const request = event.data;
  try {
    validateZipEntryStreams(
      new Uint8Array(request.bytes),
      request.entries,
      request.limits,
      { deadline: performance.now() + request.timeoutMs },
    );
    self.postMessage({
      type: "success",
      id: request.id,
      bytes: request.bytes,
    } satisfies ZipValidationWorkerResponse, [request.bytes]);
  } catch (error) {
    const failure = safeFailure(error);
    self.postMessage({
      type: "error",
      id: request.id,
      ...failure,
    } satisfies ZipValidationWorkerResponse);
  }
};
