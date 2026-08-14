import { describe, expect, it, vi } from "vitest";
import type { SceneController } from "@/model/live2d/scene-controller";
import { createSceneToolRegistry } from "./tools";

function fakeScene() {
  return {
    setMood: vi.fn().mockResolvedValue(undefined),
    setDecoration: vi.fn(),
    performAction: vi.fn().mockResolvedValue(undefined),
    setStageLayout: vi.fn(),
  } as unknown as SceneController;
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

  it("starts only curated one-shot actions", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("performAction", { action: "think" }))
      .resolves.toEqual({ ok: true, action: "think" });
    expect(scene.performAction).toHaveBeenCalledWith("think");
    await expect(registry.execute("performAction", { action: "flirt" })).rejects.toThrow();
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
