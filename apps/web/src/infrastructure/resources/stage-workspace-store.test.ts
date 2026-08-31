import { afterEach, describe, expect, it } from "vitest";
import { useStageWorkspaceStore } from "./stage-workspace-store";
import {
  STAGE_WORKSPACE_MAX_ARTIFACTS,
  deriveStageLayoutLease,
  isCurrentStageLayoutLease,
  type StageArtifact,
} from "@/model/stage-workspace";

function textArtifact(id: string, text = id): StageArtifact {
  return {
    id,
    kind: "text",
    title: `Artifact ${id}`,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
    content: { text },
  };
}

function resetStore() {
  useStageWorkspaceStore.setState({
    artifacts: [],
    activeArtifactId: undefined,
    viewStateByArtifactId: {},
    layoutRevision: 0,
  });
}

describe("stage workspace store", () => {
  afterEach(resetStore);

  it("uses layout revisions to reject a stale close and safely restore the stage", () => {
    const store = useStageWorkspaceStore.getState();
    store.openArtifact(textArtifact("one"));
    const firstRevision = useStageWorkspaceStore.getState().layoutRevision;
    store.openArtifact(textArtifact("two"));
    const secondRevision = useStageWorkspaceStore.getState().layoutRevision;

    expect(store.closeArtifact("one", firstRevision)).toBe(false);
    expect(useStageWorkspaceStore.getState().artifacts.map((artifact) => artifact.id)).toEqual(["one", "two"]);

    expect(store.closeArtifact("two", secondRevision)).toBe(true);
    let snapshot = useStageWorkspaceStore.getState();
    expect(snapshot.activeArtifactId).toBe("one");
    expect(snapshot.layoutRevision).toBe(secondRevision + 1);
    expect(deriveStageLayoutLease(snapshot, "left")).toMatchObject({
      revision: secondRevision + 1,
      reason: "artifact-focus",
      characterSide: "left",
      windowSide: "right",
    });

    expect(store.closeArtifact("one", snapshot.layoutRevision)).toBe(true);
    snapshot = useStageWorkspaceStore.getState();
    expect(snapshot.activeArtifactId).toBeUndefined();
    expect(deriveStageLayoutLease(snapshot, "left", "center")).toEqual({
      revision: snapshot.layoutRevision,
      reason: "workspace-empty",
      characterSide: "center",
    });
    expect(isCurrentStageLayoutLease(snapshot, snapshot.layoutRevision)).toBe(true);
    expect(isCurrentStageLayoutLease(snapshot, firstRevision)).toBe(false);
    expect(store.closeArtifact("missing", snapshot.layoutRevision)).toBe(false);
  });

  it("keeps one focused artifact, bounded tray state, and per-artifact view state", () => {
    const store = useStageWorkspaceStore.getState();
    for (let index = 0; index < STAGE_WORKSPACE_MAX_ARTIFACTS + 2; index += 1) {
      store.openArtifact(textArtifact(`artifact-${index}`));
    }

    let snapshot = useStageWorkspaceStore.getState();
    expect(snapshot.artifacts).toHaveLength(STAGE_WORKSPACE_MAX_ARTIFACTS);
    expect(snapshot.artifacts[0].id).toBe("artifact-2");
    expect(snapshot.activeArtifactId).toBe(`artifact-${STAGE_WORKSPACE_MAX_ARTIFACTS + 1}`);
    expect(snapshot.viewStateByArtifactId["artifact-0"]).toBeUndefined();

    store.focusArtifact("artifact-3");
    store.setArtifactSearchQuery("artifact-3", "needle");
    store.selectArtifactSearchMatch("artifact-3", 2, 40);
    snapshot = useStageWorkspaceStore.getState();
    expect(snapshot.activeArtifactId).toBe("artifact-3");
    expect(snapshot.viewStateByArtifactId["artifact-3"]).toMatchObject({
      pageIndex: 0,
      searchQuery: "needle",
      activeSearchMatchIndex: 2,
    });
  });

  it("clamps page navigation and refuses updates that change artifact identity", () => {
    const pages: StageArtifact = {
      id: "slides",
      kind: "pptx",
      title: "Deck",
      status: "loading",
      createdAt: 1,
      updatedAt: 1,
      content: {
        pages: [
          { id: "s1", text: "One" },
          { id: "s2", text: "Two" },
        ],
      },
    };
    const store = useStageWorkspaceStore.getState();
    store.openArtifact(pages);
    store.navigateArtifact("slides", 99);
    expect(useStageWorkspaceStore.getState().viewStateByArtifactId.slides.pageIndex).toBe(1);

    store.setArtifactStatus("slides", { status: "ready", progress: { value: 1 } });
    expect(useStageWorkspaceStore.getState().artifacts[0]).toMatchObject({ status: "ready" });

    store.updateArtifact("slides", (artifact) => ({ ...artifact, id: "replacement" }));
    expect(useStageWorkspaceStore.getState().artifacts[0].id).toBe("slides");
  });
});
