import { Readability } from "@mozilla/readability";
import DOMPurify from "dompurify";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { fetchProviderResponse, readBoundedResponseText } from "./http";
import { ContentProviderError, asSafeProviderFailure } from "./provider-error";
import { parsePublicHttpUrl } from "./public-url";
import type { ExtensionFetchFactory, WebPageContent } from "./types";

const DEFAULT_MAX_CHARACTERS = 200_000;
const ALLOWED_PAGE_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "text/plain",
]);
const LOGIN_COPY = [
  /\bsign in to (?:continue|view|read|access)\b/,
  /\blog in to (?:continue|view|read|access)\b/,
  /\bplease (?:sign|log) in\b/,
] as const;
const PAYWALL_COPY = [
  /\bsubscribe to (?:continue|read|unlock|view)\b/,
  /\bsubscription required\b/,
  /\bthis (?:article|content) is (?:only )?for subscribers\b/,
  /\bunlock (?:this|the) (?:article|story|content)\b/,
] as const;
const BLOCKED_COPY = [
  /\baccess denied\b/,
  /\bverify you are human\b/,
  /\bcomplete the security check\b/,
  /\benable javascript and cookies to continue\b/,
] as const;

export interface ExtensionReaderProviderOptions {
  transport: "direct" | "extension";
  extensionFetchFactory?: ExtensionFetchFactory;
  maxCharacters?: number;
}

export interface ExtensionReaderProvider {
  readonly id: "extension-reader";
  read(url: string, signal?: AbortSignal): Promise<WebPageContent>;
}

function normalizedText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasPhrase(text: string, phrases: readonly RegExp[]): boolean {
  return phrases.some((phrase) => phrase.test(text));
}

function assertPublicReadableDocument(document: Document, source: URL): void {
  const text = normalizedText(document.body?.textContent ?? "").slice(0, 50_000).toLowerCase();
  const loginPath = /\/(?:login|log-in|signin|sign-in|auth)(?:\/|$)/i.test(source.pathname);
  const passwordForm = Boolean(document.querySelector('input[type="password"], form[action*="login" i], form[action*="signin" i]'));
  const loginCopy = hasPhrase(text, LOGIN_COPY);
  if (loginPath || passwordForm || loginCopy) {
    throw new ContentProviderError(
      "extension-reader",
      "authentication-required",
      "This page requires authentication and cannot be read through the extension.",
    );
  }

  const paywallElement = Boolean(document.querySelector(
    '[class*="paywall" i], [id*="paywall" i], [data-paywall], [class*="subscription-wall" i]',
  ));
  const paywallCopy = hasPhrase(text, PAYWALL_COPY);
  if (paywallElement || paywallCopy) {
    throw new ContentProviderError("extension-reader", "paywall", "This content is behind a paywall.");
  }

  const blockedCopy = hasPhrase(text, BLOCKED_COPY);
  if (blockedCopy || document.querySelector('[id*="captcha" i], [class*="captcha" i]')) {
    throw new ContentProviderError(
      "extension-reader",
      "content-blocked",
      "The page blocked automated reading or requires an interactive challenge.",
    );
  }
}

function assertPublicReadableText(text: string, source: URL): void {
  const sample = normalizedText(text).slice(0, 50_000).toLowerCase();
  if (/\/(?:login|log-in|signin|sign-in|auth)(?:\/|$)/i.test(source.pathname) || hasPhrase(sample, LOGIN_COPY)) {
    throw new ContentProviderError(
      "extension-reader",
      "authentication-required",
      "This page requires authentication and cannot be read through the extension.",
    );
  }
  if (hasPhrase(sample, PAYWALL_COPY)) {
    throw new ContentProviderError("extension-reader", "paywall", "This content is behind a paywall.");
  }
  if (hasPhrase(sample, BLOCKED_COPY)) {
    throw new ContentProviderError(
      "extension-reader",
      "content-blocked",
      "The page blocked automated reading or requires an interactive challenge.",
    );
  }
}

