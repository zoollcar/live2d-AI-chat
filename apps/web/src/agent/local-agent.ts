import type {
  ChatCompletionMessage,
  ChatCompletionTool,
  ChatCompletionToolFunctionParameters,
  Wllama,
} from "@wllama/wllama";
import { createAgentToolRegistry } from "./tools";
import type { AgentRunOptions, AgentRuntime } from "./types";
import { downloadLocalModel, getLocalModelConfig } from "./local-models";
import {
  hasContextForNextLocalStep,
  LOCAL_CONTEXT_TOKENS,
  LOCAL_MAX_OUTPUT_TOKENS,
} from "./local-context";

// Upper bound on ReAct steps for a single user turn. Matches the remote
// runtime so the user sees "step N of M" with the same scale regardless of
// which inference backend is active.
const MAX_STEPS = 5;

interface RegistryToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Wllama deliberately accepts a narrower JSON Schema subset than the remote
 * runtimes. Validate the generated object schema at the boundary instead of
 * asserting that every arbitrary JSON Schema is compatible.
 */
function toWllamaParameters(schema: Record<string, unknown>): ChatCompletionToolFunctionParameters {
  if (schema.type !== "object" || !isRecord(schema.properties)) {
    throw new Error("Local model tools require an object JSON Schema with properties.");
  }

  const properties: ChatCompletionToolFunctionParameters["properties"] = {};
  for (const [name, value] of Object.entries(schema.properties)) {
    if (!isRecord(value) || typeof value.type !== "string") {
      throw new Error(`Local model tool property ${name} must declare a JSON Schema type.`);
    }
    const property: ChatCompletionToolFunctionParameters["properties"][string] = {
      type: value.type,
    };
    for (const [key, nestedValue] of Object.entries(value)) {
      if (key !== "description" && key !== "enum" && key !== "type") property[key] = nestedValue;
    }
    if (value.description !== undefined) {
      if (typeof value.description !== "string") {
        throw new Error(`Local model tool property ${name} has an invalid description.`);
      }
      property.description = value.description;
    }
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || !value.enum.every((item) => typeof item === "string")) {
        throw new Error(`Local model tool property ${name} has a non-string enum.`);
      }
      property.enum = value.enum;
    }
    properties[name] = property;
  }

  if (schema.required !== undefined
    && (!Array.isArray(schema.required) || !schema.required.every((item) => typeof item === "string"))) {
    throw new Error("Local model tool schema has an invalid required list.");
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    throw new Error("Local model tool schema has an unsupported additionalProperties value.");
  }

  return {
    type: "object",
    properties,
    ...(schema.required ? { required: schema.required } : {}),
    ...(schema.additionalProperties === undefined
      ? {}
      : { additionalProperties: schema.additionalProperties }),
  };
}

function toWllamaTools(definitions: readonly RegistryToolDefinition[]): ChatCompletionTool[] {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.function.name,
      description: definition.function.description,
      parameters: toWllamaParameters(definition.function.parameters),
    },
  }));
}

export class LocalAgentRuntime implements AgentRuntime {
  private engine?: Wllama;
  private loadedModelId?: string;

