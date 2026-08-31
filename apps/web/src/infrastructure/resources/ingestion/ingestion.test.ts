import { describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { validateResourceFile } from "../validation";
import { ingestImageResource } from "./image";
import { ingestOfficeResource } from "./office";
import { ingestPdfResource } from "./pdf";
import { ingestTextResource } from "./text";

const options = {
  conversationId: "conversation-1",
  resourceId: "resource-1",
  now: 1,
};

const xml = (value: string) => new TextEncoder().encode(value);

function minimalDocx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": xml(`<?xml version="1.0"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`),
    "_rels/.rels": xml(`<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`),
    "word/document.xml": xml(`<?xml version="1.0"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>Real DOCX extraction</w:t></w:r></w:p></w:body>
      </w:document>`),
  }, { level: 0 });
}

function minimalPptx(): Uint8Array {
  return zipSync({
    "[Content_Types].xml": xml(`<?xml version="1.0"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
        <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
      </Types>`),
    "_rels/.rels": xml(`<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
      </Relationships>`),
    "ppt/presentation.xml": xml(`<?xml version="1.0"?>
      <p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
      </p:presentation>`),
    "ppt/_rels/presentation.xml.rels": xml(`<?xml version="1.0"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
      </Relationships>`),
    "ppt/slides/slide1.xml": xml(`<?xml version="1.0"?>
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
        <p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Real PPTX extraction</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>
      </p:sld>`),
  }, { level: 0 });
}

function minimalPdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 72 100 Td (Real PDF extraction) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(source.length);
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = source.length;
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  source += offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(source);
}

describe("resource ingestion adapters", () => {
  it("extracts UTF-8 text into bounded chunks", async () => {
    const validated = await validateResourceFile(new File(["hello\r\nworld"], "notes.txt", {
      type: "text/plain",
    }));
    const bundle = await ingestTextResource(validated, options);
    expect(bundle.resource).toMatchObject({ kind: "text", textLength: 11, chunkCount: 1 });
    expect(bundle.chunks[0]).toMatchObject({ text: "hello\nworld", locator: { startChar: 0, endChar: 11 } });
  });

  it("rejects decoded image bombs after header validation", async () => {
    const pngHeader = new Uint8Array(24);
    pngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(pngHeader.buffer).setUint32(16, 1);
    new DataView(pngHeader.buffer).setUint32(20, 1);
    const validated = await validateResourceFile(new File([pngHeader], "huge.png", { type: "image/png" }));
    await expect(ingestImageResource(validated, options, async () => ({
      width: 10_000,
      height: 10_000,
    }))).rejects.toThrow("pixel limit");
  });

  it("rejects oversized encoded dimensions before asking the browser to decode", async () => {
    const pngHeader = new Uint8Array(24);
    pngHeader.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(pngHeader.buffer).setUint32(16, 100_000);
    new DataView(pngHeader.buffer).setUint32(20, 100_000);
    const validated = await validateResourceFile(new File([pngHeader], "encoded-bomb.png", {
      type: "image/png",
    }));
    const decode = vi.fn(async () => ({ width: 1, height: 1 }));
    await expect(ingestImageResource(validated, options, decode)).rejects.toThrow("pixel limit");
    expect(decode).not.toHaveBeenCalled();
  });

  it("extracts PDF pages with page locators and disables eval", async () => {
    const validated = await validateResourceFile(new File(["%PDF-1.7\n%%EOF"], "report.pdf", {
      type: "application/pdf",
    }));
    const destroy = vi.fn(async () => undefined);
    const getDocument = vi.fn(() => ({
      destroy,
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (page: number) => ({
          getTextContent: async () => ({ items: [{ str: `page ${page}`, hasEOL: true }] }),
        }),
        getMetadata: async () => ({ info: { Title: "Report" } }),
        destroy,
      }),
    }));
    const bundle = await ingestPdfResource(validated, options, async () => ({ getDocument }));
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ isEvalSupported: false }));
    expect(bundle.resource.metadata).toMatchObject({ pageCount: 2, title: "Report" });
    expect(bundle.chunks.map((chunk) => chunk.locator.page)).toEqual([1, 2]);
  });

  it("keeps a scanned PDF previewable without inventing OCR text", async () => {
    const validated = await validateResourceFile(new File(["%PDF-1.7\n%%EOF"], "scan.pdf", {
      type: "application/pdf",
    }));
    const destroy = vi.fn(async () => undefined);
    const bundle = await ingestPdfResource(validated, options, async () => ({
      getDocument: () => ({
        destroy,
        promise: Promise.resolve({
          numPages: 2,
          getPage: async () => ({ getTextContent: async () => ({ items: [] }) }),
          destroy,
        }),
      }),
    }));

    expect(bundle.resource).toMatchObject({
      kind: "pdf",
      status: "ready",
      textLength: 0,
      chunkCount: 0,
      metadata: { pageCount: 2 },
    });
    expect(bundle.chunks).toEqual([]);
  });

  it("uses the installed pdfjs worker entry to extract a real PDF page", async () => {
    const validated = await validateResourceFile(new File([Uint8Array.from(minimalPdf()).buffer], "real.pdf", {
      type: "application/pdf",
    }));
    const bundle = await ingestPdfResource(validated, {
      ...options,
      resourceId: "resource-real-pdf",
    });
    expect(bundle.resource.metadata.pageCount).toBe(1);
    expect(bundle.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Real PDF extraction"), locator: expect.objectContaining({ page: 1 }) }),
    ]));
  });

  it("preserves PPTX slide locators from officeparser/slim AST", async () => {
    const file = {
      file: new File(["zip"], "deck.pptx"),
      bytes: new Uint8Array([0x50, 0x4b]),
      kind: "pptx" as const,
      extension: "pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    const bundle = await ingestOfficeResource(file, options, async () => ({
      OfficeParser: {
        parseOffice: async () => ({
          type: "pptx",
          content: [
            { type: "slide", children: [{ type: "text", text: "Opening" }], metadata: { slideNumber: 1 } },
            { type: "slide", text: "Summary", metadata: { slideNumber: 2 } },
          ],
          metadata: { title: "Deck" },
          to: async () => ({ value: "" }),
        }),
      },
    }));
    expect(bundle.resource.metadata).toMatchObject({ slideCount: 2, title: "Deck" });
    expect(bundle.chunks.map((chunk) => chunk.locator.slide)).toEqual([1, 2]);
  });

  it("uses the installed officeparser/slim browser entry for real DOCX and PPTX packages", async () => {
    const docxFile = new File([Uint8Array.from(minimalDocx()).buffer], "real.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const pptxFile = new File([Uint8Array.from(minimalPptx()).buffer], "real.pptx", {
      type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    const [docx, pptx] = await Promise.all([
      validateResourceFile(docxFile).then((validated) => ingestOfficeResource(validated, {
        ...options,
        resourceId: "resource-docx",
      })),
      validateResourceFile(pptxFile).then((validated) => ingestOfficeResource(validated, {
        ...options,
        resourceId: "resource-pptx",
      })),
    ]);
    expect(docx.chunks.map((chunk) => chunk.text).join(" ")).toContain("Real DOCX extraction");
    expect(pptx.chunks).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining("Real PPTX extraction"), locator: { slide: 1, label: "Slide 1", startChar: 0, endChar: 20 } }),
    ]));
  });
});
