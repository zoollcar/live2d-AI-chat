import { z } from "zod";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { directCorsAwareFetch } from "./direct-fetch";
import { fetchProviderResponse, readBoundedJson } from "./http";
import {
  ContentProviderError,
  abortedProviderRequest,
  asSafeProviderFailure,
  throwIfProviderRequestAborted,
} from "./provider-error";
import { parsePublicHttpUrl } from "./public-url";
import type {
  ProviderTransportOptions,
  VideoTranscriptContent,
  VideoTranscriptPending,
  VideoTranscriptResult,
} from "./types";

const SUPADATA_TRANSCRIPT_URL = "https://api.supadata.ai/v1/transcript";
const MAX_TRANSCRIPT_WAIT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const transcriptCueSchema = z.object({
  text: z.string().max(50_000),
  offset: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  duration: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lang: z.string().max(35).optional(),
}).loose();

const transcriptResultSchema = z.object({
  content: z.array(transcriptCueSchema).min(1).max(100_000),
  lang: z.string().max(35).optional(),
  availableLangs: z.array(z.string().max(35)).max(200).optional(),
}).loose();

const transcriptJobSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
}).loose();

const transcriptJobResultSchema = z.object({
  status: z.enum(["queued", "active", "completed", "failed"]),
  error: z.object({
    error: z.string().max(200).optional(),
  }).loose().nullish(),
  content: z.array(transcriptCueSchema).min(1).max(100_000).optional(),
  lang: z.string().max(35).optional(),
  availableLangs: z.array(z.string().max(35)).max(200).optional(),
}).loose();

export type SupadataTranscriptMode = "native" | "auto" | "generate";

export interface SupadataTranscriptProviderOptions extends ProviderTransportOptions {
  mode?: SupadataTranscriptMode;
  chunkSize?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface SupadataTranscriptRequest {
  url: string;
  language?: string;
}

export interface SupadataTranscriptJobRequest {
  jobId: string;
  sourceUrl: string;
  language?: string;
}

export interface SupadataTranscriptProvider {
  readonly id: "supadata";
  read(input: SupadataTranscriptRequest, signal?: AbortSignal): Promise<VideoTranscriptResult>;
  poll(input: SupadataTranscriptJobRequest, signal?: AbortSignal): Promise<VideoTranscriptResult>;
}

interface Deadline {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function createDeadline(parent: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController();
  let timeoutReached = false;
  const onParentAbort = () => controller.abort();
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted) controller.abort();
  const timer = globalThis.setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose() {
      globalThis.clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfProviderRequestAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(abortedProviderRequest());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateOptions(options: SupadataTranscriptProviderOptions): {
  chunkSize: number;
  timeoutMs: number;
  pollIntervalMs: number;
} {
  const chunkSize = options.chunkSize ?? 1_000;
  if (!Number.isInteger(chunkSize) || chunkSize < 50 || chunkSize > 10_000) {
    throw new RangeError("Supadata chunkSize must be between 50 and 10000.");
  }
  const timeoutMs = options.timeoutMs ?? MAX_TRANSCRIPT_WAIT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TRANSCRIPT_WAIT_MS) {
    throw new RangeError("Supadata timeoutMs must be between 1 and 90000.");
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 10_000) {
    throw new RangeError("Supadata pollIntervalMs must be between 1 and 10000.");
  }
  return { chunkSize, timeoutMs, pollIntervalMs };
}

function validateLanguage(value: string | undefined): string | undefined {
  const language = value?.trim();
  if (!language) return undefined;
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language) || language.length > 35) {
    throw new ContentProviderError("supadata", "invalid-request", "The transcript language code is invalid.");
  }
  return language;
}

function completedTranscript(
  sourceUrl: string,
  result: z.infer<typeof transcriptResultSchema>,
  jobId?: string,
): VideoTranscriptContent {
  const cues = result.content
    .map((cue) => ({
      text: cue.text.trim(),
      startSeconds: cue.offset / 1_000,
      endSeconds: (cue.offset + cue.duration) / 1_000,
      language: cue.lang?.trim() || undefined,
    }))
    .filter((cue) => cue.text)
    .sort((left, right) => left.startSeconds - right.startSeconds);
  if (cues.length === 0) {
    throw new ContentProviderError("supadata", "invalid-response", "Supadata returned an empty transcript.");
  }
  return {
    status: "ready",
    provider: "supadata",
    sourceUrl,
    language: result.lang?.trim() || undefined,
    availableLanguages: [...new Set(result.availableLangs?.map((language) => language.trim()).filter(Boolean) ?? [])],
    cues,
    text: cues.map((cue) => cue.text).join("\n"),
    jobId,
  };
}

function pendingTranscript(
  sourceUrl: string,
  jobId: string,
  language: string | undefined,
): VideoTranscriptPending {
  return {
    status: "processing",
    provider: "supadata",
    sourceUrl,
    language,
    jobId,
  };
}

function failedJobError(errorCode: string | undefined): ContentProviderError {
  const code = errorCode?.toLowerCase() ?? "";
  if (code.includes("paywall") || code.includes("membership") || code.includes("subscriber")) {
    return new ContentProviderError("supadata", "paywall", "The video is behind a paywall.");
  }
  if (code.includes("auth") || code.includes("login") || code.includes("restricted") || code.includes("forbidden")) {
    return new ContentProviderError("supadata", "access-denied", "The video requires authentication or is restricted.");
  }
  if (code.includes("private") || code.includes("not-found") || code.includes("not_found")) {
    return new ContentProviderError("supadata", "not-found", "The video was not found or is private.");
  }
  return new ContentProviderError(
    "supadata",
    "provider-unavailable",
    "Supadata could not produce a transcript for this video.",
  );
}

