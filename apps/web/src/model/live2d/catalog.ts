import type { StageLayoutId } from "@live2d-chat/shared";

export const live2dCatalog = {
  id: "ice-girl",
  name: "Ice Girl",
  source: "/models/ice-girl/model.model3.json",
  expressions: {
    wink: "Wink",
    "smirk-left": "←歪嘴",
    surprised: "惊讶",
    gamepad: "手柄",
    "hair-down": "披发",
    "star-eyes": "星星眼",
    "smirk-right": "歪嘴→",
    tears: "流泪",
    "heart-eyes": "爱心眼",
    "cat-ears": "猫耳",
    crown: "王冠",
    angry: "生气",
    confused: "疑惑",
    "eye-roll": "白眼",
    blush: "脸红",
    tongue: "舌头",
  },
  actions: {
    wave: { group: "Action", index: 0 },
    flirt: { group: "Action", index: 1 },
  },
  poses: {
    neutral: { group: "Idle", index: 0 },
    attentive: { group: "Idle", index: 1 },
    playful: { group: "Idle_evil", index: 0 },
  },
} as const;

export type ExpressionId = keyof typeof live2dCatalog.expressions;
export type ActionId = keyof typeof live2dCatalog.actions;
export type PoseId = keyof typeof live2dCatalog.poses;

export interface SceneSnapshot {
  modelId: typeof live2dCatalog.id;
  expression?: ExpressionId;
  action?: ActionId;
  pose: PoseId;
  layout: StageLayoutId;
  viewport: { width: number; height: number };
}

export interface VisionContextProvider {
  describeScene(snapshot: SceneSnapshot, signal?: AbortSignal): Promise<string | undefined>;
}
