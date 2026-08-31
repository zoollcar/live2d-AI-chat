import { create } from "zustand";
import {
  STAGE_WORKSPACE_MAX_ARTIFACTS,
  clampStagePageIndex,
  createStageArtifactViewState,
  type StageArtifact,
  type StageArtifactProgress,
  type StageArtifactStatus,
  type StageArtifactViewState,
  type StageWorkspaceSnapshot,
} from "@/model/stage-workspace";

export interface OpenStageArtifactOptions {
  focus?: boolean;
}

export interface StageArtifactStatusUpdate {
  status: StageArtifactStatus;
  progress?: StageArtifactProgress;
  errorMessage?: string;
  canCancel?: boolean;
  canRetry?: boolean;
}

export interface StageWorkspaceStore extends StageWorkspaceSnapshot {
  openArtifact(artifact: StageArtifact, options?: OpenStageArtifactOptions): void;
  focusArtifact(id: string): void;
  /**
   * expectedLayoutRevision makes closes from old tool runs harmless after a
   * newer artifact has taken over the stage. Returns whether the close was
   * accepted so loader-owned resources are only released after removal.
   */
  closeArtifact(id: string, expectedLayoutRevision?: number): boolean;
  updateArtifact(id: string, updater: (artifact: StageArtifact) => StageArtifact): void;
  setArtifactStatus(id: string, update: StageArtifactStatusUpdate): void;
  navigateArtifact(id: string, pageIndex: number): void;
  setArtifactSearchQuery(id: string, query: string): void;
  selectArtifactSearchMatch(id: string, matchIndex: number, pageIndex: number): void;
  resetWorkspace(): void;
}

const initialSnapshot: StageWorkspaceSnapshot = {
  artifacts: [],
  activeArtifactId: undefined,
  viewStateByArtifactId: {},
  layoutRevision: 0,
};

function withUpdatedViewState(
  viewStateByArtifactId: Readonly<Record<string, StageArtifactViewState>>,
  id: string,
  update: (viewState: StageArtifactViewState) => StageArtifactViewState,
): Record<string, StageArtifactViewState> {
  return {
    ...viewStateByArtifactId,
    [id]: update(viewStateByArtifactId[id] ?? createStageArtifactViewState()),
  };
}

export const useStageWorkspaceStore = create<StageWorkspaceStore>((set, get) => ({
  ...initialSnapshot,
  openArtifact(artifact, options) {
    if (!artifact.id.trim()) return;
    set((state) => {
      const withoutCurrent = state.artifacts.filter((item) => item.id !== artifact.id);
      const artifacts = [...withoutCurrent, artifact].slice(-STAGE_WORKSPACE_MAX_ARTIFACTS);
      const retainedIds = new Set(artifacts.map((item) => item.id));
      const viewStateByArtifactId = Object.fromEntries(
        Object.entries(state.viewStateByArtifactId).filter(([id]) => retainedIds.has(id)),
      );
      viewStateByArtifactId[artifact.id] ??= createStageArtifactViewState();
      const focus = options?.focus ?? true;
      const previousActiveWasEvicted = state.activeArtifactId !== undefined
        && !retainedIds.has(state.activeArtifactId);
      const activeArtifactId = focus || previousActiveWasEvicted || !state.activeArtifactId
        ? artifact.id
        : state.activeArtifactId;
      const layoutChanged = focus || previousActiveWasEvicted || !state.activeArtifactId;
      return {
        artifacts,
        activeArtifactId,
        viewStateByArtifactId,
        layoutRevision: layoutChanged ? state.layoutRevision + 1 : state.layoutRevision,
      };
    });
  },
  focusArtifact(id) {
    if (!get().artifacts.some((artifact) => artifact.id === id)) return;
    set((state) => ({
      activeArtifactId: id,
      layoutRevision: state.layoutRevision + 1,
    }));
  },
  closeArtifact(id, expectedLayoutRevision) {
    const current = get();
    if (expectedLayoutRevision !== undefined && current.layoutRevision !== expectedLayoutRevision) return false;
    if (!current.artifacts.some((artifact) => artifact.id === id)) return false;
    set((state) => {
      const artifacts = state.artifacts.filter((artifact) => artifact.id !== id);
      const viewStateByArtifactId = { ...state.viewStateByArtifactId };
      delete viewStateByArtifactId[id];
      if (state.activeArtifactId !== id) return { artifacts, viewStateByArtifactId };
      return {
        artifacts,
        viewStateByArtifactId,
        activeArtifactId: artifacts.at(-1)?.id,
        layoutRevision: state.layoutRevision + 1,
      };
    });
    return true;
  },
  updateArtifact(id, updater) {
    set((state) => ({
      artifacts: state.artifacts.map((artifact) => {
        if (artifact.id !== id) return artifact;
        const updated = updater(artifact);
        if (updated.id !== artifact.id || updated.kind !== artifact.kind) return artifact;
        return updated;
      }),
    }));
  },
  setArtifactStatus(id, update) {
    get().updateArtifact(id, (artifact) => ({
      ...artifact,
      status: update.status,
      progress: update.progress,
      errorMessage: update.errorMessage,
      canCancel: update.canCancel,
      canRetry: update.canRetry,
      updatedAt: Date.now(),
    }) as StageArtifact);
  },
  navigateArtifact(id, pageIndex) {
    const artifact = get().artifacts.find((item) => item.id === id);
    if (!artifact) return;
    set((state) => ({
      viewStateByArtifactId: withUpdatedViewState(state.viewStateByArtifactId, id, (viewState) => ({
        ...viewState,
        pageIndex: clampStagePageIndex(artifact, pageIndex),
      })),
    }));
  },
  setArtifactSearchQuery(id, query) {
    if (!get().artifacts.some((artifact) => artifact.id === id)) return;
    set((state) => ({
      viewStateByArtifactId: withUpdatedViewState(state.viewStateByArtifactId, id, (viewState) => ({
        ...viewState,
        searchQuery: query,
        activeSearchMatchIndex: -1,
      })),
    }));
  },
  selectArtifactSearchMatch(id, matchIndex, pageIndex) {
    const artifact = get().artifacts.find((item) => item.id === id);
    if (!artifact) return;
    set((state) => ({
      viewStateByArtifactId: withUpdatedViewState(state.viewStateByArtifactId, id, (viewState) => ({
        ...viewState,
        pageIndex: clampStagePageIndex(artifact, pageIndex),
        activeSearchMatchIndex: Math.max(Math.trunc(matchIndex), -1),
      })),
    }));
  },
  resetWorkspace() {
    set((state) => ({
      ...initialSnapshot,
      layoutRevision: state.layoutRevision + 1,
    }));
  },
}));
