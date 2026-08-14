import { stageLayoutIds } from "@live2d-chat/shared";
import { tool } from "ai";
import { z } from "zod";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { AgentEvent } from "./types";

const moodIds = [
  "neutral", "happy", "angry", "confused", "sad", "surprised", "excited",
  "affectionate", "skeptical", "playful",
] as const;
const decorationIds = [
  "none", "cat-ears", "crown", "wings", "gamepad", "livestream", "ponytail", "hair-down",
] as const;
const actionIds = ["wink", "wave", "think"] as const;

export type ToolExecutor = (name: string, input: unknown) => Promise<unknown>;

export function createSceneToolRegistry(scene: SceneController, emit: (event: AgentEvent) => void) {
  const execute: ToolExecutor = async (name, input) => {
    emit({ type: "tool-call", name, input });
    let output: unknown;
    if (name === "setMood") {
      const { mood } = z.object({ mood: z.enum(moodIds) }).parse(input);
      await scene.setMood(mood);
      output = { ok: true, mood };
    } else if (name === "setDecoration") {
      const { decoration } = z.object({ decoration: z.enum(decorationIds) }).parse(input);
      scene.setDecoration(decoration);
      output = { ok: true, decoration };
    } else if (name === "performAction") {
      const { action } = z.object({ action: z.enum(actionIds) }).parse(input);
      await scene.performAction(action);
      output = { ok: true, action };
    } else if (name === "setStageLayout") {
      const { layout } = z.object({ layout: z.enum(stageLayoutIds) }).parse(input);
      scene.setStageLayout(layout);
      output = { ok: true, layout };
    } else {
      throw new Error(`Unknown scene tool: ${name}`);
    }
    emit({ type: "tool-result", name, output });
    return output;
  };

  const aiTools = {
    setMood: tool({
      description: "Set the character's persistent mood. Use neutral to clear it.",
      inputSchema: z.object({ mood: z.enum(moodIds) }),
      execute: (input) => execute("setMood", input),
    }),
    setDecoration: tool({
      description: "Set one persistent character decoration independently of mood. Use none to clear it.",
      inputSchema: z.object({ decoration: z.enum(decorationIds) }),
      execute: (input) => execute("setDecoration", input),
    }),
    performAction: tool({
      description: "Make the Live2D character perform a visible action.",
      inputSchema: z.object({ action: z.enum(actionIds) }),
      execute: (input) => execute("performAction", input),
    }),
    setStageLayout: tool({
      description: "Move and zoom the character smoothly to half-body-left, half-body-right, full-body-center, or half-body-center.",
      inputSchema: z.object({ layout: z.enum(stageLayoutIds) }),
      execute: (input) => execute("setStageLayout", input),
    }),
  };

  const wllamaTools = [
    functionTool("setMood", "Set the character's persistent mood.", "mood", moodIds),
    functionTool("setDecoration", "Set or clear a persistent decoration.", "decoration", decorationIds),
    functionTool("performAction", "Perform a one-shot character action.", "action", actionIds),
    functionTool("setStageLayout", "Smoothly move and zoom to one of four VTuber stage layouts.", "layout", [...stageLayoutIds]),
  ];

  return { aiTools, wllamaTools, execute };
}

function functionTool(name: string, description: string, property: string, values: readonly string[]) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: {
        type: "object" as const,
        properties: {
          [property]: { type: "string", enum: [...values] },
        },
        required: [property],
        additionalProperties: false,
      },
    },
  };
}
