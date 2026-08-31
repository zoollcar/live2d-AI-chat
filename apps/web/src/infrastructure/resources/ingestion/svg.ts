import DOMPurify from "dompurify";
import { ResourceError } from "../errors";
import { RESOURCE_LIMITS } from "../limits";
import type { ValidatedResourceFile } from "../validation";
import { sha256 } from "../hash";
import { finalizeResourceBundle } from "./finalize";
import type { ResourceIngestionOptions } from "./types";

const forbiddenSvgTags = [
  "script",
  "style",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "audio",
  "video",
  "image",
  "use",
  "a",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "filter",
];

const allowedSvgTags = [
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
];

const allowedSvgAttributes = [
  "xmlns",
  "viewBox",
  "width",
  "height",
  "preserveAspectRatio",
  "id",
  "role",
  "aria-label",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "clip-path",
  "clip-rule",
  "opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "dx",
  "dy",
  "gradientUnits",
  "gradientTransform",
  "offset",
  "stop-color",
  "stop-opacity",
];

const forbiddenUrl = /(?:javascript:|data:|https?:|file:|blob:|\/\/)/i;
const svgPathCommand = /[MmZzLlHhVvCcSsQqTtAa]/g;
const svgPathNumber = /[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi;

export interface SvgSanitizationOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function safetyCheckpoint(
  startedAt: number,
  timeoutMs: number,
  signal?: AbortSignal,
): void {
  signal?.throwIfAborted();
  if (monotonicNow() - startedAt >= timeoutMs) {
    throw new ResourceError("unsafe_svg", "SVG safety processing timed out.");
  }
}

function parseSvgDocument(source: string): XMLDocument {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  if (document.querySelector("parsererror") || document.documentElement.localName !== "svg") {
    throw new ResourceError("invalid_file", "The SVG document is malformed.");
  }
  return document;
}

function assertSvgComplexity(
  root: Element,
  checkpoint: () => void,
): void {
  const pending: Array<{ element: Element; depth: number }> = [{ element: root, depth: 1 }];
  let nodeCount = 0;
  let attributeCount = 0;
  while (pending.length > 0) {
    checkpoint();
    const current = pending.pop()!;
    nodeCount += 1;
    if (nodeCount > RESOURCE_LIMITS.maxSvgNodes) {
      throw new ResourceError("unsafe_svg", `The SVG contains more than ${RESOURCE_LIMITS.maxSvgNodes} elements.`);
    }
    if (current.depth > RESOURCE_LIMITS.maxSvgDepth) {
      throw new ResourceError("unsafe_svg", `The SVG is nested more than ${RESOURCE_LIMITS.maxSvgDepth} levels deep.`);
    }
    const attributes = [...current.element.attributes];
    if (attributes.length > RESOURCE_LIMITS.maxSvgAttributesPerElement) {
      throw new ResourceError("unsafe_svg", "An SVG element contains too many attributes.");
    }
    attributeCount += attributes.length;
    if (attributeCount > RESOURCE_LIMITS.maxSvgTotalAttributes) {
      throw new ResourceError("unsafe_svg", "The SVG contains too many attributes.");
    }
    for (const attribute of attributes) {
      if (attribute.name.length > RESOURCE_LIMITS.maxSvgAttributeNameChars) {
        throw new ResourceError("unsafe_svg", "An SVG attribute name is too long.");
      }
      const isPathData = current.element.localName === "path" && attribute.name.toLowerCase() === "d";
      const maxChars = isPathData
        ? RESOURCE_LIMITS.maxSvgPathDataChars
        : RESOURCE_LIMITS.maxSvgAttributeChars;
      if (attribute.value.length > maxChars) {
        throw new ResourceError("unsafe_svg", `SVG attribute '${attribute.name}' is too long.`);
      }
      if (isPathData) {
        const commandCount = attribute.value.match(svgPathCommand)?.length ?? 0;
        const numberCount = attribute.value.match(svgPathNumber)?.length ?? 0;
        if (commandCount > RESOURCE_LIMITS.maxSvgPathCommands
          || numberCount > RESOURCE_LIMITS.maxSvgPathNumbers) {
          throw new ResourceError("unsafe_svg", "An SVG path is too complex to render safely.");
        }
      }
    }
    for (const child of [...current.element.children]) {
      pending.push({ element: child, depth: current.depth + 1 });
    }
  }
}

function numericDimension(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/i);
  if (!match) throw new ResourceError("unsafe_svg", "SVG dimensions must use bounded pixel values.");
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ResourceError("unsafe_svg", "SVG dimensions must be positive finite values.");
  }
  return parsed;
}

