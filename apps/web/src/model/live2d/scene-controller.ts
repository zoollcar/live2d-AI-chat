import type { StageLayoutId } from "@live2d-chat/shared";
import { MotionPriority, type InternalModel, type Live2DModel } from "pixi-live2d-display-lipsyncpatch";
import type { Application, ICanvas } from "pixi.js";
import {
  decorationIds,
  live2dCatalog,
  type ActionId,
  type DecorationId,
  type SceneSnapshot,
  type StateId,
} from "./catalog";

interface CubismCoreModel {
  setParameterValueById(id: string, value: number, weight?: number): void;
}

interface InternalModelEvents {
  on(event: "beforeModelUpdate", listener: () => void): void;
  off(event: "beforeModelUpdate", listener: () => void): void;
}

interface InternalModelEyeBlink {
  eyeBlink?: unknown;
}

interface MotionManagerEvents {
  on?(event: "motionFinish", listener: () => void): void;
  off?(event: "motionFinish", listener: () => void): void;
}

interface QueuedAction {
  id: ActionId;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const stateParameterDefaults = [
  { id: "Param31", value: 0 },
  { id: "ParamEyeBallX", value: 0 },
  { id: "ParamEyeBallY", value: 0 },
] as const;

const layoutTransitionDuration = 750;
const layoutEasing = [0.4, 0, 0.2, 1] as const;

const blinkCloseMs = 100;
const blinkHoldMs = 50;
const blinkOpenMs = 150;

type BlinkPhase = "open" | "closing" | "closed" | "opening";

interface ModelTransform {
  x: number;
  y: number;
  scale: number;
}

export class SceneController {
  private readonly naturalWidth: number;
  private readonly naturalHeight: number;
  private snapshotValue: SceneSnapshot;
  private playbackGeneration = 0;
  private currentActionGeneration = 0;
  private layoutAnimationFrame?: number;
  private layoutGeneration = 0;
  private disposed = false;
  private actionQueue: QueuedAction[] = [];
  private actionQueueDraining = false;
  private cancelActiveAction?: () => void;

  private blinkPhase: BlinkPhase = "open";
  private blinkPhaseStartMs = performance.now();
  private nextBlinkAtMs = performance.now() + 4000;

  private readonly applyPerFrame = () => {
    if (this.disposed) return;
    const coreModel = this.model.internalModel.coreModel as CubismCoreModel;
    // Persistent decoration/state values are synchronized when their setters
    // run. Only animation that genuinely changes over time belongs here.
    this.applyBlink(coreModel);
  };

  constructor(
    private readonly app: Application<ICanvas>,
    private readonly model: Live2DModel<InternalModel>,
  ) {
    this.naturalWidth = model.width;
    this.naturalHeight = model.height;
    this.snapshotValue = {
      modelId: live2dCatalog.id,
      state: "neutral",
      decorations: [],
      layout: "full-body-center",
      viewport: { width: app.screen.width, height: app.screen.height },
    };
    this.nextBlinkAtMs = performance.now() + this.randomBlinkInterval();
    // Disable SDK auto-blink; we drive blinks ourselves in applyPerFrame.
    (this.model.internalModel as unknown as InternalModelEyeBlink).eyeBlink = undefined;
    (this.model.internalModel as unknown as InternalModelEvents).on("beforeModelUpdate", this.applyPerFrame);
    this.applyLayoutImmediately();
    this.applyDecorations();
    void this.setState("neutral");
  }

  snapshot(): SceneSnapshot {
    return structuredClone(this.snapshotValue);
  }

  resize(width: number, height: number) {
    this.app.renderer.resize(width, height);
    this.snapshotValue.viewport = { width, height };
    this.applyLayoutImmediately();
  }

  setDecorations(ids: readonly DecorationId[]): DecorationId[] {
    if (new Set(ids).size !== ids.length) {
      throw new Error("Decorations must not contain duplicates.");
    }
    if (ids.includes("ponytail") && ids.includes("hair-down")) {
      throw new Error("ponytail and hair-down cannot be enabled together.");
    }
    const canonical = decorationIds.filter((id) => ids.includes(id));
    this.snapshotValue.decorations = [...canonical];
    this.applyDecorations();
    return [...canonical];
  }