function extractHtmlDocument(html: string, source: URL, maxCharacters: number): { title?: string; text: string } {
  const untrustedDocument = new DOMParser().parseFromString(html, "text/html");
  assertPublicReadableDocument(untrustedDocument, source);
  const sourceTitle = untrustedDocument.title;
  const sanitizedHtml = String(DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "embed"],
    FORBID_ATTR: [
      "action",
      "background",
      "cite",
      "data",
      "formaction",
      "href",
      "poster",
      "src",
      "srcdoc",
      "srcset",
      "style",
      "xlink:href",
    ],
  }));
  const document = new DOMParser().parseFromString(sanitizedHtml, "text/html");

  let readable: ReturnType<Readability["parse"]>;
  try {
    readable = new Readability(document.cloneNode(true) as Document, {
      charThreshold: 80,
      keepClasses: false,
    }).parse();
  } catch {
    throw new ContentProviderError(
      "extension-reader",
      "invalid-response",
      "The extension could not parse this page.",
    );
  }
  const fallbackDocument = document.cloneNode(true) as Document;
  fallbackDocument.querySelectorAll(
    "script, style, noscript, template, svg, canvas, nav, header, footer, aside, form, dialog",
  ).forEach((element) => element.remove());
  const fallback = fallbackDocument.querySelector("main, article")?.textContent
    ?? fallbackDocument.body?.textContent
    ?? "";
  const text = normalizedText(readable?.textContent || fallback).slice(0, maxCharacters);
  if (!text) {
    throw new ContentProviderError(
      "extension-reader",
      "invalid-response",
      "The extension could not extract readable text from this page.",
    );
  }
  const title = normalizedText(readable?.title || document.title || sourceTitle || "").slice(0, 2_000);
  return { title: title || undefined, text };
}

function validatedMaxCharacters(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_CHARACTERS;
  if (!Number.isInteger(result) || result < 1_000 || result > 500_000) {
    throw new RangeError("Extension reader maxCharacters must be between 1000 and 500000.");
  }
  return result;
}

export function createExtensionReaderProvider(options: ExtensionReaderProviderOptions): ExtensionReaderProvider {
  if (options.transport !== "extension") {
    throw new ContentProviderError(
      "extension-reader",
      "transport-mismatch",
      "Extension reader requires the companion extension transport.",
    );
  }
  const maxCharacters = validatedMaxCharacters(options.maxCharacters);
  const extensionFetchFactory = options.extensionFetchFactory ?? createExtensionFetch;

  return {
    id: "extension-reader",
    async read(value, signal) {
      const source = parsePublicHttpUrl(value, "extension-reader");
      let fetcher: typeof fetch;
      try {
        fetcher = extensionFetchFactory({
          operation: "read-page",
          provider: "extension-reader",
          baseUrl: source.toString(),
        });
      } catch (error) {
        throw asSafeProviderFailure("extension-reader", error, signal);
      }
      const response = await fetchProviderResponse("extension-reader", fetcher, source, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }, signal);
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType && !ALLOWED_PAGE_MEDIA_TYPES.has(mediaType)) {
        throw new ContentProviderError(
          "extension-reader",
          "invalid-response",
          "Extension reader only supports HTML and plain-text pages.",
        );
      }
      const body = await readBoundedResponseText("extension-reader", response, signal);
      if (mediaType === "text/plain") {
        assertPublicReadableText(body, source);
        const text = normalizedText(body).slice(0, maxCharacters);
        if (!text) {
          throw new ContentProviderError(
            "extension-reader",
            "invalid-response",
            "The extension returned an empty page.",
          );
        }
        return {
          provider: "extension-reader",
          sourceUrl: source.toString(),
          resolvedUrl: source.toString(),
          text,
          mediaType: "text/plain",
        };
      }
      const extracted = extractHtmlDocument(body, source, maxCharacters);
      return {
        provider: "extension-reader",
        sourceUrl: source.toString(),
        resolvedUrl: source.toString(),
        ...extracted,
        mediaType: "text/plain",
      };
    },
  };
}
