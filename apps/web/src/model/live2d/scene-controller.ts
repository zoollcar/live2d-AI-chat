import type { StageLayoutId } from "@live2d-chat/shared";
import { MotionPriority, type InternalModel, type Live2DModel } from "pixi-live2d-display-lipsyncpatch";
import type { Application, ICanvas } from "pixi.js";
import {
  live2dCatalog,
  type ActionId,
  type DecorationId,
  type MoodId,
  type SceneSnapshot,
} from "./catalog";

interface CubismCoreModel {
  setParameterValueById(id: string, value: number, weight?: number): void;
}

interface InternalModelEvents {
  on(event: "beforeModelUpdate", listener: () => void): void;
  off(event: "beforeModelUpdate", listener: () => void): void;
}

const decorationParameters = ["Param53", "Param40", "Param41", "ShouBing", "JiaJu", "Param51"] as const;

const layoutTransitionDuration = 750;
const layoutEasing = [0.4, 0, 0.2, 1] as const;

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
  private layoutAnimationFrame?: number;
  private layoutGeneration = 0;
  private disposed = false;
  private readonly applyDecoration = () => {
    const coreModel = this.model.internalModel.coreModel as CubismCoreModel;
    for (const parameter of decorationParameters) coreModel.setParameterValueById(parameter, 0);
    const decoration = live2dCatalog.decorations[this.snapshotValue.decoration];
    if (decoration) coreModel.setParameterValueById(decoration.parameter, decoration.value);
  };

  constructor(
    private readonly app: Application<ICanvas>,
    private readonly model: Live2DModel<InternalModel>,
  ) {
    this.naturalWidth = model.width;
    this.naturalHeight = model.height;
    this.snapshotValue = {
      modelId: live2dCatalog.id,
      mood: "neutral",
      decoration: "none",
      layout: "full-body-center",
      viewport: { width: app.screen.width, height: app.screen.height },
    };
    (this.model.internalModel as unknown as InternalModelEvents).on("beforeModelUpdate", this.applyDecoration);
    this.applyLayoutImmediately();
    void this.startIdle(MotionPriority.IDLE);
  }

  snapshot(): SceneSnapshot {
    return structuredClone(this.snapshotValue);
  }

  resize(width: number, height: number) {
    this.app.renderer.resize(width, height);
    this.snapshotValue.viewport = { width, height };
    this.applyLayoutImmediately();
  }

  async setMood(id: MoodId) {
    if (id === "neutral") {
      this.model.internalModel.motionManager.expressionManager?.resetExpression();
    } else {
      await this.model.expression(live2dCatalog.moods[id]);
    }
    this.snapshotValue.mood = id;
  }

  setDecoration(id: DecorationId) {
    this.snapshotValue.decoration = id;
    this.applyDecoration();
  }

  async performAction(id: ActionId) {
    const generation = ++this.playbackGeneration;
    const action = live2dCatalog.actions[id];
    this.snapshotValue.action = id;
    const started = await this.model.motion(action.group, action.index, MotionPriority.FORCE, {
      resetExpression: false,
      onFinish: () => {
        if (this.disposed || generation !== this.playbackGeneration) return;
        delete this.snapshotValue.action;
        queueMicrotask(() => void this.startIdle(MotionPriority.IDLE));
      },
    });
    if (!started && generation === this.playbackGeneration) {
      delete this.snapshotValue.action;
      throw new Error(`Unable to start Live2D action: ${id}`);
    }
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
          void this.startIdle(MotionPriority.FORCE);
          reject(new DOMException("Speech was cancelled", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        void this.model.motion("Speak", 0, MotionPriority.FORCE, { resetExpression: false });
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
    void this.model.motion("Speak", 0, MotionPriority.FORCE, { resetExpression: false });
  }

  stopSpeech() {
    if (this.disposed) return;
    ++this.playbackGeneration;
    delete this.snapshotValue.action;
    this.model.stopSpeaking();
    void this.startIdle(MotionPriority.FORCE);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.playbackGeneration;
    this.cancelLayoutAnimation();
    (this.model.internalModel as unknown as InternalModelEvents).off("beforeModelUpdate", this.applyDecoration);
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
    void this.startIdle(MotionPriority.FORCE);
  }

  private startIdle(priority: MotionPriority) {
    return this.model.motion("Idle", 0, priority, { resetExpression: false });
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
