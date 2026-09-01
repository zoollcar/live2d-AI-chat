import { z } from "zod";
import { directCorsAwareFetch } from "./direct-fetch";
import { fetchProviderResponse, readBoundedJson } from "./http";
import { ContentProviderError, mapProviderHttpError } from "./provider-error";
import { parsePublicHttpUrl } from "./public-url";
import type { DirectProviderOptions, WebPageContent } from "./types";

const EXA_CONTENTS_URL = "https://api.exa.ai/contents";
const DEFAULT_MAX_CHARACTERS = 200_000;

const exaResultSchema = z.object({
  title: z.string().max(2_000).nullish(),
  url: z.string().max(4_000),
  text: z.string().max(500_000).optional(),
  author: z.string().max(2_000).nullish(),
  publishedDate: z.string().max(200).nullish(),
}).loose();

const exaStatusSchema = z.object({
  id: z.string().max(4_000),
  status: z.enum(["success", "error"]),
  error: z.object({
    tag: z.string().max(200).optional(),
    httpStatusCode: z.number().int().min(100).max(599).nullish(),
  }).loose().optional(),
}).loose();

const exaContentsResponseSchema = z.object({
  results: z.array(exaResultSchema).max(10),
  statuses: z.array(exaStatusSchema).max(10).optional(),
}).loose();

export interface ExaContentsProviderOptions extends DirectProviderOptions {
  maxCharacters?: number;
}

export interface ExaContentsProvider {
  readonly id: "exa";
  read(url: string, signal?: AbortSignal): Promise<WebPageContent>;
}

function mapExaCrawlFailure(status: z.infer<typeof exaStatusSchema>): ContentProviderError {
  const upstreamStatus = status.error?.httpStatusCode ?? undefined;
  if (upstreamStatus) return mapProviderHttpError("exa", upstreamStatus);
  if (status.error?.tag === "UNSUPPORTED_URL") {
    return new ContentProviderError("exa", "invalid-url", "Exa does not support this source URL.");
  }
  if (status.error?.tag === "CRAWL_TIMEOUT" || status.error?.tag === "CRAWL_LIVECRAWL_TIMEOUT") {
    return new ContentProviderError("exa", "timeout", "Exa timed out while reading this source.", { retryable: true });
  }
  if (status.error?.tag === "SOURCE_NOT_AVAILABLE") {
    return new ContentProviderError("exa", "access-denied", "Exa could not access this private or restricted source.");
  }
  if (status.error?.tag === "CRAWL_NOT_FOUND") {
    return new ContentProviderError("exa", "not-found", "Exa could not find this source.");
  }
  return new ContentProviderError("exa", "provider-unavailable", "Exa could not read this source.", {
    retryable: true,
  });
}

function validatedMaxCharacters(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_CHARACTERS;
  if (!Number.isInteger(result) || result < 1_000 || result > 500_000) {
    throw new RangeError("Exa maxCharacters must be between 1000 and 500000.");
  }
  return result;
}

export function createExaContentsProvider(options: ExaContentsProviderOptions): ExaContentsProvider {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ContentProviderError("exa", "missing-credential", "Enter an Exa API key before reading web pages.");
  }
  const maxCharacters = validatedMaxCharacters(options.maxCharacters);
  const fetcher = options.directFetch ?? directCorsAwareFetch;

  return {
    id: "exa",
    async read(value, signal) {
      const source = parsePublicHttpUrl(value, "exa");
      const requestBody = {
        urls: [source.toString()],
        text: {
          maxCharacters,
          includeHtmlTags: false,
          verbosity: "standard",
          excludeSections: ["navigation", "banner", "sidebar", "footer"],
        },
        maxAgeHours: 24,
        livecrawlTimeout: 12_000,
      };
      const response = await fetchProviderResponse("exa", fetcher, EXA_CONTENTS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify(requestBody),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }, signal);
      const raw = await readBoundedJson("exa", response, signal);
      const parsed = exaContentsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ContentProviderError("exa", "invalid-response", "Exa returned an invalid Contents response.");
      }

      const failedStatus = parsed.data.statuses?.find((status) => status.status === "error");
      if (failedStatus) throw mapExaCrawlFailure(failedStatus);
      const result = parsed.data.results[0];
      const text = result?.text?.trim();
      if (!result || !text) {
        throw new ContentProviderError("exa", "invalid-response", "Exa returned no readable content for this source.");
      }
      const resolved = parsePublicHttpUrl(result.url, "exa");
      return {
        provider: "exa",
        sourceUrl: source.toString(),
        resolvedUrl: resolved.toString(),
        title: result.title?.trim() || undefined,
        text: text.slice(0, maxCharacters),
        mediaType: "text/markdown",
        author: result.author?.trim() || undefined,
        publishedAt: result.publishedDate?.trim() || undefined,
      };
    },
  };
}
