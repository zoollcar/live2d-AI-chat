import { describe, expect, it } from "vitest";
import type { StageArtifact } from "@/model/stage-workspace";
import { createStageViewerAdapter, formatStageTranscriptTimestamp } from "./viewer-adapters";

const base = {
  status: "ready" as const,
  createdAt: 1,
  updatedAt: 1,
};

describe("stage viewer adapters", () => {
  it("indexes extracted document text and preserves page and slide labels", () => {
    const pdf: StageArtifact = {
      ...base,
      id: "pdf",
      kind: "pdf",
      title: "Report",
      content: {
        pages: [
          { id: "p1", label: "Cover", text: "Overview" },
          { id: "p2", text: "A needle appears here" },
        ],
      },
    };
    const adapter = createStageViewerAdapter(pdf);
    expect(adapter.pageCount).toBe(2);
    expect(adapter.getPageLabel(0)).toBe("Cover");
    expect(adapter.getSearchMatches("NEEDLE")).toEqual([
      expect.objectContaining({ pageIndex: 1, label: "Page 2", excerpt: "A needle appears here" }),
    ]);

    const deck: StageArtifact = {
      ...base,
      id: "deck",
      kind: "pptx",
      title: "Deck",
      content: { pages: [{ id: "slide-one", text: "First" }] },
    };
    expect(createStageViewerAdapter(deck).getPageLabel(0)).toBe("Slide 1");
  });

  it("searches text, image captions, safe SVG metadata, websites, and video cues", () => {
    const artifacts: StageArtifact[] = [
      { ...base, id: "text", kind: "text", title: "Text", content: { text: "needle" } },
      {
        ...base,
        id: "image",
        kind: "image",
        title: "Image",
        content: { imageUrl: "blob:image", alt: "needle illustration" },
      },
      {
        ...base,
        id: "svg",
        kind: "svg",
        title: "Drawing",
        content: { rasterPreviewUrl: "blob:raster", alt: "needle drawing" },
      },
      {
        ...base,
        id: "web",
        kind: "web",
        title: "Article",
        content: { siteName: "Example", text: "needle article" },
      },
      {
        ...base,
        id: "video",
        kind: "video-transcript",
        title: "Video",
        content: { cues: [{ id: "cue-1", startMs: 65_000, text: "needle spoken here" }] },
      },
    ];

    for (const artifact of artifacts) {
      expect(createStageViewerAdapter(artifact).getSearchMatches("needle")).toHaveLength(1);
    }
    expect(createStageViewerAdapter(artifacts[4]).getSearchMatches("needle")[0]).toMatchObject({
      cueId: "cue-1",
      label: "1:05",
    });
    expect(formatStageTranscriptTimestamp(3_665_000)).toBe("1:01:05");
  });

  it("caps pathological match counts", () => {
    const artifact: StageArtifact = {
      ...base,
      id: "many",
      kind: "text",
      title: "Many",
      content: { text: "x".repeat(1_000) },
    };
    expect(createStageViewerAdapter(artifact).getSearchMatches("x")).toHaveLength(200);
  });
});
