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
const stateIds = ["idle", "thinking", "sleeping"] as const;

export type ToolExecutor = (name: string, input: unknown) => Promise<unknown>;

export function createSceneToolRegistry(scene: SceneController, emit: (event: AgentEvent) => void) {
  /**
   * Whether the next performAction in this assistant message is the first one.
   * The first performAction in a new assistant message preempts the previous
   * message's queued actions; subsequent ones simply enqueue so the whole
   * batch plays sequentially. Runtimes call {@link resetBatch} when a new
   * assistant message starts (local: before its tool loop; remote: on the
   * AI SDK's `start-step` stream event).
   */
  let batchFirstAction = true;
  let executionTail = Promise.resolve();

  const executeNow: ToolExecutor = async (name, input) => {
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
      if (batchFirstAction) {
        batchFirstAction = false;
        await scene.preemptAndEnqueueAction(action);
      } else {
        await scene.enqueueAction(action);
      }
      output = { ok: true, action };
    } else if (name === "setState") {
      const { state } = z.object({ state: z.enum(stateIds) }).parse(input);
      await scene.setState(state);
      output = { ok: true, state };
    } else if (name === "blink") {
      scene.blink();
      output = { ok: true };
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

  // AI SDK providers may invoke every tool in an assistant step concurrently.
  // Scene commands are order-sensitive, so preserve the model's call order and
  // wait for one-shot actions to really finish before applying the next tool.
  const execute: ToolExecutor = (name, input) => {
    const result = executionTail.then(() => executeNow(name, input));
    executionTail = result.then(() => undefined, () => undefined);
    return result;
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
      description: "Play a one-shot gesture (wink, wave, think). Multiple performAction calls in one assistant message play in sequence, each waiting for the previous to finish. The first performAction in a new assistant message preempts any actions still queued from the previous message.",
      inputSchema: z.object({ action: z.enum(actionIds) }),
      execute: (input) => execute("performAction", input),
    }),
    setState: tool({
      description: "Set the character's persistent behavioral state (idle, thinking, sleeping). The new state's looping motion plays until the next setState. Switching state clears any queued one-shot actions.",
      inputSchema: z.object({ state: z.enum(stateIds) }),
      execute: (input) => execute("setState", input),
    }),
    blink: tool({
      description: "Force a single natural blink right now. The ambient blink timer is reset afterward.",
      inputSchema: z.object({}),
      execute: (input) => execute("blink", input),
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
    functionTool("performAction", "Perform a one-shot character action. Multiple calls in one message play in sequence.", "action", actionIds),
    functionTool("setState", "Set the character's persistent behavioral state. Switching state clears queued actions.", "state", stateIds),
    functionTool("blink", "Force a single natural blink.", undefined, []),
    functionTool("setStageLayout", "Smoothly move and zoom to one of four VTuber stage layouts.", "layout", [...stageLayoutIds]),
  ];

  const resetBatch = () => {
    batchFirstAction = true;
  };

  return { aiTools, wllamaTools, execute, resetBatch };
}

function functionTool(name: string, description: string, property: string | undefined, values: readonly string[]) {
  const properties = property ? { [property]: { type: "string", enum: [...values] } } : {};
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: {
        type: "object" as const,
        properties,
        required: property ? [property] : [],
        additionalProperties: false,
      },
    },
  };
}
