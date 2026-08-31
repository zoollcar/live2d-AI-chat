import { useDeferredValue, useEffect, useId, useMemo } from "react";
import { useStageWorkspaceStore } from "@/infrastructure/resources/stage-workspace-store";
import {
  createStageArtifactViewState,
  deriveStageLayoutLease,
  type StageArtifact,
  type StageArtifactStatus,
  type StageArtifactViewState,
  type StageCharacterSide,
  type StageLayoutLease,
  type StageWorkspaceSnapshot,
} from "@/model/stage-workspace";
import { ArtifactViewer } from "./ArtifactViewer";
import { createStageViewerAdapter, type StageSearchMatch } from "./viewer-adapters";
import "./stage-desktop.css";

const ARTIFACT_KIND_LABELS: Record<StageArtifact["kind"], string> = {
  pdf: "PDF",
  docx: "Document",
  pptx: "Slides",
  text: "Text",
  image: "Image",
  svg: "Drawing",
  web: "Web",
  "video-transcript": "Transcript",
};

const ARTIFACT_KIND_SHORT_LABELS: Record<StageArtifact["kind"], string> = {
  pdf: "PDF",
  docx: "DOC",
  pptx: "SLIDE",
  text: "TXT",
  image: "IMG",
  svg: "DRAW",
  web: "WEB",
  "video-transcript": "CC",
};

const STATUS_LABELS: Record<StageArtifactStatus, string> = {
  queued: "Waiting to start",
  loading: "Preparing preview",
  ready: "Ready",
  error: "Could not prepare this item",
  canceled: "Canceled",
};

export interface StageDesktopActions {
  focusArtifact(id: string): void;
  closeArtifact(id: string, expectedLayoutRevision: number): boolean;
  navigateArtifact(id: string, pageIndex: number): void;
  searchArtifact(id: string, query: string): void;
  selectSearchMatch(id: string, matchIndex: number, pageIndex: number): void;
  cancelArtifact?(id: string): void;
  retryArtifact?(id: string): void;
  openArtifactSource?(artifact: StageArtifact): void;
  selectTranscriptCue?(artifactId: string, cueId: string, startMs: number): void;
}

export interface StageDesktopProps {
  workspace: StageWorkspaceSnapshot;
  actions: StageDesktopActions;
  /** Current Live2D side; the desktop window is placed on the opposite side. */
  characterSide?: Exclude<StageCharacterSide, "center">;
  /** Placement to restore after the last artifact closes. */
  restingCharacterSide?: StageCharacterSide;
  onLayoutLease?(lease: StageLayoutLease): void;
  className?: string;
}

export interface StageWorkspaceDesktopProps extends Omit<StageDesktopProps, "workspace" | "actions"> {
  onCloseArtifact?(id: string, expectedLayoutRevision: number): boolean;
  onCancelArtifact?(id: string): void;
  onRetryArtifact?(id: string): void;
  onOpenArtifactSource?(artifact: StageArtifact): void;
  onSelectTranscriptCue?(artifactId: string, cueId: string, startMs: number): void;
}

interface StageTrayProps {
  artifacts: readonly StageArtifact[];
  activeArtifactId?: string;
  onFocus(id: string): void;
}

