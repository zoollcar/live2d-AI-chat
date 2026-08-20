import type { StageLayoutId } from "@live2d-chat/shared";

export const decorationIds = [
  "cat-ears", "crown", "wings", "gamepad", "livestream", "ponytail", "hair-down",
] as const;

export const stateIds = [
  "neutral", "happy", "angry", "confused", "sad", "surprised", "excited",
  "affectionate", "skeptical", "playful", "thinking", "sleeping",
] as const;

export const live2dCatalog = {
  id: "ice-girl",
  name: "Default Model",
  source: "/models/ice-girl/model.model3.json",
  actions: {
    wink: { group: "Action", index: 0 },
    wave: { group: "Action", index: 1 },
    think: { group: "Action", index: 2 },
  },
  decorations: {
    "cat-ears": { parameter: "Param53", offValue: 0, value: 1 },
    // These two toggles are inverted in the authored model: 0 is visible and
    // 1 is hidden. The tools expose user intent, so their runtime values are
    // deliberately the reverse of the other decoration parameters.
    crown: { parameter: "Param40", offValue: 1, value: 0 },
    wings: { parameter: "Param41", offValue: 1, value: 0 },
    gamepad: { parameter: "ShouBing", offValue: 0, value: 1 },
    livestream: { parameter: "JiaJu", offValue: 0, value: 1 },
    ponytail: { parameter: "Param51", offValue: 0, value: 1 },
    "hair-down": { parameter: "Param51", offValue: 0, value: 2 },
  },
  states: {
    neutral: state("StateNeutral", undefined, [], [2000, 6000]),
    happy: state("StateHappy", "Happy", [], [1700, 4800]),
    angry: state("StateAngry", "生气", [], [2600, 6200]),
    confused: state("StateConfused", "疑惑", [
      { id: "ParamEyeBallX", value: -0.25 },
      { id: "ParamEyeBallY", value: 0.12 },
    ], [2500, 7000]),
    sad: state("StateSad", "流泪", [], [3500, 8000]),
    surprised: state("StateSurprised", "惊讶", [], [3000, 6500]),
    excited: state("StateExcited", "星星眼", [
      { id: "Param31", value: 1 },
    ], [1400, 4000]),
    affectionate: state("StateAffectionate", "爱心眼", [], [2600, 6500]),
    skeptical: state("StateSkeptical", "白眼", [
      { id: "ParamEyeBallX", value: 0.28 },
    ], [3500, 8000]),
    playful: state("StatePlayful", "Happy", [], [1600, 4500]),
    thinking: state("StateThinking", "疑惑", [
      { id: "ParamEyeBallX", value: -0.45 },
      { id: "ParamEyeBallY", value: 0.35 },
    ], [2500, 7000]),
    sleeping: state("StateSleeping", undefined, [
      { id: "ParamEyeLOpen", value: 0 },
      { id: "ParamEyeROpen", value: 0 },
    ], [0, 0]),
  },
} as const;

function state(
  motionGroup: string,
  expression: string | undefined,
  parameters: readonly { id: string; value: number }[],
  blinkInterval: readonly [number, number],
) {
  return { motionGroup, motionIndex: 0, expression, parameters, blinkInterval } as const;
}

export type DecorationId = (typeof decorationIds)[number];
export type ActionId = keyof typeof live2dCatalog.actions;
export type StateId = (typeof stateIds)[number];

export interface SceneSnapshot {
  modelId: typeof live2dCatalog.id;
  state: StateId;
  decorations: DecorationId[];
  action?: ActionId;
  layout: StageLayoutId;
  viewport: { width: number; height: number };
}

export interface VisionContextProvider {
  describeScene(snapshot: SceneSnapshot, signal?: AbortSignal): Promise<string | undefined>;
}
