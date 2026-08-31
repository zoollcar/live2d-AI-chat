export const STAGE_WORKSPACE_MAX_ARTIFACTS = 12;

export type StageArtifactKind =
  | "pdf"
  | "docx"
  | "pptx"
  | "text"
  | "image"
  | "svg"
  | "web"
  | "video-transcript";

export type StageArtifactStatus =
  | "queued"
  | "loading"
  | "ready"
  | "error"
  | "canceled";

export interface StageArtifactSource {
  /** Human-readable provenance. Never treated as trusted HTML. */
  label: string;
  detail?: string;
  /** Passed back to the host application; StageDesktop never navigates directly. */
  url?: string;
}

export interface StageArtifactProgress {
  /** Omit for indeterminate work. Values outside 0..1 are clamped by the view. */
  value?: number;
  label?: string;
}

export interface StageDocumentPage {
  id: string;
  label?: string;
  title?: string;
  /** Zero-based page/slide index in an original preview adapter. */
  sourcePageIndex?: number;
  /** Extracted plain text used for display and local search. */
  text?: string;
  /** A pre-rendered, inert page/slide preview such as PNG or WebP. */
  previewUrl?: string;
  previewAlt?: string;
}

export interface StageVideoTranscriptCue {
  id: string;
  startMs: number;
  endMs?: number;
  text: string;
  speaker?: string;
}

interface StageArtifactBase {
  id: string;
  kind: StageArtifactKind;
  title: string;
  status: StageArtifactStatus;
  createdAt: number;
  updatedAt: number;
  source?: StageArtifactSource;
  progress?: StageArtifactProgress;
  /** Redacted, display-safe text only; raw provider errors must stay upstream. */
  errorMessage?: string;
  canCancel?: boolean;
  canRetry?: boolean;
}

type StagePagedArtifact = StageArtifactBase & {
  kind: "pdf" | "docx" | "pptx";
  content?: {
    pages: StageDocumentPage[];
    /** Original bytes stay in a loader-owned preview adapter outside this model. */
    originalPreviewAvailable?: boolean;
  };
};

type StageTextArtifact = StageArtifactBase & {
  kind: "text";
  content?: {
    text: string;
    language?: string;
  };
};

type StageImageArtifact = StageArtifactBase & {
  kind: "image";
  content?: {
    imageUrl: string;
    alt: string;
    caption?: string;
  };
};

type StageSvgArtifact = StageArtifactBase & {
  kind: "svg";
  content?: {
    /** Must be a raster preview produced after SVG validation and sanitization. */
    rasterPreviewUrl: string;
    alt: string;
    caption?: string;
  };
};

type StageWebArtifact = StageArtifactBase & {
  kind: "web";
  content?: {
    siteName?: string;
    byline?: string;
    text: string;
    previewImageUrl?: string;
    previewImageAlt?: string;
  };
};

type StageVideoTranscriptArtifact = StageArtifactBase & {
  kind: "video-transcript";
  content?: {
    cues: StageVideoTranscriptCue[];
    durationMs?: number;
    posterUrl?: string;
    posterAlt?: string;
  };
};

/**
 * Presentation-ready data only. Raw files, untrusted HTML, and raw SVG markup
 * stay behind resource adapters and are never accepted by the stage view.
 */
export type StageArtifact =
  | StagePagedArtifact
  | StageTextArtifact
  | StageImageArtifact
  | StageSvgArtifact
  | StageWebArtifact
  | StageVideoTranscriptArtifact;

export interface StageArtifactViewState {
  pageIndex: number;
  searchQuery: string;
  activeSearchMatchIndex: number;
}

export interface StageWorkspaceSnapshot {
  artifacts: readonly StageArtifact[];
  activeArtifactId?: string;
  viewStateByArtifactId: Readonly<Record<string, StageArtifactViewState>>;
  /** Monotonically increasing lease used to reject stale layout restoration. */
  layoutRevision: number;
}

export type StageCharacterSide = "left" | "right" | "center";
export type StageWindowSide = "left" | "right";

export interface StageLayoutLease {
  revision: number;
  reason: "artifact-focus" | "workspace-empty";
  activeArtifactId?: string;
  characterSide: StageCharacterSide;
  windowSide?: StageWindowSide;
}

export function createStageArtifactViewState(): StageArtifactViewState {
  return {
    pageIndex: 0,
    searchQuery: "",
    activeSearchMatchIndex: -1,
  };
}

export function getStageArtifactPageCount(artifact: StageArtifact): number {
  if (artifact.kind === "pdf" || artifact.kind === "docx" || artifact.kind === "pptx") {
    return Math.max(artifact.content?.pages.length ?? 0, 1);
  }
  return 1;
}

export function clampStagePageIndex(artifact: StageArtifact, pageIndex: number): number {
  const finiteIndex = Number.isFinite(pageIndex) ? Math.trunc(pageIndex) : 0;
  return Math.min(Math.max(finiteIndex, 0), getStageArtifactPageCount(artifact) - 1);
}

export function deriveStageLayoutLease(
  workspace: Pick<StageWorkspaceSnapshot, "activeArtifactId" | "layoutRevision">,
  characterSide: Exclude<StageCharacterSide, "center">,
  restingCharacterSide: StageCharacterSide = "center",
): StageLayoutLease {
  if (!workspace.activeArtifactId) {
    return {
      revision: workspace.layoutRevision,
      reason: "workspace-empty",
      characterSide: restingCharacterSide,
    };
  }
  return {
    revision: workspace.layoutRevision,
    reason: "artifact-focus",
    activeArtifactId: workspace.activeArtifactId,
    characterSide,
    windowSide: characterSide === "left" ? "right" : "left",
  };
}

export function isCurrentStageLayoutLease(
  workspace: Pick<StageWorkspaceSnapshot, "layoutRevision">,
  revision: number,
): boolean {
  return workspace.layoutRevision === revision;
}