  async run(options: AgentRunOptions) {
    const { emit, scene, signal } = options;
    try {
      const engine = await this.getEngine(options);
      const registry = createAgentToolRegistry({
        scene,
        emit,
        resources: options.resources,
        workspace: options.workspace,
        network: options.network,
        capabilities: options.toolCapabilities,
      });
      const wllamaTools = toWllamaTools(registry.wllamaTools);
      const messages: ChatCompletionMessage[] = [...options.messages];

      for (let step = 1; step <= MAX_STEPS && !signal.aborted; step += 1) {
        // Surface the ReAct step boundary so the user can see the agent
        // is on step 2 of 5 rather than appearing to hang on a single
        // local inference (which can take many seconds on a phone).
        emit({
          type: "status",
          kind: "busy",
          message: `Reasoning (step ${step} of ${MAX_STEPS})…`,
        });
        const stream = await engine.createChatCompletion({
          messages,
          tools: wllamaTools,
          tool_choice: "auto",
          stream: true,
          max_tokens: LOCAL_MAX_OUTPUT_TOKENS,
          temperature: 0.7,
          abortSignal: signal,
        });
        let text = "";
        let finishReason: string | null = null;
        let usedTokens: number | undefined;
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          finishReason = choice.finish_reason ?? finishReason;
          usedTokens = chunk.usage?.total_tokens ?? usedTokens;
          if (choice.delta.content) {
            text += choice.delta.content;
            emit({ type: "text-delta", delta: choice.delta.content });
          }
          for (const call of choice.delta.tool_calls || []) {
            const current = calls.get(call.index) || { id: "", name: "", arguments: "" };
            current.id += call.id || "";
            current.name += call.function?.name || "";
            current.arguments += call.function?.arguments || "";
            calls.set(call.index, current);
          }
        }

        if (finishReason !== "tool_calls" || calls.size === 0) break;
        const toolCalls = [...calls.values()].map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }));
        messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
        // Reset batch tracking so the first performAction in this new
        // assistant message preempts any actions still queued from earlier.
        registry.resetBatch();
        const toolResultMessages: ChatCompletionMessage[] = [];
        for (const call of toolCalls) {
          const input = JSON.parse(call.function.arguments || "{}");
          const output = await registry.execute(call.id, call.function.name, input, signal);
          toolResultMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(output),
          });
        }
        messages.push(...toolResultMessages);
        // A tool-only answer is valid. If another inference would leave less
        // than one full reply budget, keep the completed actions and finish
        // cleanly instead of starting a request that cannot fit in context.
        if (!hasContextForNextLocalStep(usedTokens, toolResultMessages)) break;
      }
      emit({ type: "done" });
    } catch (error) {
      if (signal.aborted) return;
      emit({ type: "error", error: error instanceof Error ? error : new Error("Local agent failed.") });
    }
  }

  async dispose() {
    await this.engine?.exit();
    this.engine = undefined;
    this.loadedModelId = undefined;
  }

  async summarize(prompt: string, settings: AgentRunOptions["settings"], signal: AbortSignal): Promise<string> {
    const engine = await this.getEngine({
      settings,
      signal,
      emit: () => undefined,
    });
    const stream = await engine.createChatCompletion({
      messages: [
        { role: "system", content: "Summarize conversation memory accurately and concisely. Return only the summary." },
        { role: "user", content: prompt },
      ],
      stream: true,
      max_tokens: 900,
      temperature: 0.2,
      abortSignal: signal,
    });
    let summary = "";
    for await (const chunk of stream) summary += chunk.choices[0]?.delta.content ?? "";
    if (!summary.trim()) throw new Error("The local model returned an empty conversation summary.");
    return summary.trim();
  }

  private async getEngine(options: Pick<AgentRunOptions, "settings" | "signal" | "emit">): Promise<Wllama> {
    if (this.engine?.isModelLoaded() && this.loadedModelId === options.settings.modelId) return this.engine;
    if (this.engine) await this.dispose();
    const { Wllama, LoggerWithoutDebug } = await import("@wllama/wllama");
    const engine = new Wllama({ default: "/wllama/wllama.wasm" }, {
      allowOffline: true,
      logger: LoggerWithoutDebug,
    });
    engine.setCompat("default");
    const model = getLocalModelConfig(options.settings.modelId);
    options.emit({ type: "status", kind: "progress", message: "Preparing the local language model…", progress: 0 });
    await downloadLocalModel(options.settings.modelId, (progress) => {
      options.emit({
        type: "status",
        kind: "progress",
        message: `Downloading the local language model… ${Math.round(progress * 100)}%`,
        progress,
      });
    }, options.signal);
    options.emit({ type: "status", kind: "progress", message: "Loading the local language model…", progress: 1 });
    await engine.loadModelFromHF(
      model,
      {
        signal: options.signal,
        useCache: true,
        n_ctx: LOCAL_CONTEXT_TOKENS,
        progressCallback: ({ loaded, total }) => {
          const progress = total ? loaded / total : 0;
          options.emit({
            type: "status",
            kind: "progress",
            message: `Loading the local language model… ${Math.round(progress * 100)}%`,
            progress,
          });
        },
      },
    );
    this.engine = engine;
    this.loadedModelId = options.settings.modelId;
    return engine;
  }
}
