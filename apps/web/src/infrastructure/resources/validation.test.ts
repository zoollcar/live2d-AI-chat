import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { validateResourceFile } from "./validation";

describe("validateResourceFile", () => {
  it.each([
    "empty.pdf",
    "empty.docx",
    "empty.pptx",
    "empty.txt",
    "empty.md",
    "empty.json",
    "empty.png",
    "empty.jpg",
    "empty.jpeg",
    "empty.webp",
    "empty.svg",
  ])("rejects an empty supported file: %s", async (name) => {
    await expect(validateResourceFile(new File([], name))).rejects.toThrow("selected file is empty");
  });

  it("accepts matching PDF signatures", async () => {
    const file = new File([new TextEncoder().encode("%PDF-1.7\n%%EOF")], "report.pdf", {
      type: "application/pdf",
    });
    await expect(validateResourceFile(file)).resolves.toMatchObject({
      kind: "pdf",
      extension: "pdf",
      mimeType: "application/pdf",
    });
  });

  it("rejects extension spoofing and binary text", async () => {
    await expect(validateResourceFile(new File(["not pdf"], "report.pdf", {
      type: "application/pdf",
    }))).rejects.toThrow("valid PDF signature");
    await expect(validateResourceFile(new File([new Uint8Array([65, 0, 66])], "notes.txt", {
      type: "text/plain",
    }))).rejects.toThrow("binary NUL");
  });

  it("rejects unsupported executable uploads", async () => {
    await expect(validateResourceFile(new File(["MZ"], "payload.exe", {
      type: "application/octet-stream",
    }))).rejects.toThrow("Supported files");
  });

  it("caps uploaded SVG files at 1 MiB", async () => {
    const oversized = new File([new Uint8Array(1024 * 1024 + 1)], "oversized.svg", {
      type: "image/svg+xml",
    });
    await expect(validateResourceFile(oversized)).rejects.toThrow("1 MiB limit");
  });

  it("rejects GIF and raster formats whose extension does not match their signature", async () => {
    const gif = new File(["GIF89a"], "reaction.gif", { type: "image/gif" });
    await expect(validateResourceFile(gif)).rejects.toThrow(
      "Supported files are PDF, DOCX, PPTX, TXT, MD, JSON, PNG, JPEG, WebP, and SVG.",
    );
    const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    await expect(validateResourceFile(new File([jpegHeader], "spoofed.png", {
      type: "image/png",
    }))).rejects.toThrow("signature does not match");
  });

  it("distinguishes DOCX and PPTX packages before parsing", async () => {
    const docx = zipSync({
      "[Content_Types].xml": new Uint8Array([1]),
      "word/document.xml": new Uint8Array([1]),
    }, { level: 0 });
    await expect(validateResourceFile(new File([docx], "spoofed.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }))).rejects.toThrow("not a valid PPTX package");
  });

  it("rejects a forged MIME type even when the extension and signature agree", async () => {
    const file = new File([new TextEncoder().encode("%PDF-1.7\n%%EOF")], "report.pdf", {
      type: "image/png",
    });
    await expect(validateResourceFile(file)).rejects.toThrow("extension and media type do not match");
  });

  it("rejects an Office ZIP bomb before loading a parser", async () => {
    const bomb = zipSync({
      "[Content_Types].xml": new Uint8Array([1]),
      "word/document.xml": new Uint8Array(2 * 1024 * 1024),
    }, { level: 9 });
    await expect(validateResourceFile(new File([bomb], "bomb.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }))).rejects.toThrow("suspicious compression ratio");
  });

  it.each([
    {
      label: "an explicit external relationship",
      relationship: `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
        Target="https://tracker.invalid/pixel.png" TargetMode="External"/>`,
    },
    {
      label: "an entity-encoded absolute target",
      relationship: `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
        Target="&#x68;ttps://tracker.invalid/pixel.png" TargetMode="Internal"/>`,
    },
    {
      label: "a protocol-relative target",
      relationship: `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"
        Target="//tracker.invalid/pixel.png"/>`,
    },
  ])("rejects Office packages with $label before parsing", async ({ relationship }) => {
    const relationships = new TextEncoder().encode(`<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        ${relationship}
      </Relationships>`);
    const docx = zipSync({
      "[Content_Types].xml": new Uint8Array([1]),
      "word/document.xml": new Uint8Array([1]),
      "word/_rels/document.xml.rels": relationships,
    }, { level: 0 });
    await expect(validateResourceFile(new File([docx], "external.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }))).rejects.toThrow("external relationships");
  });
});
