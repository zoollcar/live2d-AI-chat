import { describe, expect, it, vi, type Mocked } from "vitest";
import type { SceneController } from "@/model/live2d/scene-controller";
import { createSceneToolRegistry } from "./tools";

function fakeScene(): Mocked<SceneController> {
  return {
    setMood: vi.fn().mockResolvedValue(undefined),
    setDecoration: vi.fn(),
    performAction: vi.fn(),
    enqueueAction: vi.fn(),
    preemptAndEnqueueAction: vi.fn(),
    setState: vi.fn().mockResolvedValue(undefined),
    blink: vi.fn(),
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

  it("sets mood and decoration independently", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("setMood", { mood: "happy" }))
      .resolves.toEqual({ ok: true, mood: "happy" });
    await expect(registry.execute("setDecoration", { decoration: "cat-ears" }))
      .resolves.toEqual({ ok: true, decoration: "cat-ears" });
    expect(scene.setMood).toHaveBeenCalledWith("happy");
    expect(scene.setDecoration).toHaveBeenCalledWith("cat-ears");
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

  it("setState and blink forward to the scene controller", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("setState", { state: "thinking" }))
      .resolves.toEqual({ ok: true, state: "thinking" });
    expect(scene.setState).toHaveBeenCalledWith("thinking");
    await expect(registry.execute("blink", {})).resolves.toEqual({ ok: true });
    expect(scene.blink).toHaveBeenCalledOnce();
  });

  it("rejects arbitrary layouts and unknown visual states", async () => {
    const registry = createSceneToolRegistry(fakeScene(), vi.fn());
    await expect(registry.execute("setStageLayout", { layout: { x: 10, scale: 99 } }))
      .rejects.toThrow();
    await expect(registry.execute("setMood", { mood: "custom-file" }))
      .rejects.toThrow();
    await expect(registry.execute("setDecoration", { decoration: "custom-file" }))
      .rejects.toThrow();
  });
});