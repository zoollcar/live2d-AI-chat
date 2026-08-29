import type { LlmSettings } from "@live2d-chat/shared";
import { ChromeAgentRuntime } from "./chrome-agent";
import { LocalAgentRuntime } from "./local-agent";
import { RemoteAgentRuntime } from "./remote-agent";
import type { AgentRuntime } from "./types";

let localRuntime: LocalAgentRuntime | undefined;

export function createAgentRuntime(settings: LlmSettings): AgentRuntime {
  if (settings.transport === "chrome") return new ChromeAgentRuntime();
  if (settings.transport === "local") {
    localRuntime ||= new LocalAgentRuntime();
    return localRuntime;
  }
  return new RemoteAgentRuntime();
}

export function summarizeWithLocalModel(prompt: string, settings: LlmSettings, signal: AbortSignal): Promise<string> {
  localRuntime ||= new LocalAgentRuntime();
  return localRuntime.summarize(prompt, settings, signal);
}

export type { AgentEvent, AgentRuntime, ChatMessage, StatusKind, ToolCallRecord } from "./types";
