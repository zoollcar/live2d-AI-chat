// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { ActionDiscardedError, SceneController } from "./scene-controller";

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
  // The constructor synchronizes the initial decorations and neutral state.
  // Clear those writes so each test starts from a clean mock call history.
  model.motion.mockClear();
  coreModel.setParameterValueById.mockClear();
  return { controller, coreModel, expressionManager, listeners, model };
}

async function flushMicrotasks(times = 8) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("SceneController visual state", () => {
  it("starts neutral with no decorations and applies complete states", async () => {
    const { controller, expressionManager, model } = createHarness();
    expect(controller.snapshot()).toMatchObject({ state: "neutral", decorations: [] });
    expressionManager.resetExpression.mockClear();
    await controller.setState("happy");
    expect(model.expression).toHaveBeenCalledWith("Happy");
    await controller.setState("neutral");
    expect(expressionManager.resetExpression).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().state).toBe("neutral");
  });

  it("applies decorations only when the selection changes", () => {
    const { controller, coreModel, listeners } = createHarness();
    controller.setDecorations(["crown", "cat-ears"]);
    expect(coreModel.setParameterValueById).toHaveBeenCalledWith("Param53", 1);
    expect(coreModel.setParameterValueById).toHaveBeenCalledWith("Param40", 0);
    expect(coreModel.setParameterValueById).toHaveBeenCalledWith("Param51", 0);
    coreModel.setParameterValueById.mockClear();
    listeners.get("beforeModelUpdate")?.();
    const persistentCalls = coreModel.setParameterValueById.mock.calls.filter(
      ([id]) => id !== "ParamEyeLOpen" && id !== "ParamEyeROpen",
    );
    expect(persistentCalls).toHaveLength(0);
    expect(controller.snapshot().decorations).toEqual(["cat-ears", "crown"]);
  });

  it("increments the layout revision for every layout request", () => {
    const { controller } = createHarness();
    expect(controller.snapshot()).toMatchObject({ layout: "full-body-center", layoutRevision: 0 });

    controller.setStageLayout("half-body-left");
    const automaticRevision = controller.snapshot().layoutRevision;
    expect(automaticRevision).toBe(1);

    controller.setStageLayout("full-body-center");
    controller.setStageLayout("half-body-left");
    expect(controller.snapshot()).toMatchObject({
      layout: "half-body-left",
      layoutRevision: automaticRevision + 2,
    });
  });

  it("queues performAction calls in one batch and plays them sequentially", async () => {
    const { controller, model } = createHarness();
    // Two performActions enqueued in the same batch — neither awaits.
    controller.enqueueAction("wink");
    controller.enqueueAction("wave");
    await flushMicrotasks();
    // First call: wink.
    const actionCalls = () => model.motion.mock.calls.filter((call) => call[0] === "Action");
    expect(actionCalls()[0]![1]).toBe(0); // wink index
    expect(actionCalls()[0]![2]).toBe(3); // MotionPriority.FORCE
    // Fire wink's onFinish; restoreStateLoop is invoked, then drain advances.
    model.motion.mock.calls[0]![3].onFinish();
    await flushMicrotasks();
    // After advancing, the next Action call should be wave (index 1).
    expect(actionCalls()[1]![1]).toBe(1); // wave
  });

  it("restores the state loop after a one-shot action finishes", async () => {
    const { controller, model } = createHarness();
    model.motion.mockClear();
    controller.enqueueAction("think");
    await flushMicrotasks();
    model.motion.mock.calls[0]![3].onFinish();
    await flushMicrotasks();
    // After action completes, restoreStateLoop() restarts the current state.
    expect(model.motion).toHaveBeenLastCalledWith("StateNeutral", 0, 3, { resetExpression: false });
  });

  it("preempts pending actions when preemptAndEnqueueAction is called", async () => {
    const { controller, model } = createHarness();
    controller.enqueueAction("wink");
    await flushMicrotasks();
    // The previous action is still playing (we have not fired onFinish).
    controller.preemptAndEnqueueAction("wave");
    // Fire the old wink onFinish — its onFinish becomes a no-op due to the
    // generation bump, but restoreStateLoop() is still called.
    model.motion.mock.calls[0]![3].onFinish();
    await flushMicrotasks();
    const actionCalls = model.motion.mock.calls.filter((call) => call[0] === "Action");
    expect(actionCalls.length).toBe(2); // wink (initial) + wave (after preempt)
    expect(actionCalls[1]![1]).toBe(1); // wave index
    expect(controller.snapshot().action).toBe("wave");
  });

  it("rejects queued actions discarded by a new batch", async () => {
    const { controller, model } = createHarness();
    const inFlight = controller.enqueueAction("wink");
    const queued = controller.enqueueAction("think");
    await flushMicrotasks();

    const replacement = controller.preemptAndEnqueueAction("wave");

    await expect(queued).rejects.toBeInstanceOf(ActionDiscardedError);
    await expect(inFlight).resolves.toBeUndefined();
    model.motion.mock.calls[1]![3].onFinish();
    await expect(replacement).resolves.toBeUndefined();
  });

  it("switching state clears the action queue and runs the state's expression", async () => {
    const { controller, model, expressionManager } = createHarness();
    expressionManager.resetExpression.mockClear();
    controller.enqueueAction("wink");
    await flushMicrotasks();
    await controller.setState("thinking");
    // The old wink's onFinish becomes a no-op due to generation bump.
    model.motion.mock.calls[0]![3].onFinish();
    await flushMicrotasks();
    const actionCalls = model.motion.mock.calls.filter((call) => call[0] === "Action");
    expect(actionCalls).toHaveLength(1);
    // The state's expression "疑惑" should have been applied.
    expect(model.expression).toHaveBeenCalledWith("疑惑");
    expect(expressionManager.resetExpression).toHaveBeenCalledOnce();
    expect(controller.snapshot().state).toBe("thinking");
    expect(controller.snapshot().action).toBeUndefined();
  });

  it("closes both eyes when entering the sleeping state", () => {
    const { controller, coreModel, listeners } = createHarness();
    coreModel.setParameterValueById.mockClear();
    void controller.setState("sleeping");
    listeners.get("beforeModelUpdate")?.();
    const leftCalls = coreModel.setParameterValueById.mock.calls.filter((c) => c[0] === "ParamEyeLOpen");
    const rightCalls = coreModel.setParameterValueById.mock.calls.filter((c) => c[0] === "ParamEyeROpen");
    expect(leftCalls[leftCalls.length - 1]![1]).toBe(0);
    expect(rightCalls[rightCalls.length - 1]![1]).toBe(0);
  });

  it("preserves state and decorations after audio speech without preemption", async () => {
    const { controller, model } = createHarness();
    await controller.setState("angry");
    controller.setDecorations(["crown"]);
    await controller.speakAudio(new Blob(["audio"]));
    expect(controller.snapshot()).toMatchObject({ state: "angry", decorations: ["crown"] });
    // speakAudio no longer calls model.motion("Speak", …) — it relies solely
    // on model.speak() for lipsync. The body's motion comes from the state loop.
    const speakMotionCalls = model.motion.mock.calls.filter((c) => c[0] === "Speak");
    expect(speakMotionCalls).toHaveLength(0);
  });

  it("drives and clears the mouth from streaming output levels", () => {
    const { controller, coreModel, listeners } = createHarness();
    controller.beginStreamingSpeech();
    controller.setStreamingSpeechLevel(1.5);
    listeners.get("beforeModelUpdate")?.();
    expect(coreModel.setParameterValueById).toHaveBeenLastCalledWith("ParamMouthOpenY", 1);

    controller.setStreamingSpeechLevel(0.35);
    // Realtime providers emit many audio chunks. Repeated begin calls must not
    // reset the current analyser envelope between adjacent chunks.
    controller.beginStreamingSpeech();
    listeners.get("beforeModelUpdate")?.();
    expect(coreModel.setParameterValueById).toHaveBeenLastCalledWith("ParamMouthOpenY", 0.35);

    controller.endStreamingSpeech();
    expect(coreModel.setParameterValueById).toHaveBeenLastCalledWith("ParamMouthOpenY", 0);
    coreModel.setParameterValueById.mockClear();
    listeners.get("beforeModelUpdate")?.();
    expect(coreModel.setParameterValueById).not.toHaveBeenCalledWith("ParamMouthOpenY", expect.anything());
  });

  it("closes a streaming mouth when speech is stopped or the scene is disposed", () => {
    const { controller, coreModel, model } = createHarness();
    controller.beginStreamingSpeech();
    controller.setStreamingSpeechLevel(0.8);
    controller.stopSpeech();
    expect(coreModel.setParameterValueById).toHaveBeenLastCalledWith("ParamMouthOpenY", 0);
    expect(model.stopSpeaking).toHaveBeenCalledOnce();

    controller.beginStreamingSpeech();
    controller.dispose();
    expect(coreModel.setParameterValueById).toHaveBeenLastCalledWith("ParamMouthOpenY", 0);
  });

  it("unsubscribes its model hook when disposed", () => {
    const { controller, model } = createHarness();
    controller.dispose();
    expect(model.internalModel.off).toHaveBeenCalledWith("beforeModelUpdate", expect.any(Function));
  });
});
