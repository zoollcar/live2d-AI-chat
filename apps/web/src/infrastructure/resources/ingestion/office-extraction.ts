import { ResourceError } from "../errors";
import { RESOURCE_LIMITS } from "../limits";

export interface OfficeNodeLike {
  type?: string;
  text?: string;
  children?: OfficeNodeLike[];
  metadata?: Record<string, unknown>;
}

export interface OfficeAstLike {
  type?: string;
  content?: OfficeNodeLike[];
  metadata?: {
    title?: unknown;
    author?: unknown;
    nativeProperties?: Record<string, unknown>;
  };
  to(format: "text"): Promise<{ value: unknown }>;
}

export interface OfficeExtraction {
  sections: Array<{
    text: string;
    locator?: { slide?: number; label?: string };
  }>;
  metadata: {
    title?: string;
    author?: string;
    slideCount?: number;
    pageCount?: number;
  };
}

function metadataText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_000) : undefined;
}

function metadataPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function countOfficeNodes(nodes: readonly OfficeNodeLike[]): number {
  const stack = [...nodes];
  let count = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    count += 1;
    if (count > RESOURCE_LIMITS.maxOfficeNodes) {
      throw new ResourceError("invalid_file", "The Office document contains too many content nodes.");
    }
    for (const child of node.children ?? []) stack.push(child);
  }
  return count;
}

function nodeText(node: OfficeNodeLike): string {
  const stack = [node];
  const text: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (typeof current.text === "string" && current.text.trim()) {
      text.push(current.text);
      continue;
    }
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return text.join("\n");
}

export async function extractOfficeAst(
  ast: OfficeAstLike,
  kind: "docx" | "pptx",
): Promise<OfficeExtraction> {
  if (ast.type && ast.type !== kind) {
    throw new ResourceError("invalid_file", `The document contains ${ast.type} data instead of ${kind}.`);
  }
  countOfficeNodes(ast.content ?? []);

  let sections: OfficeExtraction["sections"];
  let slideCount: number | undefined;
  if (kind === "pptx") {
    const slides = (ast.content ?? []).filter((node) => node.type === "slide");
    if (slides.length > RESOURCE_LIMITS.maxSlides) {
      throw new ResourceError("too_many_slides", `The presentation has more than ${RESOURCE_LIMITS.maxSlides} slides.`);
    }
    slideCount = slides.length || undefined;
    sections = slides.map((slide, index) => {
      const declared = metadataPositiveInteger(slide.metadata?.slideNumber ?? slide.metadata?.pageNumber);
      const number = declared !== undefined && declared <= RESOURCE_LIMITS.maxSlides ? declared : index + 1;
      return {
        text: nodeText(slide),
        locator: { slide: number, label: `Slide ${number}` },
      };
    });
  } else {
    const generated = await ast.to("text");
    sections = [{ text: typeof generated.value === "string" ? generated.value : "" }];
  }

  if (sections.reduce((total, section) => total + section.text.length, 0) > RESOURCE_LIMITS.maxExtractedChars) {
    throw new ResourceError("invalid_file", "The Office document contains too much extracted text.");
  }
  const nativePages = metadataPositiveInteger(ast.metadata?.nativeProperties?.Pages);
  if (kind === "docx" && nativePages !== undefined && nativePages > RESOURCE_LIMITS.maxPdfPages) {
    throw new ResourceError("too_many_pages", `The document has more than ${RESOURCE_LIMITS.maxPdfPages} pages.`);
  }
  return {
    sections,
    metadata: {
      ...(metadataText(ast.metadata?.title) ? { title: metadataText(ast.metadata?.title) } : {}),
      ...(metadataText(ast.metadata?.author) ? { author: metadataText(ast.metadata?.author) } : {}),
      ...(kind === "pptx" && slideCount ? { slideCount } : {}),
      ...(kind === "docx" && nativePages ? { pageCount: nativePages } : {}),
    },
  };
}
