import { stageLayoutIds } from "@live2d-chat/shared";
import { tool } from "ai";
import { z } from "zod";
import { decorationIds, stateIds } from "@/model/live2d/catalog";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { AgentEvent } from "./types";

const actionIds = ["wink", "wave", "think"] as const;

const decorationsSchema = z.array(z.enum(decorationIds)).superRefine((decorations, context) => {
  if (new Set(decorations).size !== decorations.length) {
    context.addIssue({ code: "custom", message: "Decorations must not contain duplicates." });
  }
  if (decorations.includes("ponytail") && decorations.includes("hair-down")) {
    context.addIssue({ code: "custom", message: "ponytail and hair-down cannot be enabled together." });
  }
});

export type ToolExecutor = (name: string, input: unknown) => Promise<unknown>;

export function createSceneToolRegistry(scene: SceneController, emit: (event: AgentEvent) => void) {
  let batchFirstAction = true;
  let executionTail = Promise.resolve();

  const executeNow: ToolExecutor = async (name, input) => {
    emit({ type: "tool-call", name, input });
    let output: unknown;
    if (name === "setState") {
      const { state } = z.object({ state: z.enum(stateIds) }).parse(input);
      await scene.setState(state);
      output = { ok: true, state };
    } else if (name === "setDecorations") {
      const { decorations } = z.object({ decorations: decorationsSchema }).parse(input);
      const applied = scene.setDecorations(decorations);
      output = { ok: true, decorations: applied };
    } else if (name === "performAction") {
      const { action } = z.object({ action: z.enum(actionIds) }).parse(input);
      if (batchFirstAction) {
        batchFirstAction = false;
        await scene.preemptAndEnqueueAction(action);
      } else {
        await scene.enqueueAction(action);
      }
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

  // Providers may request tools concurrently. Scene mutations are observable,
  // so preserve call order and wait for one-shot actions to really finish.
  const execute: ToolExecutor = (name, input) => {
    const result = executionTail.then(() => executeNow(name, input));
    executionTail = result.then(() => undefined, () => undefined);
    return result;
  };

  const aiTools = {
    setState: tool({
      description: "Set the character's complete persistent state. A state controls facial expression, idle movement, pose, and blink rhythm until replaced.",
      inputSchema: z.object({ state: z.enum(stateIds) }),
      execute: (input) => execute("setState", input),
    }),
    setDecorations: tool({
      description: "Replace the complete set of persistent decorations. Most decorations can be combined; ponytail and hair-down are mutually exclusive. Use an empty array to clear all decorations.",
      inputSchema: z.object({ decorations: decorationsSchema }),
      execute: (input) => execute("setDecorations", input),
    }),
    performAction: tool({
      description: "Play a one-shot gesture (wink, wave, think). Multiple calls in one assistant message play in sequence. The first call in a new message preempts actions queued by the previous message.",
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
    functionTool("setState", "Set the character's complete persistent state.", {
      state: { type: "string", enum: [...stateIds] },
    }, ["state"]),
    functionTool("setDecorations", "Replace the complete set of persistent decorations. ponytail and hair-down are mutually exclusive.", {
      decorations: { type: "array", items: { type: "string", enum: [...decorationIds] }, uniqueItems: true },
    }, ["decorations"]),
    functionTool("performAction", "Perform a one-shot character action. Multiple calls in one message play in sequence.", {
      action: { type: "string", enum: [...actionIds] },
    }, ["action"]),
    functionTool("setStageLayout", "Smoothly move and zoom to one of four VTuber stage layouts.", {
      layout: { type: "string", enum: [...stageLayoutIds] },
    }, ["layout"]),
  ];

  const resetBatch = () => {
    batchFirstAction = true;
  };

  return { aiTools, wllamaTools, execute, resetBatch };
}

function functionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: {
        type: "object" as const,
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}
