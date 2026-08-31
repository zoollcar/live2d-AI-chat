// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStageWorkspaceStore } from "@/infrastructure/resources/stage-workspace-store";
import {
  registerStageDocumentPreviewSource,
  type StageDocumentPreviewMountOptions,
  type StageDocumentPreviewSource,
} from "@/infrastructure/resources/stage-document-preview";
import type { StageArtifact, StageLayoutLease } from "@/model/stage-workspace";
import { StageWorkspaceDesktop, type StageWorkspaceDesktopProps } from "./StageDesktop";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  status: "ready" as const,
  createdAt: 1,
  updatedAt: 1,
};

let container: HTMLDivElement;
let root: Root;
let previewReleases: Array<() => void>;

function resetStore() {
  useStageWorkspaceStore.setState({
    artifacts: [],
    activeArtifactId: undefined,
    viewStateByArtifactId: {},
    layoutRevision: 0,
  });
}

async function renderDesktop(props: StageWorkspaceDesktopProps = {}) {
  await act(async () => {
    root.render(createElement(StageWorkspaceDesktop, props));
  });
}

function buttonWithLabel(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${label}`);
  return button;
}

function buttonWithText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}

async function enterSearch(query: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("Search input not found");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, query);
  await act(async () => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  resetStore();
  previewReleases = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  previewReleases.splice(0).forEach((release) => release());
  resetStore();
});

describe("StageWorkspaceDesktop", () => {
  it("renders one focused window, keeps all items in the tray, and places it opposite the character", async () => {
    const store = useStageWorkspaceStore.getState();
    store.openArtifact({ ...base, id: "one", kind: "text", title: "One", content: { text: "First" } });
    store.openArtifact({ ...base, id: "two", kind: "text", title: "Two", content: { text: "Second" } });
    const leases: StageLayoutLease[] = [];

    await renderDesktop({ characterSide: "left", onLayoutLease: (lease) => leases.push(lease) });

    expect(container.querySelectorAll(".stage-desktop-window")).toHaveLength(1);
    expect(container.querySelectorAll(".stage-desktop-tray li")).toHaveLength(2);
    expect(container.querySelector(".stage-desktop")?.classList.contains("window-side-right")).toBe(true);
    expect(container.textContent).toContain("Second");
    expect(leases.at(-1)).toMatchObject({ reason: "artifact-focus", characterSide: "left", windowSide: "right" });

    await click(buttonWithLabel("Show One"));
    expect(container.textContent).toContain("First");
    expect(container.textContent).not.toContain("Second");
  });

  it("supports page navigation, local search, provenance, and revision-safe close restoration", async () => {
    const source = vi.fn();
    const leases: StageLayoutLease[] = [];
    useStageWorkspaceStore.getState().openArtifact({
      ...base,
      id: "deck",
      kind: "pptx",
      title: "Research deck",
      source: { label: "example.com", url: "https://example.com/deck" },
      content: {
        pages: [
          { id: "s1", title: "Opening", text: "Alpha" },
          { id: "s2", title: "Finding", text: "The needle is here" },
        ],
      },
    });
    await renderDesktop({ onOpenArtifactSource: source, onLayoutLease: (lease) => leases.push(lease) });

    expect(container.textContent).toContain("Slide 1 of 2");
    await click(buttonWithLabel("Next slide"));
    expect(container.textContent).toContain("The needle is here");
    await click(buttonWithLabel("Previous slide"));
    expect(container.textContent).toContain("Alpha");

    await enterSearch("needle");
    expect(container.textContent).toContain("1 match");
    await click(buttonWithLabel("Next search match"));
    expect(container.textContent).toContain("The needle is here");

    await click(buttonWithText("Source · example.com"));
    expect(source).toHaveBeenCalledWith(expect.objectContaining({ id: "deck" }));

    await click(buttonWithLabel("Close Research deck"));
    expect(useStageWorkspaceStore.getState().activeArtifactId).toBeUndefined();
    expect(container.querySelector(".stage-desktop-window")).toBeNull();
    expect(leases.at(-1)).toMatchObject({ reason: "workspace-empty", characterSide: "center" });
  });

  it("mounts original document previews only when focused, navigates in place, and disposes on blur", async () => {
    const showPage = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const mount = vi.fn(async (
      previewContainer: HTMLElement,
      _options: StageDocumentPreviewMountOptions,
    ) => {
      const rendered = document.createElement("div");
      rendered.textContent = "Original PDF canvas";
      previewContainer.append(rendered);
      return { pageCount: 2, showPage, dispose };
    });
    const source: StageDocumentPreviewSource = { kind: "pdf", mount };
    previewReleases.push(registerStageDocumentPreviewSource("original-pdf", source));

    const store = useStageWorkspaceStore.getState();
    store.openArtifact({ ...base, id: "note", kind: "text", title: "Note", content: { text: "Keep focus" } });
    store.openArtifact({
      ...base,
      id: "original-pdf",
      kind: "pdf",
      title: "Original report",
      content: {
        originalPreviewAvailable: true,
        pages: [
          { id: "page-a", label: "Page 5", sourcePageIndex: 4, text: "Extracted five" },
          { id: "page-b", label: "Page 10", sourcePageIndex: 9, text: "Extracted ten" },
        ],
      },
    }, { focus: false });
    await renderDesktop();

    expect(mount).not.toHaveBeenCalled();
    await click(buttonWithLabel("Show Original report"));
    await act(async () => Promise.resolve());
    expect(mount).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      initialPageIndex: 4,
      signal: expect.any(AbortSignal),
    }));
    expect(container.textContent).toContain("Original PDF canvas");

    await click(buttonWithLabel("Next page"));
    await act(async () => Promise.resolve());
    expect(showPage).toHaveBeenCalledWith(9, expect.any(AbortSignal));
    expect(mount).toHaveBeenCalledOnce();

    await click(buttonWithLabel("Show Note"));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("keeps extracted text available when an original preview adapter is unavailable", async () => {
    useStageWorkspaceStore.getState().openArtifact({
      ...base,
      id: "missing-original",
      kind: "docx",
      title: "Recovered document",
      content: {
        originalPreviewAvailable: true,
        pages: [{ id: "page", text: "Searchable recovered text" }],
      },
    });

    await renderDesktop();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Original preview unavailable");
    expect(container.textContent).toContain("Searchable recovered text");
    expect(container.querySelector("script, iframe, object, embed")).toBeNull();
  });

  it("exposes progress, cancel, and retry without discarding an existing preview", async () => {
    const cancel = vi.fn();
    const retry = vi.fn();
    const artifact: StageArtifact = {
      id: "working",
      kind: "text",
      title: "Working note",
      status: "loading",
      createdAt: 1,
      updatedAt: 1,
      progress: { value: 0.42, label: "Reading file" },
      content: { text: "Partial preview" },
    };
    useStageWorkspaceStore.getState().openArtifact(artifact);
    await renderDesktop({
      onCancelArtifact: cancel,
      onRetryArtifact: retry,
    });

    expect(container.textContent).toContain("Partial preview");
    expect(container.querySelector("progress")?.getAttribute("value")).toBe("0.42");
    await click(buttonWithText("Cancel"));
    expect(cancel).toHaveBeenCalledWith("working");

    await act(async () => {
      useStageWorkspaceStore.getState().setArtifactStatus("working", {
        status: "error",
        errorMessage: "Preview failed safely.",
      });
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Preview failed safely.");
    await click(buttonWithText("Retry"));
    expect(retry).toHaveBeenCalledWith("working");

    await act(async () => {
      useStageWorkspaceStore.getState().setArtifactStatus("working", { status: "canceled" });
    });
    expect(container.textContent).toContain("Canceled");
    await click(buttonWithText("Retry"));
    expect(retry).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Partial preview");
  });

  it("renders every supported resource as inert previews and plain text", async () => {
    const artifacts: StageArtifact[] = [
      { ...base, id: "pdf", kind: "pdf", title: "PDF", content: { pages: [{ id: "p", text: "PDF body" }] } },
      { ...base, id: "docx", kind: "docx", title: "DOCX", content: { pages: [{ id: "d", text: "DOCX body" }] } },
      { ...base, id: "pptx", kind: "pptx", title: "PPTX", content: { pages: [{ id: "s", text: "PPTX body" }] } },
      {
        ...base,
        id: "text",
        kind: "text",
        title: "TEXT",
        content: { text: '<script data-unsafe="true">window.pwned = true</script>' },
      },
      {
        ...base,
        id: "image",
        kind: "image",
        title: "IMAGE",
        content: { imageUrl: "data:image/png;base64,AA==", alt: "Image preview" },
      },
      {
        ...base,
        id: "svg",
        kind: "svg",
        title: "SVG",
        content: { rasterPreviewUrl: "data:image/png;base64,AA==", alt: "Rasterized drawing" },
      },
      {
        ...base,
        id: "web",
        kind: "web",
        title: "WEB",
        content: { siteName: "Example", text: "Web article body" },
      },
      {
        ...base,
        id: "video",
        kind: "video-transcript",
        title: "VIDEO",
        content: { cues: [{ id: "cue", startMs: 2_000, text: "Transcript body" }] },
      },
    ];
    const store = useStageWorkspaceStore.getState();
    for (const artifact of artifacts) store.openArtifact(artifact, { focus: false });
    await renderDesktop();

    const checks: Array<[string, string]> = [
      ["pdf", "PDF body"],
      ["docx", "DOCX body"],
      ["pptx", "PPTX body"],
      ["text", '<script data-unsafe="true">window.pwned = true</script>'],
      ["web", "Web article body"],
      ["video", "Transcript body"],
    ];
    for (const [id, expectedText] of checks) {
      await click(buttonWithLabel(`Show ${artifacts.find((artifact) => artifact.id === id)?.title}`));
      expect(container.textContent).toContain(expectedText);
    }

    await click(buttonWithLabel("Show IMAGE"));
    expect(container.querySelector('img[alt="Image preview"]')).not.toBeNull();
    await click(buttonWithLabel("Show SVG"));
    expect(container.querySelector('img[alt="Rasterized drawing"]')).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((globalThis as typeof globalThis & { pwned?: boolean }).pwned).toBeUndefined();
  });
});
