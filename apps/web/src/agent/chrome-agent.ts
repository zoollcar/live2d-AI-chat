import { createAgentToolRegistry } from "./tools";
import type { AgentRunOptions, AgentRuntime, ChatMessage } from "./types";

export const CHROME_MODEL_ID = "gemini-nano";
export const CHROME_MODEL_URL = "chrome://built-in-ai";

export class ChromeAgentRuntime implements AgentRuntime {
  async run(options: AgentRunOptions) {
    const { emit, scene, signal } = options;
    let session: LanguageModel | undefined;
    try {
      if (typeof LanguageModel === "undefined") {
        throw new Error("Chrome's built-in Prompt API is not available in this browser.");
      }

      emit({ type: "status", kind: "busy", message: "Starting Chrome built-in AI…" });
      const registry = createAgentToolRegistry({
        scene,
        emit,
        resources: options.resources,
        workspace: options.workspace,
        network: options.network,
        capabilities: options.toolCapabilities,
      });
      const { initialPrompts, prompt } = splitPrompt(options.messages);
      session = await LanguageModel.create({
        initialPrompts,
        tools: registry.chromeTools,
        ...(options.toolCapabilities?.inspectImage ? {
          expectedInputs: [{ type: "image" as const }, { type: "text" as const }],
        } : {}),
        signal,
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            emit({
              type: "status",
              kind: "progress",
              message: `Downloading Chrome built-in AI… ${Math.round(event.loaded * 100)}%`,
              progress: event.loaded,
            });
          });
        },
      });

      emit({ type: "status", kind: "busy", message: "Chrome built-in AI is drafting a reply…" });
      const stream = session.promptStreaming(prompt, { signal });
      for await (const chunk of stream) {
        if (chunk) emit({ type: "text-delta", delta: chunk });
      }
      emit({ type: "done" });
    } catch (error) {
      if (signal.aborted) return;
      emit({
        type: "error",
        error: error instanceof Error ? error : new Error("Chrome built-in AI failed."),
      });
    } finally {
      session?.destroy();
    }
  }
}

export async function summarizeWithChromePromptApi(prompt: string, signal: AbortSignal): Promise<string> {
  if (typeof LanguageModel === "undefined") {
    throw new Error("Chrome's built-in Prompt API is not available in this browser.");
  }
  const session = await LanguageModel.create({
    initialPrompts: [{
      role: "system",
      content: "Create durable conversation memory. Preserve facts, decisions, preferences, unresolved tasks, and necessary tool outcomes. Do not invent details. Return only the updated summary.",
    }],
    signal,
  });
  try {
    const summary = (await session.prompt(prompt, { signal })).trim();
    if (!summary) throw new Error("Chrome built-in AI returned an empty conversation summary.");
    return summary;
  } finally {
    session.destroy();
  }
}

function splitPrompt(messages: ChatMessage[]): {
  initialPrompts: [LanguageModelSystemMessage, ...LanguageModelMessage[]];
  prompt: string;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const conversation = messages.filter((message) => message.role !== "system");
  const latest = conversation.at(-1);
  if (!latest || latest.role !== "user") {
    throw new Error("Chrome built-in AI requires the latest message to be from the user.");
  }
  return {
    initialPrompts: [
      { role: "system", content: system || "You are a helpful assistant." },
      ...conversation.slice(0, -1).map((message) => ({
        role: message.role as "user" | "assistant",
        content: message.content,
      })),
    ],
    prompt: latest.content,
  };
}
