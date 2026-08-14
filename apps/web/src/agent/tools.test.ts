import { describe, expect, it, vi } from "vitest";
import type { SceneController } from "@/model/live2d/scene-controller";
import { createSceneToolRegistry } from "./tools";

function fakeScene() {
  return {
    setExpression: vi.fn().mockResolvedValue(undefined),
    performAction: vi.fn().mockResolvedValue(undefined),
    setPose: vi.fn().mockResolvedValue(undefined),
    setStageLayout: vi.fn(),
  } as unknown as SceneController;
}

describe("scene tools", () => {
  it("executes fixed stage layouts", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("setStageLayout", { layout: "medium-left" }))
      .resolves.toEqual({ ok: true, layout: "medium-left" });
    expect(scene.setStageLayout).toHaveBeenCalledWith("medium-left");
  });

  it("rejects arbitrary layout coordinates and unknown expressions", async () => {
    const registry = createSceneToolRegistry(fakeScene(), vi.fn());
    await expect(registry.execute("setStageLayout", { layout: { x: 10, scale: 99 } }))
      .rejects.toThrow();
    await expect(registry.execute("setExpression", { expression: "custom-file" }))
      .rejects.toThrow();
  });
});
