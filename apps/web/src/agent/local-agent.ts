import type {
  ChatCompletionMessage,
  ChatCompletionTool,
  Wllama,
} from "@wllama/wllama";
import { createSceneToolRegistry } from "./tools";
import type { AgentRunOptions, AgentRuntime } from "./types";
import { downloadLocalModel, getLocalModelConfig } from "./local-models";

const localSystemPrompt = `You are a lively Live2D character. Keep replies conversational.
You may call the provided tools to control your expression, action, pose, or stage layout.
After tools finish, continue with a natural answer.`;

export class LocalAgentRuntime implements AgentRuntime {
  private engine?: Wllama;
  private loadedModelId?: string;

  async run(options: AgentRunOptions) {
    const { emit, scene, signal } = options;
    try {
      const engine = await this.getEngine(options);
      const registry = createSceneToolRegistry(scene, emit);
      const messages: ChatCompletionMessage[] = [
        { role: "system", content: localSystemPrompt },
        ...options.messages.filter((message) => message.role !== "system"),
      ];

      for (let step = 0; step < 5 && !signal.aborted; step += 1) {
        const stream = await engine.createChatCompletion({
          messages,
          tools: registry.wllamaTools as ChatCompletionTool[],
          tool_choice: "auto",
          stream: true,
          max_tokens: 600,
          temperature: 0.7,
          abortSignal: signal,
        });
        let text = "";
        let finishReason: string | null = null;
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;
          finishReason = choice.finish_reason ?? finishReason;
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
        for (const call of toolCalls) {
          const input = JSON.parse(call.function.arguments || "{}");
          const output = await registry.execute(call.function.name, input);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(output),
          });
        }
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

  private async getEngine(options: AgentRunOptions): Promise<Wllama> {
    if (this.engine?.isModelLoaded() && this.loadedModelId === options.settings.modelId) return this.engine;
    if (this.engine) await this.dispose();
    const { Wllama, LoggerWithoutDebug } = await import("@wllama/wllama");
    const engine = new Wllama({ default: "/wllama/wllama.wasm" }, {
      allowOffline: true,
      logger: LoggerWithoutDebug,
    });
    engine.setCompat("default");
    const model = getLocalModelConfig(options.settings.modelId);
    options.emit({ type: "status", message: "正在准备本地语言模型…", progress: 0 });
    await downloadLocalModel(options.settings.modelId, (progress) => {
      options.emit({
        type: "status",
        message: `正在下载本地语言模型… ${Math.round(progress * 100)}%`,
        progress,
      });
    }, options.signal);
    options.emit({ type: "status", message: "正在加载本地语言模型…", progress: 1 });
    await engine.loadModelFromHF(
      model,
      {
        signal: options.signal,
        useCache: true,
        progressCallback: ({ loaded, total }) => {
          const progress = total ? loaded / total : 0;
          options.emit({
            type: "status",
            message: `正在加载本地语言模型… ${Math.round(progress * 100)}%`,
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
