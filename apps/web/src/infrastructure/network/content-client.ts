import type { ContentProviderSettings } from "@live2d-chat/shared";
import { createExaContentsProvider } from "./exa-contents";
import { createExtensionReaderProvider } from "./extension-reader";
import {
  createSupadataTranscriptProvider,
  type SupadataTranscriptJobRequest,
  type SupadataTranscriptRequest,
} from "./supadata-transcript";
import type { ExtensionFetchFactory, VideoTranscriptResult, WebPageContent } from "./types";

export interface ContentNetworkClientOptions {
  directFetch?: typeof fetch;
  extensionFetchFactory?: ExtensionFetchFactory;
  exaMaxCharacters?: number;
  extensionReaderMaxCharacters?: number;
  transcriptTimeoutMs?: number;
  transcriptPollIntervalMs?: number;
  transcriptSleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface ContentNetworkClient {
  readWebPage(url: string, signal?: AbortSignal): Promise<WebPageContent>;
  readVideoTranscript(input: SupadataTranscriptRequest, signal?: AbortSignal): Promise<VideoTranscriptResult>;
  pollVideoTranscriptJob(input: SupadataTranscriptJobRequest, signal?: AbortSignal): Promise<VideoTranscriptResult>;
}

export function createContentNetworkClient(
  settings: ContentProviderSettings,
  options: ContentNetworkClientOptions = {},
): ContentNetworkClient {
  return {
    async readWebPage(url, signal) {
      switch (settings.webProvider) {
        case "exa":
          return await createExaContentsProvider({
            transport: settings.webTransport,
            apiKey: settings.exa.apiKey,
            directFetch: options.directFetch,
            extensionFetchFactory: options.extensionFetchFactory,
            maxCharacters: options.exaMaxCharacters,
          }).read(url, signal);
        case "extension-reader":
          return await createExtensionReaderProvider({
            transport: settings.webTransport,
            extensionFetchFactory: options.extensionFetchFactory,
            maxCharacters: options.extensionReaderMaxCharacters,
          }).read(url, signal);
      }
    },
    async readVideoTranscript(input, signal) {
      switch (settings.videoTranscriptProvider) {
        case "supadata":
          return await createSupadataTranscriptProvider({
            transport: settings.videoTransport,
            apiKey: settings.supadata.apiKey,
            directFetch: options.directFetch,
            extensionFetchFactory: options.extensionFetchFactory,
            timeoutMs: options.transcriptTimeoutMs,
            pollIntervalMs: options.transcriptPollIntervalMs,
            sleep: options.transcriptSleep,
          }).read(input, signal);
      }
    },
    async pollVideoTranscriptJob(input, signal) {
      switch (settings.videoTranscriptProvider) {
        case "supadata":
          return await createSupadataTranscriptProvider({
            transport: settings.videoTransport,
            apiKey: settings.supadata.apiKey,
            directFetch: options.directFetch,
            extensionFetchFactory: options.extensionFetchFactory,
            timeoutMs: options.transcriptTimeoutMs,
            pollIntervalMs: options.transcriptPollIntervalMs,
            sleep: options.transcriptSleep,
          }).poll(input, signal);
      }
    },
  };
}
