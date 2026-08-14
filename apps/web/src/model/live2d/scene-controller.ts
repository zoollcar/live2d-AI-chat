import type { StageLayoutId } from "@live2d-chat/shared";
import { MotionPriority, type InternalModel, type Live2DModel } from "pixi-live2d-display-lipsyncpatch";
import type { Application, ICanvas } from "pixi.js";
import {
  live2dCatalog,
  type ActionId,
  type ExpressionId,
  type PoseId,
  type SceneSnapshot,
} from "./catalog";

const layoutScale: Record<StageLayoutId, number> = {
  "full-body": 0.95,
  medium: 1.25,
  "close-up": 1.65,
  "medium-left": 1.25,
  "medium-right": 1.25,
};

const layoutAnchor: Record<StageLayoutId, number> = {
  "full-body": 0.5,
  medium: 0.5,
  "close-up": 0.5,
  "medium-left": 0.28,
  "medium-right": 0.72,
};

export class SceneController {
  private readonly naturalWidth: number;
  private readonly naturalHeight: number;
  private snapshotValue: SceneSnapshot;

  constructor(
    private readonly app: Application<ICanvas>,
    private readonly model: Live2DModel<InternalModel>,
  ) {
    this.naturalWidth = model.width;
    this.naturalHeight = model.height;
    this.snapshotValue = {
      modelId: live2dCatalog.id,
      pose: "neutral",
      layout: "full-body",
      viewport: { width: app.screen.width, height: app.screen.height },
    };
    this.setStageLayout("full-body");
  }

  snapshot(): SceneSnapshot {
    return structuredClone(this.snapshotValue);
  }

  resize(width: number, height: number) {
    this.app.renderer.resize(width, height);
    this.snapshotValue.viewport = { width, height };
    this.applyLayout();
  }

  async setExpression(id: ExpressionId) {
    await this.model.expression(live2dCatalog.expressions[id]);
    this.snapshotValue.expression = id;
  }

  async performAction(id: ActionId) {
    const action = live2dCatalog.actions[id];
    await this.model.motion(action.group, action.index, MotionPriority.FORCE);
    this.snapshotValue.action = id;
  }

  async setPose(id: PoseId) {
    const pose = live2dCatalog.poses[id];
    await this.model.motion(pose.group, pose.index, MotionPriority.FORCE);
    this.snapshotValue.pose = id;
  }

  setStageLayout(id: StageLayoutId) {
    this.snapshotValue.layout = id;
    this.applyLayout();
  }

  async speakAudio(blob: Blob, signal?: AbortSignal): Promise<void> {
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          this.model.stopSpeaking();
          reject(new DOMException("Speech was cancelled", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        void this.model.motion("Speak", undefined, MotionPriority.FORCE);
        this.model.speak(url, {
          volume: 1,
          crossOrigin: "anonymous",
          onFinish: () => {
            signal?.removeEventListener("abort", abort);
            void this.model.motion("Idle");
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
    void this.model.motion("Speak", undefined, MotionPriority.FORCE);
  }

  stopSpeech() {
    this.model.stopSpeaking();
    void this.model.motion("Idle");
  }

  private applyLayout() {
    const { width, height } = this.snapshotValue.viewport;
    const scale = (height * layoutScale[this.snapshotValue.layout]) / this.naturalHeight;
    this.model.scale.set(scale);
    this.model.x = width * layoutAnchor[this.snapshotValue.layout] - (this.naturalWidth * scale) / 2;
    this.model.y = height - this.naturalHeight * scale * 0.96;
  }
}
