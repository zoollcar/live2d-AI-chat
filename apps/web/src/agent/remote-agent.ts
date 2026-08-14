import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { isStepCount, ToolLoopAgent, type ModelMessage } from "ai";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import { createSceneToolRegistry } from "./tools";
import type { AgentRunOptions, AgentRuntime } from "./types";

export class RemoteAgentRuntime implements AgentRuntime {
  async run(options: AgentRunOptions) {
    const { settings, scene, emit, signal } = options;
    try {
      emit({ type: "status", message: "Connecting to the language model…" });
      const provider = createOpenAICompatible({
        name: "live2d-chat",
        baseURL: normalizeBaseUrl(settings.baseUrl),
        apiKey: settings.apiKey || "not-required",
      });
      const { aiTools } = createSceneToolRegistry(scene, emit);
      const agent = new ToolLoopAgent({
        model: provider(settings.modelId),
        tools: aiTools,
        stopWhen: isStepCount(5),
        temperature: 0.75,
        maxOutputTokens: 600,
      });
      const result = await agent.stream({
        messages: options.messages as ModelMessage[],
        abortSignal: signal,
      });
      for await (const delta of result.textStream) {
        emit({ type: "text-delta", delta });
      }
      emit({ type: "done" });
    } catch (error) {
      if (signal.aborted) return;
      emit({ type: "error", error: error instanceof Error ? error : new Error("Agent failed.") });
    }
  }
}
