import {
  ContentProviderError,
  abortedProviderRequest,
  asSafeProviderFailure,
  mapProviderHttpError,
  throwIfProviderRequestAborted,
  type ContentProviderId,
} from "./provider-error";

export const MAX_PROVIDER_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function fetchProviderResponse(
  provider: ContentProviderId,
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  throwIfProviderRequestAborted(signal);
  try {
    const response = await fetcher(input, { ...init, signal });
    if (!response.ok) throw mapProviderHttpError(provider, response.status);
    return response;
  } catch (error) {
    throw asSafeProviderFailure(provider, error, signal);
  }
}

export async function readBoundedResponseText(
  provider: ContentProviderId,
  response: Response,
  signal?: AbortSignal,
  maxBytes = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new ContentProviderError(provider, "response-too-large", "The provider response is too large.");
  }
  throwIfProviderRequestAborted(signal);
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      throwIfProviderRequestAborted(signal);
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ContentProviderError(provider, "response-too-large", "The provider response is too large.");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch (error) {
    if (signal?.aborted) throw abortedProviderRequest();
    if (error instanceof ContentProviderError) throw error;
    throw new ContentProviderError(provider, "invalid-response", "The provider returned invalid UTF-8 content.");
  } finally {
    reader.releaseLock();
  }
}

export async function readBoundedJson(
  provider: ContentProviderId,
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await readBoundedResponseText(provider, response, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContentProviderError(provider, "invalid-response", "The provider returned invalid JSON.");
  }
}
