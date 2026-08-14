import { stageLayoutIds } from "@live2d-chat/shared";
import { tool } from "ai";
import { z } from "zod";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { AgentEvent } from "./types";

const expressionIds = [
  "wink", "smirk-left", "surprised", "gamepad", "hair-down", "star-eyes",
  "smirk-right", "tears", "heart-eyes", "cat-ears", "crown", "angry",
  "confused", "eye-roll", "blush", "tongue",
] as const;
const actionIds = ["wave", "flirt"] as const;
const poseIds = ["neutral", "attentive", "playful"] as const;

export type ToolExecutor = (name: string, input: unknown) => Promise<unknown>;

export function createSceneToolRegistry(scene: SceneController, emit: (event: AgentEvent) => void) {
  const execute: ToolExecutor = async (name, input) => {
    emit({ type: "tool-call", name, input });
    let output: unknown;
    if (name === "setExpression") {
      const { expression } = z.object({ expression: z.enum(expressionIds) }).parse(input);
      await scene.setExpression(expression);
      output = { ok: true, expression };
    } else if (name === "performAction") {
      const { action } = z.object({ action: z.enum(actionIds) }).parse(input);
      await scene.performAction(action);
      output = { ok: true, action };
    } else if (name === "setPose") {
      const { pose } = z.object({ pose: z.enum(poseIds) }).parse(input);
      await scene.setPose(pose);
      output = { ok: true, pose };
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
    setExpression: tool({
      description: "Change the Live2D character's facial expression.",
      inputSchema: z.object({ expression: z.enum(expressionIds) }),
      execute: (input) => execute("setExpression", input),
    }),
    performAction: tool({
      description: "Make the Live2D character perform a visible action.",
      inputSchema: z.object({ action: z.enum(actionIds) }),
      execute: (input) => execute("performAction", input),
    }),
    setPose: tool({
      description: "Choose a curated pose for the Live2D character.",
      inputSchema: z.object({ pose: z.enum(poseIds) }),
      execute: (input) => execute("setPose", input),
    }),
    setStageLayout: tool({
      description: "Choose a safe preset position and size for the character on stage.",
      inputSchema: z.object({ layout: z.enum(stageLayoutIds) }),
      execute: (input) => execute("setStageLayout", input),
    }),
  };

  const wllamaTools = [
    functionTool("setExpression", "Change the character's expression.", "expression", expressionIds),
    functionTool("performAction", "Perform a character action.", "action", actionIds),
    functionTool("setPose", "Select a curated character pose.", "pose", poseIds),
    functionTool("setStageLayout", "Select a safe stage layout.", "layout", [...stageLayoutIds]),
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