function StageTray({ artifacts, activeArtifactId, onFocus }: StageTrayProps) {
  if (artifacts.length === 0) return null;
  return (
    <nav className="stage-desktop-tray" aria-label="Stage items">
      <ol>
        {artifacts.map((artifact) => (
          <li key={artifact.id}>
            <button
              type="button"
              className={artifact.id === activeArtifactId ? "active" : undefined}
              onClick={() => onFocus(artifact.id)}
              aria-label={`Show ${artifact.title}`}
              aria-pressed={artifact.id === activeArtifactId}
              title={artifact.title}
            >
              <span className="stage-desktop-tray-type" aria-hidden="true">
                {ARTIFACT_KIND_SHORT_LABELS[artifact.kind]}
              </span>
              <span className="stage-desktop-tray-title">{artifact.title}</span>
              <span
                className={`stage-desktop-status-dot status-${artifact.status}`}
                aria-label={STATUS_LABELS[artifact.status]}
              />
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

interface ArtifactStatusBannerProps {
  artifact: StageArtifact;
  actions: StageDesktopActions;
}

function ArtifactStatusBanner({ artifact, actions }: ArtifactStatusBannerProps) {
  if (artifact.status === "ready") return null;
  const value = artifact.progress?.value;
  const safeValue = value === undefined ? undefined : Math.min(Math.max(value, 0), 1);
  const showCancel = (artifact.status === "queued" || artifact.status === "loading")
    && artifact.canCancel !== false
    && actions.cancelArtifact;
  const showRetry = (artifact.status === "error" || artifact.status === "canceled")
    && artifact.canRetry !== false
    && actions.retryArtifact;
  return (
    <div
      className={`stage-desktop-status-banner status-${artifact.status}`}
      role={artifact.status === "error" ? "alert" : "status"}
      aria-live={artifact.status === "error" ? "assertive" : "polite"}
    >
      <div className="stage-desktop-status-copy">
        <strong>{STATUS_LABELS[artifact.status]}</strong>
        {artifact.progress?.label ? <span>{artifact.progress.label}</span> : null}
        {artifact.errorMessage ? <span>{artifact.errorMessage}</span> : null}
      </div>
      {artifact.status === "queued" || artifact.status === "loading" ? (
        <progress
          aria-label={artifact.progress?.label ?? STATUS_LABELS[artifact.status]}
          max={1}
          value={safeValue}
        />
      ) : null}
      <div className="stage-desktop-status-actions">
        {showCancel ? <button type="button" onClick={() => actions.cancelArtifact?.(artifact.id)}>Cancel</button> : null}
        {showRetry ? <button type="button" onClick={() => actions.retryArtifact?.(artifact.id)}>Retry</button> : null}
      </div>
    </div>
  );
}

interface SearchControlsProps {
  artifact: StageArtifact;
  viewState: StageArtifactViewState;
  matches: readonly StageSearchMatch[];
  actions: StageDesktopActions;
}

function SearchControls({ artifact, viewState, matches, actions }: SearchControlsProps) {
  const activeMatchIndex = matches.length === 0
    ? -1
    : Math.min(Math.max(viewState.activeSearchMatchIndex, -1), matches.length - 1);

  const move = (direction: -1 | 1) => {
    if (matches.length === 0) return;
    const base = activeMatchIndex < 0 ? (direction > 0 ? -1 : 0) : activeMatchIndex;
    const nextIndex = (base + direction + matches.length) % matches.length;
    const match = matches[nextIndex];
    actions.selectSearchMatch(artifact.id, nextIndex, match.pageIndex);
  };

  return (
    <div className="stage-desktop-search">
      <label>
        <span className="stage-desktop-visually-hidden">Search {artifact.title}</span>
        <input
          type="search"
          value={viewState.searchQuery}
          maxLength={200}
          placeholder="Search this item"
          onChange={(event) => actions.searchArtifact(artifact.id, event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") move(event.shiftKey ? -1 : 1);
          }}
        />
      </label>
      <span className="stage-desktop-search-count" aria-live="polite">
        {viewState.searchQuery.trim() ? `${matches.length} match${matches.length === 1 ? "" : "es"}` : ""}
      </span>
      <button
        type="button"
        onClick={() => move(-1)}
        disabled={matches.length === 0}
        aria-label="Previous search match"
      >
        Prev
      </button>
      <button
        type="button"
        onClick={() => move(1)}
        disabled={matches.length === 0}
        aria-label="Next search match"
      >
        Next
      </button>
      {activeMatchIndex >= 0 ? (
        <p className="stage-desktop-search-excerpt">
          <strong>{matches[activeMatchIndex].label}</strong>
          <span>{matches[activeMatchIndex].excerpt}</span>
        </p>
      ) : null}
    </div>
  );
}

interface PageControlsProps {
  artifact: StageArtifact;
  pageIndex: number;
  pageCount: number;
  pageLabel: string;
  pageNoun: "page" | "slide";
  actions: StageDesktopActions;
}

function PageControls({ artifact, pageIndex, pageCount, pageLabel, pageNoun, actions }: PageControlsProps) {
  if (pageCount <= 1) return null;
  return (
    <div className="stage-desktop-pagination" aria-label={`${artifact.title} navigation`}>
      <button
        type="button"
        onClick={() => actions.navigateArtifact(artifact.id, pageIndex - 1)}
        disabled={pageIndex <= 0}
        aria-label={`Previous ${pageNoun}`}
      >
        Previous
      </button>
      <span>{pageLabel} of {pageCount}</span>
      <button
        type="button"
        onClick={() => actions.navigateArtifact(artifact.id, pageIndex + 1)}
        disabled={pageIndex >= pageCount - 1}
        aria-label={`Next ${pageNoun}`}
      >
        Next
      </button>
    </div>
  );
}

interface ArtifactWindowProps {
  artifact: StageArtifact;
  viewState: StageArtifactViewState;
  layoutRevision: number;
  actions: StageDesktopActions;
}

function ArtifactWindow({ artifact, viewState, layoutRevision, actions }: ArtifactWindowProps) {
  const titleId = useId();
  const adapter = useMemo(() => createStageViewerAdapter(artifact), [artifact]);
  const deferredSearchQuery = useDeferredValue(viewState.searchQuery);
  const matches = useMemo(
    () => adapter.getSearchMatches(deferredSearchQuery),
    [adapter, deferredSearchQuery],
  );
  const pageIndex = Math.min(Math.max(viewState.pageIndex, 0), adapter.pageCount - 1);
  const hasContent = artifact.content !== undefined;

  return (
    <section
      className="stage-desktop-window"
      aria-labelledby={titleId}
      aria-busy={artifact.status === "queued" || artifact.status === "loading"}
    >
      <header className="stage-desktop-window-header">
        <span className="stage-desktop-kind-label" aria-hidden="true">
          {ARTIFACT_KIND_SHORT_LABELS[artifact.kind]}
        </span>
        <div className="stage-desktop-title-block">
          <span>{ARTIFACT_KIND_LABELS[artifact.kind]}</span>
          <h2 id={titleId}>{artifact.title}</h2>
        </div>
        {artifact.source ? (
          <button
            type="button"
            className="stage-desktop-source-button"
            onClick={actions.openArtifactSource ? () => actions.openArtifactSource?.(artifact) : undefined}
            disabled={!actions.openArtifactSource}
            title={artifact.source.detail}
          >
            Source · {artifact.source.label}
          </button>
        ) : null}
        <button
          type="button"
          className="stage-desktop-close-button"
          onClick={() => actions.closeArtifact(artifact.id, layoutRevision)}
          aria-label={`Close ${artifact.title}`}
        >
          Close
        </button>
      </header>

      <ArtifactStatusBanner artifact={artifact} actions={actions} />

      {hasContent ? (
        <SearchControls artifact={artifact} viewState={viewState} matches={matches} actions={actions} />
      ) : null}

      <div className="stage-desktop-viewer">
        {hasContent || artifact.status === "ready" ? (
          <ArtifactViewer
            artifact={artifact}
            pageIndex={pageIndex}
            searchQuery={deferredSearchQuery}
            onSelectTranscriptCue={actions.selectTranscriptCue
              ? (cueId, startMs) => actions.selectTranscriptCue?.(artifact.id, cueId, startMs)
              : undefined}
          />
        ) : (
          <div className="stage-desktop-working-placeholder" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <PageControls
        artifact={artifact}
        pageIndex={pageIndex}
        pageCount={adapter.pageCount}
        pageLabel={adapter.getPageLabel(pageIndex)}
        pageNoun={adapter.pageNoun}
        actions={actions}
      />
    </section>
  );
}

export function StageDesktop({
  workspace,
  actions,
  characterSide = "right",
  restingCharacterSide = "center",
  onLayoutLease,
  className,
}: StageDesktopProps) {
  const activeArtifact = workspace.artifacts.find((artifact) => artifact.id === workspace.activeArtifactId);
  const effectiveWorkspace = {
    activeArtifactId: activeArtifact?.id,
    layoutRevision: workspace.layoutRevision,
  };
  const lease = deriveStageLayoutLease(effectiveWorkspace, characterSide, restingCharacterSide);

  useEffect(() => {
    onLayoutLease?.(lease);
  }, [lease.activeArtifactId, lease.characterSide, lease.reason, lease.revision, lease.windowSide, onLayoutLease]);

  const rootClassName = [
    "stage-desktop",
    lease.windowSide ? `window-side-${lease.windowSide}` : "workspace-empty",
    className,
  ].filter(Boolean).join(" ");

  return (
    <div className={rootClassName} data-layout-revision={workspace.layoutRevision}>
      <StageTray
        artifacts={workspace.artifacts}
        activeArtifactId={activeArtifact?.id}
        onFocus={actions.focusArtifact}
      />
      {activeArtifact ? (
        <ArtifactWindow
          artifact={activeArtifact}
          viewState={workspace.viewStateByArtifactId[activeArtifact.id] ?? createStageArtifactViewState()}
          layoutRevision={workspace.layoutRevision}
          actions={actions}
        />
      ) : null}
    </div>
  );
}

/** Store-connected convenience component for App.tsx integration. */
export function StageWorkspaceDesktop({
  onCloseArtifact,
  onCancelArtifact,
  onRetryArtifact,
  onOpenArtifactSource,
  onSelectTranscriptCue,
  ...props
}: StageWorkspaceDesktopProps) {
  const artifacts = useStageWorkspaceStore((state) => state.artifacts);
  const activeArtifactId = useStageWorkspaceStore((state) => state.activeArtifactId);
  const viewStateByArtifactId = useStageWorkspaceStore((state) => state.viewStateByArtifactId);
  const layoutRevision = useStageWorkspaceStore((state) => state.layoutRevision);
  const focusArtifact = useStageWorkspaceStore((state) => state.focusArtifact);
  const closeArtifact = useStageWorkspaceStore((state) => state.closeArtifact);
  const navigateArtifact = useStageWorkspaceStore((state) => state.navigateArtifact);
  const searchArtifact = useStageWorkspaceStore((state) => state.setArtifactSearchQuery);
  const selectSearchMatch = useStageWorkspaceStore((state) => state.selectArtifactSearchMatch);

  return (
    <StageDesktop
      {...props}
      workspace={{ artifacts, activeArtifactId, viewStateByArtifactId, layoutRevision }}
      actions={{
        focusArtifact,
        closeArtifact: onCloseArtifact ?? closeArtifact,
        navigateArtifact,
        searchArtifact,
        selectSearchMatch,
        cancelArtifact: onCancelArtifact,
        retryArtifact: onRetryArtifact,
        openArtifactSource: onOpenArtifactSource,
        selectTranscriptCue: onSelectTranscriptCue,
      }}
    />
  );
}
