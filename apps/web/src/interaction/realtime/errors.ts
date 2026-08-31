export type GoogleLiveErrorCode =
  | "INVALID_CONFIG"
  | "AUTHENTICATION_FAILED"
  | "QUOTA_EXCEEDED"
  | "MODEL_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "NOT_CONNECTED"
  | "CONNECTION_FAILED"
  | "CONNECTION_CLOSED"
  | "PROTOCOL_ERROR"
  | "SEND_FAILED"
  | "DISPOSED";

export class GoogleLiveSessionError extends Error {
  readonly code: GoogleLiveErrorCode;
  readonly retryable: boolean;

  constructor(
    code: GoogleLiveErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GoogleLiveSessionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export class GoogleLiveProtocolError extends GoogleLiveSessionError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super("PROTOCOL_ERROR", message, options);
    this.name = "GoogleLiveProtocolError";
  }
}

export function redactGoogleLiveCredentials(text: string, apiKey?: string): string {
  let redacted = text;
  if (apiKey) {
    redacted = redacted.split(apiKey).join("[REDACTED]");
    const encoded = encodeURIComponent(apiKey);
    redacted = redacted.split(encoded).join("[REDACTED]");
  }
  return redacted
    .replace(/([?&](?:key|access_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/auth_tokens\/[A-Za-z0-9._~-]+/g, "auth_tokens/[REDACTED]");
}

export function asGoogleLiveSessionError(
  error: unknown,
  code: GoogleLiveErrorCode,
  fallbackMessage: string,
  apiKey?: string,
  retryable = false,
): GoogleLiveSessionError {
  if (error instanceof GoogleLiveSessionError) {
    return new GoogleLiveSessionError(
      error.code,
      redactGoogleLiveCredentials(error.message, apiKey),
      { retryable: error.retryable },
    );
  }
  const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
  return new GoogleLiveSessionError(
    code,
    redactGoogleLiveCredentials(`${fallbackMessage}${detail}`, apiKey),
    // Do not retain the original error as `cause`: browser WebSocket
    // implementations and injected transports may include the authenticated
    // URL in it, defeating credential redaction on structured logs.
    { retryable },
  );
}
