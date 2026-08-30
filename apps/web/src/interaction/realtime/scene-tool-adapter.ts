import { createSceneToolRegistry } from "@/agent/tools";
import type { AgentEvent } from "@/agent/types";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { GoogleLiveToolAdapter } from "./types";

interface QueuedSceneToolCall {
  id: string;
  name: string;
  args: unknown;
  cancelled: boolean;
  resolve(output: unknown): void;
  reject(error: Error): void;
}

function cancelledToolCallError(id: string): Error {
  return new Error(`Google Live tool call ${id} was cancelled.`);
}

/**
 * Adapts the existing provider-neutral scene registry to Gemini's Live API
 * function-declaration and explicit tool-response protocol.
 */
export function createGoogleLiveSceneToolAdapter(
  scene: SceneController,
  emitAgentEvent: (event: AgentEvent) => void,
): GoogleLiveToolAdapter {
  const registry = createSceneToolRegistry(scene, emitAgentEvent);
  const queue: QueuedSceneToolCall[] = [];
  let active: QueuedSceneToolCall | undefined;

  const drain = () => {
    if (active) return;
    const next = queue.shift();
    if (!next) return;
    if (next.cancelled) {
      next.reject(cancelledToolCallError(next.id));
      drain();
      return;
    }
    active = next;
    void registry.execute(next.name, next.args)
      .then(
        (output) => {
          if (next.cancelled) next.reject(cancelledToolCallError(next.id));
          else next.resolve(output);
        },
        next.reject,
      )
      .finally(() => {
        active = undefined;
        drain();
      });
  };

  return {
    declarations: registry.wllamaTools.map(({ function: declaration }) => ({
      name: declaration.name,
      description: declaration.description,
      // The shared registry uses full JSON Schema. Gemini's `parameters`
      // field accepts only its smaller OpenAPI Schema subset, while
      // `parametersJsonSchema` accepts constraints such as
      // additionalProperties and uniqueItems.
      parametersJsonSchema: declaration.parameters,
    })),
    execute: (id, name, args) => new Promise((resolve, reject) => {
      queue.push({ id, name, args, cancelled: false, resolve, reject });
      drain();
    }),
    cancel: (id) => {
      if (active?.id === id) {
        active.cancelled = true;
        return;
      }
      const queued = queue.find((call) => call.id === id);
      if (!queued) return;
      queued.cancelled = true;
      const index = queue.indexOf(queued);
      queue.splice(index, 1);
      queued.reject(cancelledToolCallError(id));
    },
    resetBatch: registry.resetBatch,
  };
}
