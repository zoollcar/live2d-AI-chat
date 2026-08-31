import { isDirectCorsGuidanceError } from "./direct-fetch";

export type ContentProviderId = "exa" | "extension-reader" | "supadata";

export type ContentProviderErrorCode =
  | "invalid-url"
  | "private-target"
  | "missing-credential"
  | "transport-mismatch"
  | "invalid-request"
  | "authentication-required"
  | "paywall"
  | "access-denied"
  | "not-found"
  | "rate-limited"
  | "response-too-large"
  | "invalid-response"
  | "content-blocked"
  | "provider-unavailable"
  | "timeout";

export class ContentProviderError extends Error {
  readonly code: ContentProviderErrorCode;
  readonly provider: ContentProviderId;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    provider: ContentProviderId,
    code: ContentProviderErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number } = {},
  ) {
    super(message);
    this.name = "ContentProviderError";
    this.provider = provider;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export function abortedProviderRequest(): DOMException {
  return new DOMException("The content request was cancelled.", "AbortError");
}

export function throwIfProviderRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedProviderRequest();
}

export function mapProviderHttpError(
  provider: ContentProviderId,
  status: number,
): ContentProviderError {
  if (status === 400 || status === 422) {
    return new ContentProviderError(provider, "invalid-request", "The content provider rejected the request.", { status });
  }
  if (status === 401 || status === 407) {
    return new ContentProviderError(
      provider,
      "authentication-required",
      provider === "extension-reader"
        ? "This page requires authentication and cannot be read through the extension."
        : `The ${provider} credential is missing or invalid.`,
      { status },
    );
  }
  if (status === 402) {
    return provider === "extension-reader"
      ? new ContentProviderError(provider, "paywall", "This content is behind a paywall.", { status })
      : new ContentProviderError(
          provider,
          "provider-unavailable",
          `The ${provider} account cannot process this request. Check its billing or usage limit.`,
          { status },
        );
  }
  if (status === 403) {
    return new ContentProviderError(
      provider,
      "access-denied",
      provider === "extension-reader"
        ? "This page is private, restricted, or requires a login."
        : "The content provider could not access this source.",
      { status },
    );
  }
  if (status === 404 || status === 410) {
    return new ContentProviderError(provider, "not-found", "The requested content was not found or is private.", { status });
  }
  if (status === 408 || status === 504) {
    return new ContentProviderError(provider, "timeout", "The content provider timed out.", {
      retryable: true,
      status,
    });
  }
  if (status === 429) {
    return new ContentProviderError(provider, "rate-limited", "The content provider rate limit was reached.", {
      retryable: true,
      status,
    });
  }
  return new ContentProviderError(provider, "provider-unavailable", "The content provider request failed.", {
    retryable: status >= 500,
    status,
  });
}

export function asSafeProviderFailure(
  provider: ContentProviderId,
  error: unknown,
  signal?: AbortSignal,
): Error {
  if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
    return abortedProviderRequest();
  }
  if (isDirectCorsGuidanceError(error)) return error;
  if (error instanceof ContentProviderError) return error;
  return new ContentProviderError(
    provider,
    "provider-unavailable",
    `The ${provider} request could not be completed.`,
    { retryable: true },
  );
}