function viewBoxDimensions(value: string | null): { width: number; height: number } | undefined {
  if (!value) return undefined;
  const values = value.trim().split(/[\s,]+/).map(Number);
  if (values.length !== 4 || values.some((part) => !Number.isFinite(part))) {
    throw new ResourceError("unsafe_svg", "The SVG viewBox is invalid.");
  }
  const width = values[2];
  const height = values[3];
  if (width <= 0 || height <= 0) {
    throw new ResourceError("unsafe_svg", "The SVG viewBox must have positive dimensions.");
  }
  return { width, height };
}

export function sanitizeSvgText(
  svg: string,
  options: SvgSanitizationOptions = {},
): { svg: string; text: string; width?: number; height?: number } {
  const maxBytes = Math.min(options.maxBytes ?? RESOURCE_LIMITS.svgBytes, RESOURCE_LIMITS.svgBytes);
  const timeoutMs = Math.min(
    options.timeoutMs ?? RESOURCE_LIMITS.svgProcessingTimeoutMs,
    RESOURCE_LIMITS.svgProcessingTimeoutMs,
  );
  const startedAt = monotonicNow();
  const checkpoint = () => safetyCheckpoint(startedAt, timeoutMs, options.signal);
  checkpoint();
  if (new TextEncoder().encode(svg).byteLength > maxBytes) {
    throw new ResourceError("file_too_large", `The SVG exceeds the ${Math.floor(maxBytes / 1024)} KiB limit.`);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) {
    throw new ResourceError("unsafe_svg", "SVG document type and entity declarations are not allowed.");
  }
  if (typeof DOMParser === "undefined" || typeof XMLSerializer === "undefined") {
    throw new ResourceError("unsafe_svg", "This browser cannot safely parse SVG files.");
  }
  const sourceDocument = parseSvgDocument(svg);
  assertSvgComplexity(sourceDocument.documentElement, checkpoint);
  checkpoint();
  const sanitized = String(DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: false },
    ALLOWED_TAGS: allowedSvgTags,
    ALLOWED_ATTR: allowedSvgAttributes,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: forbiddenSvgTags,
    FORBID_ATTR: ["style", "href", "xlink:href"],
  }));
  checkpoint();
  const document = parseSvgDocument(sanitized);
  assertSvgComplexity(document.documentElement, checkpoint);
  const elements = [document.documentElement, ...document.documentElement.querySelectorAll("*")];
  for (const element of elements) {
    checkpoint();
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "style" || name === "href" || name === "xlink:href") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      if (forbiddenUrl.test(value) || (/url\(/i.test(value) && !/^url\(\s*#[^)]+\s*\)$/i.test(value))) {
        throw new ResourceError("unsafe_svg", `SVG attribute '${attribute.name}' contains an external resource.`);
      }
    }
  }
  const viewBox = viewBoxDimensions(document.documentElement.getAttribute("viewBox"));
  const width = numericDimension(document.documentElement.getAttribute("width")) ?? viewBox?.width;
  const height = numericDimension(document.documentElement.getAttribute("height")) ?? viewBox?.height;
  if ((width !== undefined && width > RESOURCE_LIMITS.maxSvgDimension)
    || (height !== undefined && height > RESOURCE_LIMITS.maxSvgDimension)) {
    throw new ResourceError("unsafe_svg", "The SVG dimensions exceed the safe rendering limit.");
  }
  const serialized = new XMLSerializer().serializeToString(document.documentElement);
  checkpoint();
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new ResourceError("file_too_large", "The sanitized SVG exceeds its storage limit.");
  }
  return {
    svg: serialized,
    text: document.documentElement.textContent?.replace(/\s+/g, " ").trim() ?? "",
    width,
    height,
  };
}

export async function ingestSvgResource(
  file: ValidatedResourceFile,
  options: ResourceIngestionOptions,
) {
  const maxBytes = options.origin === "generated"
    ? RESOURCE_LIMITS.generatedSvgBytes
    : RESOURCE_LIMITS.svgBytes;
  if (file.bytes.byteLength > maxBytes || file.file.size > maxBytes) {
    throw new ResourceError("file_too_large", `The SVG exceeds the ${Math.floor(maxBytes / 1024)} KiB limit.`);
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes).replace(/^\uFEFF/, "");
  } catch (error) {
    throw new ResourceError("invalid_file", "SVG files must use valid UTF-8 encoding.", { cause: error });
  }
  const sanitized = sanitizeSvgText(source, {
    maxBytes,
    signal: options.signal,
  });
  const blob = new Blob([sanitized.svg], { type: "image/svg+xml" });
  const originalSha256 = await sha256(file.bytes);
  return finalizeResourceBundle({
    file,
    blob,
    originalSha256,
    options,
    kind: "svg",
    // The sanitized SVG is persisted only as the owned source blob. Tool
    // output receives inert visible text, never complete XML markup.
    sections: sanitized.text ? [{ text: sanitized.text }] : [],
    metadata: {
      ...(sanitized.width === undefined ? {} : { width: Math.ceil(sanitized.width) }),
      ...(sanitized.height === undefined ? {} : { height: Math.ceil(sanitized.height) }),
    },
  });
}
