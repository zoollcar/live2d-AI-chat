import { describe, expect, it, vi, type Mocked } from "vitest";
import type { AgentEvent } from "@/agent/types";
import type { SceneController } from "@/model/live2d/scene-controller";
import { createGoogleLiveSceneToolAdapter } from "./scene-tool-adapter";

function fakeScene(): Mocked<SceneController> {
  return {
    setDecorations: vi.fn((decorations: string[]) => decorations),
    enqueueAction: vi.fn(),
    preemptAndEnqueueAction: vi.fn(),
    setState: vi.fn().mockResolvedValue(undefined),
    setStageLayout: vi.fn(),
  } as unknown as Mocked<SceneController>;
}

describe("Google Live scene tool adapter", () => {
  it("reuses every validated scene declaration and executor", async () => {
    const scene = fakeScene();
    const events: AgentEvent[] = [];
    const adapter = createGoogleLiveSceneToolAdapter(scene, (event) => events.push(event));

    expect(adapter.declarations.map((declaration) => declaration.name)).toEqual([
      "setState",
      "setDecorations",
      "performAction",
      "setStageLayout",
      "listResources",
      "readResource",
      "readWebPage",
      "readVideoTranscript",
      "showResourceOnStage",
      "closeStageContent",
      "drawSvgOnStage",
      "sendSticker",
    ]);
    expect(adapter.declarations[0]).toMatchObject({
      name: "setState",
      parametersJsonSchema: {
        type: "object",
        required: ["state"],
        additionalProperties: false,
      },
    });
    expect(adapter.declarations[1]?.parametersJsonSchema).toMatchObject({
      properties: {
        decorations: { type: "array", uniqueItems: true },
      },
    });
    await expect(adapter.execute("call-1", "setStageLayout", { layout: "half-body-right" }))
      .resolves.toEqual({ ok: true, layout: "half-body-right" });
    expect(scene.setStageLayout).toHaveBeenCalledWith("half-body-right");
    expect(events).toEqual([
      { type: "tool-call", callId: "call-1", name: "setStageLayout", input: { layout: "half-body-right" } },
      {
        type: "tool-result",
        callId: "call-1",
        name: "setStageLayout",
        output: { ok: true, layout: "half-body-right" },
      },
    ]);
  });

  it("cancels a queued call before it can mutate the scene", async () => {
    const scene = fakeScene();
    let releaseFirst!: () => void;
    scene.setState.mockImplementation(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const adapter = createGoogleLiveSceneToolAdapter(scene, vi.fn());

    const first = adapter.execute("call-1", "setState", { state: "thinking" });
    const cancelled = adapter.execute("call-2", "setStageLayout", {
      layout: "half-body-left",
    });
    adapter.cancel?.("call-2");

    await expect(cancelled).rejects.toThrow("call-2 was cancelled");
    expect(scene.setStageLayout).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toEqual({ ok: true, state: "thinking" });
    await Promise.resolve();
    expect(scene.setStageLayout).not.toHaveBeenCalled();
  });
});
