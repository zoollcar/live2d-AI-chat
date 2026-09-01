import type { ArtifactRef, LlmSettings, ResourceRef } from "@live2d-chat/shared";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { AgentNetworkAccess, AgentResourceAccess, AgentToolCapabilities, AgentToolName, AgentWorkspaceAccess } from "./tool-context";

/**
 * A tool invocation captured during an assistant turn. The runtime emits a
 * `tool-call` event when the tool's `execute()` starts, then a matching
 * `tool-result` event with the output once it finishes. The chat history view
 * renders these so the user can see what the agent did, not just the reply.
 *
 * Providers may request tool calls from one assistant message in parallel.
 * The scene tool registry serializes those calls because actions, states, and
 * expressions all mutate the same Live2D model and their order is observable.
 */
export interface ToolCallRecord {
  /** Provider call id used to correlate and de-duplicate realtime tool calls. */
  callId?: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
  canceled?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** How a user message entered the conversation. Omitted for legacy data. */
  inputMode?: "text" | "voice";
  /** The native-audio provider could not produce a transcript for this turn. */
  transcriptUnavailable?: boolean;
  /** The assistant reply ended before completion but its received content is retained. */
  interrupted?: boolean;
  /**
   * Accumulated reasoning text for this assistant turn, populated from the
   * remote runtime's `reasoning-delta` stream events. Only present when the
   * underlying model is reasoning-capable (e.g. Claude Sonnet 4.5, Qwen
   * reasoning variants). The chat history view renders this collapsed under
   * a "Thinking" label.
   */
  reasoning?: string;
  /**
   * Tool invocations the model made during this assistant turn, in the order
   * they were executed. Each entry gains its `output` once the corresponding
   * `tool-result` event is received.
   */
  toolCalls?: ToolCallRecord[];
  /** Browser-local resources referenced by this turn. Binary data lives in IndexedDB. */
  attachments?: ResourceRef[];
  /** Stage views, drawings, and stickers produced by this turn. */
  artifacts?: ArtifactRef[];
}

/**
 * Semantic kind for a status event. The UI uses this to colour and animate the
 * header chip without having to pattern-match the message string:
 *
 * - `idle`     — neutral, no animation. Use when the agent is finished and
 *                waiting for the next turn.
 * - `busy`     — work in progress with no measurable progress. Use for
 *                reasoning, drafting replies, running tools, transcribing
 *                speech, etc.
 * - `progress` — long-running work with a `progress` field in [0, 1]. The UI
 *                renders an inline progress bar.
 * - `error`    — something went wrong; the chip switches to a warning colour
 *                so the failure stands out from ordinary busy messages.
 */
export type StatusKind = "idle" | "busy" | "progress" | "error";

export type AgentEvent =
  | { type: "status"; kind: StatusKind; message: string; progress?: number }
  | { type: "text-delta"; delta: string }
  /**
   * Reasoning text streamed from a reasoning-capable model. Emitted as
   * deltas (the same shape as `text-delta`) so the caller can append
   * incrementally into a single per-turn string. Only the remote runtime
   * produces these; local wllama models do not emit reasoning.
   */
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "tool-result"; callId: string; name: string; output: unknown }
  | { type: "tool-error"; callId: string; name: string; error: string }
  | { type: "tool-cancel"; callId: string; name: string }
  | { type: "done" }
  | { type: "error"; error: Error };

export interface AgentRunOptions {
  messages: ChatMessage[];
  settings: LlmSettings;
  scene: SceneController;
  resources?: AgentResourceAccess;
  workspace?: AgentWorkspaceAccess;
  network?: AgentNetworkAccess;
  toolCapabilities?: Partial<AgentToolCapabilities>;
  enabledTools?: readonly AgentToolName[];
  signal: AbortSignal;
  emit(event: AgentEvent): void;
}

export interface AgentRuntime {
  run(options: AgentRunOptions): Promise<void>;
  dispose?(): Promise<void>;
}
