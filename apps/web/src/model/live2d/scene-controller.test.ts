// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { SceneController } from "./scene-controller";

vi.mock("pixi-live2d-display-lipsyncpatch", () => ({
  MotionPriority: { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 },
}));

function createHarness() {
  const listeners = new Map<string, () => void>();
  const expressionManager = { resetExpression: vi.fn() };
  const coreModel = { setParameterValueById: vi.fn() };
  const model = {
    width: 100,
    height: 200,
    x: 0,
    y: 0,
    scale: { set: vi.fn() },
    expression: vi.fn().mockResolvedValue(true),
    motion: vi.fn().mockResolvedValue(true),
    speak: vi.fn().mockImplementation((_url, options) => {
      queueMicrotask(options.onFinish);
      return Promise.resolve(true);
    }),
    stopSpeaking: vi.fn(),
    internalModel: {
      coreModel,
      motionManager: { expressionManager },
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      off: vi.fn((event: string) => listeners.delete(event)),
    },
  };
  const app = {
    screen: { width: 800, height: 600 },
    renderer: { resize: vi.fn() },
  };
  const controller = new SceneController(app as never, model as never);
  model.motion.mockClear();
  return { controller, coreModel, expressionManager, listeners, model };
}

describe("SceneController visual state", () => {
  it("starts neutral with no decoration and controls mood independently", async () => {
    const { controller, expressionManager, model } = createHarness();
    expect(controller.snapshot()).toMatchObject({ mood: "neutral", decoration: "none" });
    await controller.setMood("happy");
    expect(model.expression).toHaveBeenCalledWith("Happy");
    await controller.setMood("neutral");
    expect(expressionManager.resetExpression).toHaveBeenCalledOnce();
    expect(controller.snapshot().mood).toBe("neutral");
  });

  it("applies exactly one decoration after model updates", () => {
    const { controller, coreModel, listeners } = createHarness();
    controller.setDecoration("cat-ears");
    coreModel.setParameterValueById.mockClear();
    listeners.get("beforeModelUpdate")?.();
    expect(coreModel.setParameterValueById).toHaveBeenCalledWith("Param53", 1);
    expect(coreModel.setParameterValueById).toHaveBeenCalledWith("Param51", 0);
    expect(controller.snapshot().decoration).toBe("cat-ears");
  });

  it("returns to idle after a one-shot action", async () => {
    const { controller, model } = createHarness();
    await controller.performAction("think");
    expect(controller.snapshot().action).toBe("think");
    const options = model.motion.mock.calls[0]![3];
    options.onFinish();
    await Promise.resolve();
    expect(controller.snapshot().action).toBeUndefined();
    expect(model.motion).toHaveBeenLastCalledWith("Idle", 0, 1, { resetExpression: false });
  });

  it("ignores completion from an action that has been replaced", async () => {
    const { controller, model } = createHarness();
    await controller.performAction("wink");
    const oldFinish = model.motion.mock.calls[0]![3].onFinish;
    await controller.performAction("wave");
    oldFinish();
    await Promise.resolve();
    expect(controller.snapshot().action).toBe("wave");
  });

  it("preserves mood and decoration after audio speech", async () => {
    const { controller, model } = createHarness();
    await controller.setMood("angry");
    controller.setDecoration("crown");
    await controller.speakAudio(new Blob(["audio"]));
    expect(controller.snapshot()).toMatchObject({ mood: "angry", decoration: "crown" });
    expect(model.motion).toHaveBeenLastCalledWith("Idle", 0, 3, { resetExpression: false });
  });

  it("unsubscribes its model hook when disposed", () => {
    const { controller, model } = createHarness();
    controller.dispose();
    expect(model.internalModel.off).toHaveBeenCalledWith("beforeModelUpdate", expect.any(Function));
  });
});
