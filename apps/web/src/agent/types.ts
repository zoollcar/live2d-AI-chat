import type { LlmSettings } from "@live2d-chat/shared";
import type { SceneController } from "@/model/live2d/scene-controller";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type AgentEvent =
  | { type: "status"; message: string; progress?: number }
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; name: string; input: unknown }
  | { type: "tool-result"; name: string; output: unknown }
  | { type: "done" }
  | { type: "error"; error: Error };

export interface AgentRunOptions {
  messages: ChatMessage[];
  settings: LlmSettings;
  scene: SceneController;
  signal: AbortSignal;
  emit(event: AgentEvent): void;
}

export interface AgentRuntime {
  run(options: AgentRunOptions): Promise<void>;
  dispose?(): Promise<void>;
}
