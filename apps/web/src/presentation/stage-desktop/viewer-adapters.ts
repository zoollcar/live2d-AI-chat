import {
  getStageArtifactPageCount,
  type StageArtifact,
  type StageDocumentPage,
  type StageVideoTranscriptCue,
} from "@/model/stage-workspace";

const MAX_SEARCH_MATCHES = 200;
const SEARCH_EXCERPT_RADIUS = 42;
const MAX_SEARCH_DOCUMENTS = 5_000;
const MAX_SEARCHABLE_CHARACTERS_PER_DOCUMENT = 2_000_000;

export interface StageSearchMatch {
  id: string;
  pageIndex: number;
  label: string;
  excerpt: string;
  cueId?: string;
}

export interface StageViewerAdapter {
  pageCount: number;
  pageNoun: "page" | "slide";
  getPageLabel(pageIndex: number): string;
  getSearchMatches(query: string): StageSearchMatch[];
}

interface SearchDocument {
  id: string;
  pageIndex: number;
  label: string;
  text: string;
  cueId?: string;
}

function labelDocumentPage(kind: StageArtifact["kind"], page: StageDocumentPage, index: number): string {
  if (page.label?.trim()) return page.label.trim();
  return kind === "pptx" ? `Slide ${index + 1}` : `Page ${index + 1}`;
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(Math.floor(milliseconds / 1_000), 0);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
    : `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function cueSearchDocument(cue: StageVideoTranscriptCue, index: number): SearchDocument {
  return {
    id: cue.id || `cue-${index}`,
    pageIndex: 0,
    label: formatTimestamp(cue.startMs),
    text: cue.text,
    cueId: cue.id,
  };
}

function searchDocumentsFor(artifact: StageArtifact): SearchDocument[] {
  switch (artifact.kind) {
    case "pdf":
    case "docx":
    case "pptx":
      return (artifact.content?.pages ?? []).map((page, index) => ({
        id: page.id,
        pageIndex: index,
        label: labelDocumentPage(artifact.kind, page, index),
        text: [page.title, page.text].filter(Boolean).join("\n"),
      }));
    case "text":
      return [{ id: artifact.id, pageIndex: 0, label: "Text", text: artifact.content?.text ?? "" }];
    case "image":
      return [{
        id: artifact.id,
        pageIndex: 0,
        label: "Image",
        text: [artifact.content?.alt, artifact.content?.caption].filter(Boolean).join("\n"),
      }];
    case "svg":
      return [{
        id: artifact.id,
        pageIndex: 0,
        label: "Drawing",
        text: [artifact.content?.alt, artifact.content?.caption].filter(Boolean).join("\n"),
      }];
    case "web":
      return [{
        id: artifact.id,
        pageIndex: 0,
        label: artifact.content?.siteName?.trim() || "Web page",
        text: [artifact.content?.byline, artifact.content?.text].filter(Boolean).join("\n"),
      }];
    case "video-transcript":
      return (artifact.content?.cues ?? []).map(cueSearchDocument);
  }
}

function excerptAround(text: string, start: number, length: number): string {
  const from = Math.max(start - SEARCH_EXCERPT_RADIUS, 0);
  const to = Math.min(start + length + SEARCH_EXCERPT_RADIUS, text.length);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < text.length ? "…" : "";
  return `${prefix}${text.slice(from, to).replace(/\s+/g, " ").trim()}${suffix}`;
}

function findMatches(documents: readonly SearchDocument[], rawQuery: string): StageSearchMatch[] {
  const query = rawQuery.trim().slice(0, 200);
  if (!query) return [];
  const foldedQuery = query.toLocaleLowerCase();
  const matches: StageSearchMatch[] = [];
  for (const document of documents) {
    const searchableText = document.text.slice(0, MAX_SEARCHABLE_CHARACTERS_PER_DOCUMENT);
    const foldedText = searchableText.toLocaleLowerCase();
    let start = foldedText.indexOf(foldedQuery);
    while (start >= 0 && matches.length < MAX_SEARCH_MATCHES) {
      matches.push({
        id: `${document.id}:${start}`,
        pageIndex: document.pageIndex,
        label: document.label,
        excerpt: excerptAround(searchableText, start, query.length),
        cueId: document.cueId,
      });
      start = foldedText.indexOf(foldedQuery, start + Math.max(foldedQuery.length, 1));
    }
    if (matches.length >= MAX_SEARCH_MATCHES) break;
  }
  return matches;
}

export function createStageViewerAdapter(artifact: StageArtifact): StageViewerAdapter {
  const pageCount = getStageArtifactPageCount(artifact);
  const pageNoun = artifact.kind === "pptx" ? "slide" : "page";
  const documents = searchDocumentsFor(artifact).slice(0, MAX_SEARCH_DOCUMENTS);
  return {
    pageCount,
    pageNoun,
    getPageLabel(pageIndex) {
      if (artifact.kind === "pdf" || artifact.kind === "docx" || artifact.kind === "pptx") {
        const page = artifact.content?.pages[pageIndex];
        if (page) return labelDocumentPage(artifact.kind, page, pageIndex);
      }
      return pageNoun === "slide" ? `Slide ${pageIndex + 1}` : `Page ${pageIndex + 1}`;
    },
    getSearchMatches(query) {
      return findMatches(documents, query);
    },
  };
}

export function formatStageTranscriptTimestamp(milliseconds: number): string {
  return formatTimestamp(milliseconds);
}