  /**
   * Public entry kept for backward compatibility. Defaults to plain enqueue;
   * the agent runtime decides when to call {@link preemptAndEnqueueAction}.
   */
  async performAction(id: ActionId): Promise<void> {
    await this.enqueueAction(id);
  }

  /** Queue an action without preempting the current batch. */
  enqueueAction(id: ActionId): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.actionQueue.push({ id, resolve, reject });
      if (!this.actionQueueDraining) void this.drain();
    });
  }

  /**
   * Preempt any pending/queued actions, bump the action generation, and queue
   * the new action. Use this when a new assistant message starts and the LLM
   * has called performAction — that signals the old batch should be discarded.
   */
  preemptAndEnqueueAction(id: ActionId): Promise<void> {
    this.discardQueuedActions();
    ++this.currentActionGeneration;
    this.cancelActiveAction?.();
    return this.enqueueAction(id);
  }

  async setState(id: StateId): Promise<void> {
    if (this.disposed) return;
    const state = live2dCatalog.states[id];

    // Cancelling the action queue ensures queued one-shot actions do not
    // interrupt a deliberate state change. Generation bump invalidates any
    // in-flight action's onFinish callback.
    this.discardQueuedActions();
    ++this.currentActionGeneration;
    this.cancelActiveAction?.();
    delete this.snapshotValue.action;
    // Reset blink timer so a state change does not immediately blink.
    this.snapshotValue.state = id;
    this.nextBlinkAtMs = performance.now() + this.randomBlinkInterval();

    const expressionManager = this.model.internalModel.motionManager.expressionManager;
    expressionManager?.resetExpression();
    if (state.expression === undefined) {
      // The reset above is the complete expression for neutral/sleeping.
    } else {
      await this.model.expression(state.expression);
    }
    this.restoreStateLoop();
    this.applyStateParameters();
  }

  setStageLayout(id: StageLayoutId) {
    this.snapshotValue.layout = id;
    this.animateLayout();
  }

  async speakAudio(blob: Blob, signal?: AbortSignal): Promise<void> {
    const generation = this.beginSpeech();
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          ++this.playbackGeneration;
          this.model.stopSpeaking();
          this.restoreStateLoop();
          reject(new DOMException("Speech was cancelled", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        // Speech now only drives lipsync via model.speak(). It does NOT
        // preempt the action queue — actions and speech coexist.
        this.model.speak(url, {
          volume: 1,
          crossOrigin: "anonymous",
          onFinish: () => {
            signal?.removeEventListener("abort", abort);
            this.finishSpeech(generation);
            resolve();
          },
          onError: (error) => {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        });
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  startNativeSpeech() {
    this.beginSpeech();
    // Native browser TTS plays audio externally; we only need the lipsync hook.
    // Body motion is provided by the current state loop.
  }

  stopSpeech() {
    if (this.disposed) return;
    ++this.playbackGeneration;
    delete this.snapshotValue.action;
    this.model.stopSpeaking();
    this.restoreStateLoop();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.discardQueuedActions();
    ++this.playbackGeneration;
    ++this.currentActionGeneration;
    this.cancelActiveAction?.();
    this.cancelLayoutAnimation();
    (this.model.internalModel as unknown as InternalModelEvents).off("beforeModelUpdate", this.applyPerFrame);
  }

  private async drain(): Promise<void> {
    this.actionQueueDraining = true;
    try {
      while (!this.disposed && this.actionQueue.length > 0) {
        const next = this.actionQueue.shift()!;
        try {
          await this.runAction(next.id);
          next.resolve();
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.actionQueueDraining = false;
    }
  }

  private runAction(id: ActionId): Promise<void> {
    const gen = ++this.currentActionGeneration;
    const action = live2dCatalog.actions[id];
    this.snapshotValue.action = id;
    const motionManager = this.model.internalModel.motionManager as unknown as MotionManagerEvents;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        motionManager.off?.("motionFinish", finish);
        if (this.cancelActiveAction === cancel) this.cancelActiveAction = undefined;
        const stale = this.disposed || gen !== this.currentActionGeneration;
        if (!stale) {
          delete this.snapshotValue.action;
          this.restoreStateLoop();
        }
        if (error) reject(error);
        else resolve();
      };
      const finish = () => settle();
      const cancel = () => settle();

      this.cancelActiveAction = cancel;
      motionManager.on?.("motionFinish", finish);
      void this.model
        .motion(action.group, action.index, MotionPriority.FORCE, {
          resetExpression: false,
          // Keep the callback for compatible SDK builds. The installed
          // lipsync patch currently drops this argument for motions without
          // audio, so motionFinish above is the authoritative completion path.
          onFinish: finish,
        })
        .then((started) => {
          if (!started) {
            settle(new Error(`Unable to start Live2D action: ${id}`));
          }
        })
        .catch(settle);
    });
  }

  private discardQueuedActions(): void {
    for (const queued of this.actionQueue.splice(0)) queued.resolve();
  }

  private applyDecorations(): void {
    if (this.disposed) return;
    const coreModel = this.model.internalModel.coreModel as CubismCoreModel;
    for (const decoration of Object.values(live2dCatalog.decorations)) {
      coreModel.setParameterValueById(decoration.parameter, decoration.offValue);
    }
    for (const id of this.snapshotValue.decorations) {
      const decoration = live2dCatalog.decorations[id];
      coreModel.setParameterValueById(decoration.parameter, decoration.value);
    }
  }

  private applyStateParameters(): void {
    if (this.disposed) return;
    const coreModel = this.model.internalModel.coreModel as CubismCoreModel;
    // Reset every parameter owned by a state before applying the new profile,
    // so gaze and blush values cannot leak from the previous state.
    for (const parameter of stateParameterDefaults) {
      coreModel.setParameterValueById(parameter.id, parameter.value);
    }
    const state = live2dCatalog.states[this.snapshotValue.state];
    for (const parameter of state.parameters) {
      coreModel.setParameterValueById(parameter.id, parameter.value);
    }
  }

  private applyBlink(coreModel: CubismCoreModel): void {
    const now = performance.now();
    const [minI, maxI] = live2dCatalog.states[this.snapshotValue.state].blinkInterval;
    if (minI === 0 && maxI === 0) return; // state disables blinking (e.g. sleeping)

    if (this.snapshotValue.action === "wink" || this.snapshotValue.action === "think") {
      // Gestures that already control eye params; do not overwrite.
      return;
    }

    if (this.blinkPhase === "open") {
      if (now >= this.nextBlinkAtMs) {
        this.blinkPhase = "closing";
        this.blinkPhaseStartMs = now;
      } else {
        coreModel.setParameterValueById("ParamEyeLOpen", 1);
        coreModel.setParameterValueById("ParamEyeROpen", 1);
        return;
      }
    }

    const elapsed = now - this.blinkPhaseStartMs;
    let v = 1;
    switch (this.blinkPhase) {
      case "closing": {
        v = 1 - Math.min(elapsed / blinkCloseMs, 1);
        if (elapsed >= blinkCloseMs) {
          this.blinkPhase = "closed";
          this.blinkPhaseStartMs = now;
          v = 0;
        }
        break;
      }
      case "closed": {
        v = 0;
        if (elapsed >= blinkHoldMs) {
          this.blinkPhase = "opening";
          this.blinkPhaseStartMs = now;
        }
        break;
      }
      case "opening": {
        v = Math.min(elapsed / blinkOpenMs, 1);
        if (elapsed >= blinkOpenMs) {
          this.blinkPhase = "open";
          this.blinkPhaseStartMs = now;
          this.nextBlinkAtMs = now + this.randomBlinkInterval();
          v = 1;
        }
        break;
      }
    }
    coreModel.setParameterValueById("ParamEyeLOpen", v);
    coreModel.setParameterValueById("ParamEyeROpen", v);
  }

  private randomBlinkInterval(): number {
    const [min, max] = live2dCatalog.states[this.snapshotValue.state].blinkInterval;
    if (min === 0 && max === 0) return 0;
    // Weighted distribution: 30% short, 50% medium, 20% long — avoids a mechanical feel.
    const r = Math.random();
    const mid = (min + max) / 2;
    if (r < 0.3) return min + Math.random() * (mid - min) * 0.6;
    if (r < 0.8) return min + Math.random() * (max - min) * 0.7;
    return mid + Math.random() * (max - mid);
  }

  private restoreStateLoop(): void {
    if (this.disposed) return;
    const state = live2dCatalog.states[this.snapshotValue.state];
    void this.model.motion(state.motionGroup, state.motionIndex, MotionPriority.FORCE, {
      resetExpression: false,
    });
  }

  private calculateLayout(): ModelTransform {
    const { width, height } = this.snapshotValue.viewport;
    const layout = this.snapshotValue.layout;
    const verticalOffset = layout === "half-body-left" || layout === "half-body-right"
      ? height * 0.2
      : 0;

    if (layout === "full-body-center") {
      const scale = Math.min(
        (height * 0.9) / this.naturalHeight,
        (width * 1.35) / this.naturalWidth,
      );
      return {
        scale,
        x: (width - this.naturalWidth * scale) / 2,
        y: height - this.naturalHeight * scale * 0.94 + verticalOffset,
      };
    }

    const scale = (height * 1.28) / this.naturalHeight;
    const centerX = layout === "half-body-left"
      ? width * 0.2
      : layout === "half-body-right"
        ? width * 0.8
        : width * 0.5;
    return {
      scale,
      x: centerX - (this.naturalWidth * scale) / 2,
      y: height * 0.1 + verticalOffset,
    };
  }

  private applyLayoutImmediately() {
    this.cancelLayoutAnimation();
    this.applyTransform(this.calculateLayout());
  }

  private animateLayout() {
    this.cancelLayoutAnimation();
    const generation = ++this.layoutGeneration;
    const from = { x: this.model.x, y: this.model.y, scale: this.model.scale.x };
    const to = this.calculateLayout();
    const startedAt = performance.now();

    const update = (now: number) => {
      if (this.disposed || generation !== this.layoutGeneration) return;
      const progress = Math.min((now - startedAt) / layoutTransitionDuration, 1);
      const eased = cubicBezier(progress, ...layoutEasing);
      this.applyTransform({
        x: interpolate(from.x, to.x, eased),
        y: interpolate(from.y, to.y, eased),
        scale: interpolate(from.scale, to.scale, eased),
      });
      if (progress < 1) this.layoutAnimationFrame = requestAnimationFrame(update);
      else this.layoutAnimationFrame = undefined;
    };

    this.layoutAnimationFrame = requestAnimationFrame(update);
  }

  private cancelLayoutAnimation() {
    ++this.layoutGeneration;
    if (this.layoutAnimationFrame !== undefined) cancelAnimationFrame(this.layoutAnimationFrame);
    this.layoutAnimationFrame = undefined;
  }

  private applyTransform(transform: ModelTransform) {
    this.model.scale.set(transform.scale);
    this.model.x = transform.x;
    this.model.y = transform.y;
  }

  private beginSpeech() {
    const generation = ++this.playbackGeneration;
    delete this.snapshotValue.action;
    return generation;
  }

  private finishSpeech(generation: number) {
    if (this.disposed || generation !== this.playbackGeneration) return;
    this.restoreStateLoop();
  }
}

function interpolate(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}

function cubicBezier(progress: number, x1: number, y1: number, x2: number, y2: number) {
  if (progress <= 0 || progress >= 1) return progress;
  const sample = (t: number, a1: number, a2: number) => {
    const inverse = 1 - t;
    return 3 * inverse * inverse * t * a1 + 3 * inverse * t * t * a2 + t * t * t;
  };
  const slope = (t: number, a1: number, a2: number) =>
    3 * (1 - t) * (1 - t) * a1 + 6 * (1 - t) * t * (a2 - a1) + 3 * t * t * (1 - a2);

  let t = progress;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    const currentSlope = slope(t, x1, x2);
    if (Math.abs(currentSlope) < 1e-6) break;
    t -= (sample(t, x1, x2) - progress) / currentSlope;
    t = Math.min(Math.max(t, 0), 1);
  }
  return sample(t, y1, y2);
}
