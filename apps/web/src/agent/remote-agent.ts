import { isStepCount, ToolLoopAgent, type ModelMessage } from "ai";
import { createRemoteLanguageModel } from "./language-model";
import { SYSTEM_MESSAGE } from "./system-prompt";
import { createAgentToolRegistry } from "./tools";
import type { AgentRunOptions, AgentRuntime } from "./types";

// Upper bound on ReAct steps for a single user turn. Mirrors the
// `stopWhen: isStepCount(N)` setting below; keep them in sync so the user
// sees "step N of M" instead of a confusing open-ended counter.
const MAX_STEPS = 5;

export class RemoteAgentRuntime implements AgentRuntime {
  async run(options: AgentRunOptions) {
    const { settings, scene, emit, signal } = options;
    try {
      emit({ type: "status", kind: "busy", message: "Connecting to the language model…" });
      const { aiTools, resetBatch } = createAgentToolRegistry({
        scene,
        emit,
        resources: options.resources,
        workspace: options.workspace,
        network: options.network,
        capabilities: options.toolCapabilities,
        enabledTools: options.enabledTools,
      });
      // The AI SDK 7+ no longer allows system messages inside `messages` —
      // they have to travel through the agent's `instructions` option or the
      // call throws `AI_InvalidPromptError`. Pull every system message out of
      // the history and fold their contents into `instructions`. Fall back to
      // the built-in personality prompt when the caller didn't supply one.
      const systemMessages = options.messages.filter((message) => message.role === "system");
      const conversation = options.messages.filter((message) => message.role !== "system") as ModelMessage[];
      const instructions = systemMessages.length > 0
        ? systemMessages.map((message) => message.content).join("\n\n")
        : SYSTEM_MESSAGE.content;
      const agent = new ToolLoopAgent({
        model: createRemoteLanguageModel(settings),
        tools: aiTools,
        instructions,
        stopWhen: isStepCount(MAX_STEPS),
        temperature: 0.75,
        maxOutputTokens: 600,
      });
      const result = await agent.stream({
        messages: conversation,
        abortSignal: signal,
      });

      // We deliberately consume `fullStream` (not `textStream`) so the UI can
      // react to step boundaries, reasoning, tool lifecycle, and stream-level
      // errors. Without this, every intermediate event inside the ReAct loop
      // would be swallowed and the user would only see the final reply text
      // appear with no indication of what's happening in between.
      let step = 0;
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step": {
            // The SDK emits one start-step per ReAct step (initial reasoning
            // + each follow-up after a tool result). Cap at MAX_STEPS so the
            // counter never overshoots the user's mental model.
            step = Math.min(step + 1, MAX_STEPS);
            emit({
              type: "status",
              kind: "busy",
              message: `Reasoning (step ${step} of ${MAX_STEPS})…`,
            });
            // Reset batch tracking so the first performAction in this new
            // assistant message preempts any actions still queued from earlier.
            resetBatch();
            break;
          }
          case "reasoning-start":
            // Reasoning-capable models (o1, Qwen3-Think, etc.) emit these
            // before the visible text. Let the user know the model is
            // thinking rather than appearing to hang.
            emit({ type: "status", kind: "busy", message: "Reasoning…" });
            break;
          case "tool-input-start": {
            // Fires once per tool call, before the tool's `execute` runs.
            // The execute function itself will emit a `tool-call` event with
            // the parsed input, so we only update the status here.
            const name = part.toolName || "tool";
            emit({
              type: "status",
              kind: "busy",
              message: `Running tool: ${name}${step > 0 ? ` (step ${step})` : ""}…`,
            });
            break;
          }
          case "tool-error":
            // A tool threw inside its `execute`. Surface it as an error
            // status so the user can see which tool failed without having to
            // dig into the devtools console.
            emit({
              type: "status",
              kind: "error",
              message: `Tool ${part.toolName ?? "unknown"} failed: ${describeToolError(part.error)}`,
            });
            break;
          case "text-start":
            // The model has finished reasoning and is about to write the
            // user-visible reply. Brief status so the transition isn't
            // invisible between reasoning and the first text-delta.
            emit({ type: "status", kind: "busy", message: "Drafting reply…" });
            break;
          case "text-delta":
            emit({ type: "text-delta", delta: part.text });
            break;
          case "reasoning-delta":
            // Stream reasoning text as deltas so the chat history can
            // accumulate it onto the current assistant turn. Reasoning-capable
            // models (Claude Sonnet 4.5, Qwen reasoning variants, etc.) emit
            // a `reasoning-start` followed by one or more of these before
            // the visible text; the user opens the "Thinking" section in
            // chat history to see what the model was working through.
            emit({ type: "reasoning-delta", delta: part.text });
            break;
          case "error":
            // Stream-level error (network drop, provider 5xx, etc.). The
            // outer try/catch would normally catch these too, but emitting
            // here preserves the precise reason and avoids overwriting a
            // more specific status message we may have already shown.
            emit({
              type: "status",
              kind: "error",
              message: `Stream error: ${describeToolError(part.error)}`,
            });
            break;
          // `finish-step`, `finish`, `abort`, `tool-call`, `tool-result`,
          // `source`, `file`, `reasoning-end`, `text-end`, `raw` are
          // intentionally ignored here: the surrounding app surfaces `done`
          // and `error` for terminal states, and the scene tool registry
          // already emits its own `tool-call` / `tool-result` events from
          // inside each tool's `execute`. `reasoning-start` / `text-start`
          // drive the status chip via the cases above and don't need a
          // separate event.
        }
      }
      emit({ type: "done" });
    } catch (error) {
      if (signal.aborted) return;
      emit({ type: "error", error: error instanceof Error ? error : new Error("Agent failed.") });
    }
  }
}

function describeToolError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown tool error";
  }
}
