import type { StageLayoutId } from "@live2d-chat/shared";

export const live2dCatalog = {
  id: "ice-girl",
  name: "Default Model",
  source: "/models/ice-girl/model.model3.json",
  moods: {
    happy: "Happy",
    angry: "生气",
    confused: "疑惑",
    sad: "流泪",
    surprised: "惊讶",
    excited: "星星眼",
    affectionate: "爱心眼",
    skeptical: "白眼",
    playful: "舌头",
  },
  actions: {
    wink: { group: "Action", index: 0 },
    wave: { group: "Action", index: 1 },
    think: { group: "Action", index: 2 },
  },
  decorations: {
    none: undefined,
    "cat-ears": { parameter: "Param53", value: 1 },
    crown: { parameter: "Param40", value: 1 },
    wings: { parameter: "Param41", value: 1 },
    gamepad: { parameter: "ShouBing", value: 1 },
    livestream: { parameter: "JiaJu", value: 1 },
    ponytail: { parameter: "Param51", value: 1 },
    "hair-down": { parameter: "Param51", value: 2 },
  },
  states: {
    idle: {
      motionGroup: "Idle",
      motionIndex: 0,
      expression: undefined,
      parameters: [] as const,
      blinkInterval: [2000, 6000] as const,
    },
    thinking: {
      motionGroup: undefined,
      motionIndex: 0,
      expression: "疑惑",
      parameters: [{ id: "ParamEyeBallX", value: -0.4 }] as const,
      blinkInterval: [2500, 7000] as const,
    },
    sleeping: {
      motionGroup: undefined,
      motionIndex: 0,
      expression: undefined,
      parameters: [
        { id: "ParamEyeLOpen", value: 0 },
        { id: "ParamEyeROpen", value: 0 },
      ] as const,
      blinkInterval: [0, 0] as const,
    },
  },
} as const;

export type MoodId = "neutral" | keyof typeof live2dCatalog.moods;
export type DecorationId = keyof typeof live2dCatalog.decorations;
export type ActionId = keyof typeof live2dCatalog.actions;
export type StateId = keyof typeof live2dCatalog.states;

export interface SceneSnapshot {
  modelId: typeof live2dCatalog.id;
  mood: MoodId;
  decoration: DecorationId;
  state: StateId;
  action?: ActionId;
  layout: StageLayoutId;
  viewport: { width: number; height: number };
}

export interface VisionContextProvider {
  describeScene(snapshot: SceneSnapshot, signal?: AbortSignal): Promise<string | undefined>;
}
