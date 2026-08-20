import { describe, expect, it, vi, type Mocked } from "vitest";
import type { SceneController } from "@/model/live2d/scene-controller";
import { createSceneToolRegistry } from "./tools";

function fakeScene(): Mocked<SceneController> {
  return {
    setDecorations: vi.fn((decorations: string[]) => decorations),
    performAction: vi.fn(),
    enqueueAction: vi.fn(),
    preemptAndEnqueueAction: vi.fn(),
    setState: vi.fn().mockResolvedValue(undefined),
    setStageLayout: vi.fn(),
  } as unknown as Mocked<SceneController>;
}

describe("scene tools", () => {
  it("executes fixed stage layouts", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("setStageLayout", { layout: "half-body-left" }))
      .resolves.toEqual({ ok: true, layout: "half-body-left" });
    expect(scene.setStageLayout).toHaveBeenCalledWith("half-body-left");
  });

  it("sets state and a complete decoration set", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("setState", { state: "happy" }))
      .resolves.toEqual({ ok: true, state: "happy" });
    await expect(registry.execute("setDecorations", { decorations: ["crown", "cat-ears"] }))
      .resolves.toEqual({ ok: true, decorations: ["crown", "cat-ears"] });
    expect(scene.setState).toHaveBeenCalledWith("happy");
    expect(scene.setDecorations).toHaveBeenCalledWith(["crown", "cat-ears"]);
  });

  it("first performAction in a batch preempts, subsequent ones just enqueue", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await registry.execute("performAction", { action: "wink" });
    await registry.execute("performAction", { action: "wave" });
    expect(scene.preemptAndEnqueueAction).toHaveBeenCalledTimes(1);
    expect(scene.preemptAndEnqueueAction).toHaveBeenCalledWith("wink");
    expect(scene.enqueueAction).toHaveBeenCalledTimes(1);
    expect(scene.enqueueAction).toHaveBeenCalledWith("wave");
  });

  it("resetBatch() arms the next performAction to preempt again", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await registry.execute("performAction", { action: "wink" });
    await registry.execute("performAction", { action: "wave" });
    registry.resetBatch();
    await registry.execute("performAction", { action: "think" });
    expect(scene.preemptAndEnqueueAction).toHaveBeenCalledTimes(2);
    expect(scene.preemptAndEnqueueAction.mock.calls[0]![0]).toBe("wink");
    expect(scene.preemptAndEnqueueAction.mock.calls[1]![0]).toBe("think");
  });

  it("only curated actions and states are accepted", async () => {
    const registry = createSceneToolRegistry(fakeScene(), vi.fn());
    await expect(registry.execute("performAction", { action: "flirt" })).rejects.toThrow();
    await expect(registry.execute("setState", { state: "running" })).rejects.toThrow();
  });

  it("setState forwards to the scene controller", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("setState", { state: "thinking" }))
      .resolves.toEqual({ ok: true, state: "thinking" });
    expect(scene.setState).toHaveBeenCalledWith("thinking");
  });

  it("rejects arbitrary layouts and unknown visual states", async () => {
    const registry = createSceneToolRegistry(fakeScene(), vi.fn());
    await expect(registry.execute("setStageLayout", { layout: { x: 10, scale: 99 } }))
      .rejects.toThrow();
    await expect(registry.execute("setState", { state: "custom-file" }))
      .rejects.toThrow();
    await expect(registry.execute("setDecorations", { decorations: ["custom-file"] }))
      .rejects.toThrow();
  });
});
