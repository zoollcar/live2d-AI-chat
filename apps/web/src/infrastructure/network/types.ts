import type { RemoteTransport } from "@live2d-chat/shared";
import type { ExtensionFetchOptions } from "@/infrastructure/extension/bridge-client";

export type ExtensionFetchFactory = (options: ExtensionFetchOptions) => typeof fetch;

export interface ProviderTransportOptions {
  transport: RemoteTransport;
  apiKey: string;
  directFetch?: typeof fetch;
  extensionFetchFactory?: ExtensionFetchFactory;
}

export interface WebPageContent {
  provider: "exa" | "extension-reader";
  sourceUrl: string;
  resolvedUrl: string;
  title?: string;
  text: string;
  mediaType: "text/markdown" | "text/plain";
  author?: string;
  publishedAt?: string;
}

export interface TranscriptCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
  language?: string;
}

export interface VideoTranscriptContent {
  status: "ready";
  provider: "supadata";
  sourceUrl: string;
  language?: string;
  availableLanguages: string[];
  cues: TranscriptCue[];
  text: string;
  jobId?: string;
}

export interface VideoTranscriptPending {
  status: "processing";
  provider: "supadata";
  sourceUrl: string;
  language?: string;
  jobId: string;
}

export type VideoTranscriptResult = VideoTranscriptContent | VideoTranscriptPending;
