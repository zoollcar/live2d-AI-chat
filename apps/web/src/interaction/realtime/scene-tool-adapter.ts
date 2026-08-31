import { createAgentToolRegistry } from "@/agent/tools";
import type {
  AgentNetworkAccess,
  AgentResourceAccess,
  AgentToolCapabilities,
  AgentWorkspaceAccess,
} from "@/agent/tool-context";
import type { AgentEvent } from "@/agent/types";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { GoogleLiveToolAdapter } from "./types";

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
  options: {
    resources?: AgentResourceAccess;
    workspace?: AgentWorkspaceAccess;
    network?: AgentNetworkAccess;
    capabilities?: Partial<AgentToolCapabilities>;
  } = {},
): GoogleLiveToolAdapter {
  const registry = createAgentToolRegistry({
    scene,
    emit: emitAgentEvent,
    resources: options.resources,
    workspace: options.workspace,
    network: options.network,
    capabilities: options.capabilities,
  });
  const active = new Map<string, AbortController>();

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
    execute: (id, name, args) => {
      const controller = new AbortController();
      active.get(id)?.abort(cancelledToolCallError(id));
      active.set(id, controller);
      const execution = registry.execute(id, name, args, controller.signal)
        .finally(() => {
          if (active.get(id) === controller) active.delete(id);
        });
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason ?? cancelledToolCallError(id));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        void execution.then(resolve, reject).finally(() => {
          controller.signal.removeEventListener("abort", onAbort);
        });
      });
    },
    cancel: (id) => {
      active.get(id)?.abort(cancelledToolCallError(id));
    },
    resetBatch: registry.resetBatch,
  };
}
