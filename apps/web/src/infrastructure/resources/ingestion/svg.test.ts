// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { RESOURCE_LIMITS } from "../limits";
import { validateResourceFile } from "../validation";
import { ingestSvgResource, sanitizeSvgText } from "./svg";

describe("sanitizeSvgText", () => {
  it("keeps inert drawing primitives", () => {
    const result = sanitizeSvgText(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="10" height="10"/><text>Hello</text></svg>',
    );
    expect(result.svg).toContain("<rect");
    expect(result.svg).toContain("Hello");
    expect(result).toMatchObject({ width: 640, height: 360 });
  });

  it("persists SVG markup only in the owned blob and exposes visible text to resource tools", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text>Hello</text></svg>';
    const file = new File([source], "drawing.svg", { type: "image/svg+xml" });
    const bundle = await ingestSvgResource(await validateResourceFile(file), {
      conversationId: "conversation-1",
    });

    expect(await bundle.blob.blob.text()).toContain("<svg");
    expect(bundle.chunks.map((chunk) => chunk.text)).toEqual(["Hello"]);
    expect(bundle.chunks.map((chunk) => chunk.text).join("\n")).not.toContain("<svg");
  });

  it("removes script-capable elements and event handlers", () => {
    const result = sanitizeSvgText(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onload="alert(2)"/></svg>',
    );
    expect(result.svg).not.toMatch(/script|onload|alert/i);
  });

  it.each([
    ["foreignObject", '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>'],
    ["external image", '<image href="https://evil.example/image.png"/>'],
    ["use", '<use href="#shape"/>'],
    ["animation", '<animate attributeName="x" values="0;1"/>'],
    ["embedded object", '<object data="data:text/html,unsafe"/>'],
  ])("removes %s elements from the strict static whitelist", (_label, payload) => {
    const result = sanitizeSvgText(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${payload}<rect width="1" height="1"/></svg>`);
    expect(result.svg).not.toMatch(/foreignObject|<image|<use|<animate|<object/i);
    expect(result.svg).toContain("<rect");
  });

  it("keeps static text with built-in font attributes", () => {
    const result = sanitizeSvgText(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><text font-family="sans-serif" font-size="16"><tspan x="4" y="20">Label</tspan></text></svg>',
    );
    expect(result.svg).toMatch(/font-family="sans-serif"/);
    expect(result.svg).toContain("<tspan");
    expect(result.text).toBe("Label");
  });

  it("rejects external resource URLs and entities", () => {
    expect(() => sanitizeSvgText(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/a)"/></svg>',
    )).toThrow("external resource");
    expect(() => sanitizeSvgText('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>')).toThrow(
      "declarations are not allowed",
    );
    expect(() => sanitizeSvgText(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000em" height="100"/>',
    )).toThrow("bounded pixel values");
  });

  it("enforces element, nesting, canvas, attribute, and path-complexity limits", () => {
    const tooManyNodes = `<svg xmlns="http://www.w3.org/2000/svg">${"<rect/>".repeat(RESOURCE_LIMITS.maxSvgNodes)}</svg>`;
    expect(() => sanitizeSvgText(tooManyNodes)).toThrow("more than 1000 elements");

    const nested = `${'<svg xmlns="http://www.w3.org/2000/svg">'}${"<g>".repeat(RESOURCE_LIMITS.maxSvgDepth)}${"</g>".repeat(RESOURCE_LIMITS.maxSvgDepth)}</svg>`;
    expect(() => sanitizeSvgText(nested)).toThrow("more than 32 levels");
    expect(() => sanitizeSvgText(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${RESOURCE_LIMITS.maxSvgDimension + 1}" height="1"/>`,
    )).toThrow("dimensions exceed");
    expect(() => sanitizeSvgText(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect aria-label="${"x".repeat(RESOURCE_LIMITS.maxSvgAttributeChars + 1)}"/></svg>`,
    )).toThrow("attribute 'aria-label' is too long");
    expect(() => sanitizeSvgText(
      `<svg xmlns="http://www.w3.org/2000/svg"><path d="${"M0 0 ".repeat(RESOURCE_LIMITS.maxSvgPathCommands + 1)}"/></svg>`,
    )).toThrow("path is too complex");
  });

  it("enforces the smaller generated-SVG byte limit before parsing", async () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(RESOURCE_LIMITS.generatedSvgBytes)}--></svg>`;
    const file = new File([source], "generated.svg", { type: "image/svg+xml" });
    const validated = await validateResourceFile(file);
    await expect(ingestSvgResource(validated, {
      conversationId: "conversation-1",
      origin: "generated",
    })).rejects.toThrow("256 KiB limit");
  });

  it("honors cancellation and a bounded safety timeout", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    expect(() => sanitizeSvgText(source, { signal: controller.signal })).toThrow("cancelled");
    expect(() => sanitizeSvgText(source, { timeoutMs: 0 })).toThrow("timed out");
  });
});