export function createSupadataTranscriptProvider(
  options: SupadataTranscriptProviderOptions,
): SupadataTranscriptProvider {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ContentProviderError(
      "supadata",
      "missing-credential",
      "Enter a Supadata API key before reading video transcripts.",
    );
  }
  const { chunkSize, timeoutMs, pollIntervalMs } = validateOptions(options);
  const mode = options.mode ?? "auto";
  const sleep = options.sleep ?? defaultSleep;
  let extensionFetcher: typeof fetch | undefined;
  try {
    extensionFetcher = options.transport === "extension"
      ? (options.extensionFetchFactory ?? createExtensionFetch)({
          operation: "supadata",
          provider: "supadata",
          apiKey,
          mediaType: "application/json",
        })
      : undefined;
  } catch (error) {
    throw asSafeProviderFailure("supadata", error);
  }
  const directFetcher = options.directFetch ?? directCorsAwareFetch;

  const request = async (payload: { url: string; lang?: string; text: false; mode: SupadataTranscriptMode; chunkSize: number } | { jobId: string }, signal: AbortSignal) => {
    if (options.transport === "extension") {
      const response = await fetchProviderResponse("supadata", extensionFetcher!, SUPADATA_TRANSCRIPT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }, signal);
      return readBoundedJson("supadata", response, signal);
    }

    const target = new URL(SUPADATA_TRANSCRIPT_URL);
    if ("jobId" in payload) {
      target.pathname = `${target.pathname.replace(/\/+$/, "")}/${encodeURIComponent(payload.jobId)}`;
    } else {
      target.searchParams.set("url", payload.url);
      if (payload.lang) target.searchParams.set("lang", payload.lang);
      target.searchParams.set("text", "false");
      target.searchParams.set("mode", payload.mode);
      target.searchParams.set("chunkSize", String(payload.chunkSize));
    }
    const response = await fetchProviderResponse("supadata", directFetcher, target, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }, signal);
    return readBoundedJson("supadata", response, signal);
  };

  const pollJob = async (
    jobId: string,
    sourceUrl: string,
    language: string | undefined,
    deadline: Deadline,
    waitBeforeFirstPoll: boolean,
  ): Promise<VideoTranscriptContent> => {
    let shouldWait = waitBeforeFirstPoll;
    while (true) {
      if (shouldWait) await sleep(pollIntervalMs, deadline.signal);
      shouldWait = true;
      const rawStatus = await request({ jobId }, deadline.signal);
      const status = transcriptJobResultSchema.safeParse(rawStatus);
      if (!status.success) {
        throw new ContentProviderError("supadata", "invalid-response", "Supadata returned an invalid job response.");
      }
      if (status.data.status === "queued" || status.data.status === "active") continue;
      if (status.data.status === "failed") throw failedJobError(status.data.error?.error);
      const completed = transcriptResultSchema.safeParse(status.data);
      if (!completed.success) {
        throw new ContentProviderError("supadata", "invalid-response", "Supadata completed without a valid transcript.");
      }
      return completedTranscript(sourceUrl, completed.data, jobId);
    }
  };

  return {
    id: "supadata",
    async read(input, signal) {
      const source = parsePublicHttpUrl(input.url, "supadata");
      const language = validateLanguage(input.language);
      const deadline = createDeadline(signal, timeoutMs);
      let jobId: string | undefined;
      try {
        const initial = await request({
          url: source.toString(),
          lang: language,
          text: false,
          mode,
          chunkSize,
        }, deadline.signal);
        const immediate = transcriptResultSchema.safeParse(initial);
        if (immediate.success) return completedTranscript(source.toString(), immediate.data);
        const job = transcriptJobSchema.safeParse(initial);
        if (!job.success) {
          throw new ContentProviderError("supadata", "invalid-response", "Supadata returned an invalid transcript response.");
        }
        jobId = job.data.jobId;
        return await pollJob(jobId, source.toString(), language, deadline, true);
      } catch (error) {
        if (deadline.timedOut() && jobId) return pendingTranscript(source.toString(), jobId, language);
        if (deadline.timedOut()) {
          throw new ContentProviderError("supadata", "timeout", "Supadata transcript processing exceeded its deadline.", {
            retryable: true,
          });
        }
        throw asSafeProviderFailure("supadata", error, signal);
      } finally {
        deadline.dispose();
      }
    },
    async poll(input, signal) {
      const source = parsePublicHttpUrl(input.sourceUrl, "supadata");
      const language = validateLanguage(input.language);
      const job = transcriptJobSchema.safeParse({ jobId: input.jobId });
      if (!job.success) {
        throw new ContentProviderError("supadata", "invalid-request", "The Supadata transcript job ID is invalid.");
      }
      const deadline = createDeadline(signal, timeoutMs);
      try {
        return await pollJob(job.data.jobId, source.toString(), language, deadline, false);
      } catch (error) {
        if (deadline.timedOut()) return pendingTranscript(source.toString(), job.data.jobId, language);
        throw asSafeProviderFailure("supadata", error, signal);
      } finally {
        deadline.dispose();
      }
    },
  };
}

export { MAX_TRANSCRIPT_WAIT_MS };
