import type { ChatMessage, ToolCallRecord } from "@/agent";
import { conversationSchema, type Conversation } from "./conversation";

export const RECENT_TURNS_TO_KEEP = 8;
export const COMPACTION_TRIGGER_TURNS = 10;
const MAX_TOOL_RESULT_CHARACTERS = 1_200;

export interface ConversationCompactionPlan {
  conversationId: string;
  previousSummary?: string;
  messages: ChatMessage[];
  compactedNonSystemCount: number;
  prefixFingerprint: string;
}

export interface RealtimeHistoryEntry {
  role: "user" | "model";
  text: string;
}

export function planConversationCompaction(conversation: Conversation): ConversationCompactionPlan | undefined {
  const nonSystem = conversation.messages.filter((message) => message.role !== "system");
  const userIndexes = nonSystem.flatMap((message, index) => message.role === "user" ? [index] : []);
  if (userIndexes.length < COMPACTION_TRIGGER_TURNS) return undefined;

  const firstRetainedUserIndex = userIndexes[userIndexes.length - RECENT_TURNS_TO_KEEP];
  const previousCompactedCount = conversation.summary?.transcriptRetained
    ? conversation.summary.compactedMessageCount
    : 0;
  if (firstRetainedUserIndex <= previousCompactedCount) return undefined;
  const messages = nonSystem.slice(previousCompactedCount, firstRetainedUserIndex);
  if (messages.length === 0) return undefined;
  return {
    conversationId: conversation.id,
    previousSummary: conversation.summary?.content,
    messages,
    compactedNonSystemCount: firstRetainedUserIndex,
    prefixFingerprint: fingerprintMessages(nonSystem.slice(0, firstRetainedUserIndex)),
  };
}

export function buildRuntimeConversationMessages(conversation: Conversation): ChatMessage[] {
  const systemMessages = conversation.messages.filter((message) => message.role === "system");
  const nonSystemMessages = conversation.messages.filter((message) => message.role !== "system");
  const recentMessages = conversation.summary?.transcriptRetained
    ? nonSystemMessages.slice(conversation.summary.compactedMessageCount)
    : nonSystemMessages;
  const summaryMessage: ChatMessage[] = conversation.summary ? [{
    role: "system",
    content: `<conversation_summary>\n${conversation.summary.content}\n</conversation_summary>`,
  }] : [];
  return [...systemMessages, ...summaryMessage, ...recentMessages];
}

/**
 * Build the bounded text-only history accepted by Gemini Live during initial
 * session setup. Tool events are deliberately not replayed: the current scene
 * snapshot is supplied separately and replaying a function call could repeat
 * an observable side effect.
 */
export function buildRealtimeInitialHistory(conversation: Conversation): RealtimeHistoryEntry[] {
  const messages = conversation.messages.filter((message) => message.role !== "system");
  const userIndexes = messages.flatMap((message, index) =>
    message.role === "user" && message.content.trim() && !message.transcriptUnavailable ? [index] : []);
  const firstIndex = userIndexes.length > RECENT_TURNS_TO_KEEP
    ? userIndexes[userIndexes.length - RECENT_TURNS_TO_KEEP]
    : 0;
  const entries = messages.slice(firstIndex).flatMap<RealtimeHistoryEntry>((message) => {
    const text = message.content.trim();
    if (!text || message.transcriptUnavailable) return [];
    return [{ role: message.role === "assistant" ? "model" : "user", text }];
  });

  return entries.reduce<RealtimeHistoryEntry[]>((merged, entry) => {
    const previous = merged[merged.length - 1];
    if (previous?.role === entry.role) previous.text += `\n\n${entry.text}`;
    else merged.push({ ...entry });
    return merged;
  }, []);
}

export function applyConversationCompaction(
  conversation: Conversation,
  plan: ConversationCompactionPlan,
  rawSummary: string,
  now = Date.now(),
): Conversation | undefined {
  const summary = rawSummary.trim();
  if (!summary || conversation.id !== plan.conversationId) return undefined;
  const nonSystem = conversation.messages.filter((message) => message.role !== "system");
  const currentPrefix = nonSystem.slice(0, plan.compactedNonSystemCount);
  if (conversation.summary?.content !== plan.previousSummary
    || fingerprintMessages(currentPrefix) !== plan.prefixFingerprint) return undefined;
  return conversationSchema.parse({
    ...conversation,
    updatedAt: now,
    summary: {
      content: summary,
      compactedMessageCount: plan.compactedNonSystemCount,
      updatedAt: now,
      transcriptRetained: true,
    },
    // Compaction changes only the runtime context view. The durable transcript
    // remains intact for chat history, search, export and future providers.
    messages: conversation.messages,
  });
}

export function buildSummaryPrompt(plan: ConversationCompactionPlan): string {
  const prior = plan.previousSummary
    ? `<previous_summary>\n${plan.previousSummary}\n</previous_summary>\n\n`
    : "";
  return `${prior}<older_messages>\n${plan.messages.map(formatMessageForSummary).join("\n\n")}\n</older_messages>\n\nUpdate the durable summary. Preserve user preferences, facts, decisions, commitments, open questions, and only necessary tool outcomes. Omit chain-of-thought, greetings, filler, repeated details, and raw tool inputs.`;
}

export function fingerprintMessages(messages: readonly ChatMessage[]): string {
  return JSON.stringify(messages.map((message) => ({
    role: message.role,
    content: message.content,
    tools: message.toolCalls?.map(toolResultForSummary),
  })));
}

function formatMessageForSummary(message: ChatMessage): string {
  const toolResults = message.toolCalls?.map(toolResultForSummary).filter((result) => result.result !== undefined);
  const tools = toolResults && toolResults.length > 0
    ? `\nnecessary_tool_results:\n${toolResults.map((result) => `- ${result.name}: ${result.result}`).join("\n")}`
    : "";
  return `${message.role}: ${message.content || "(no visible text)"}${tools}`;
}

function toolResultForSummary(call: ToolCallRecord): { name: string; result?: string } {
  const raw = call.error ? `error: ${call.error}` : call.output === undefined ? undefined : safeJson(call.output);
  if (raw === undefined) return { name: call.name };
  return {
    name: call.name,
    result: raw.length > MAX_TOOL_RESULT_CHARACTERS
      ? `${raw.slice(0, MAX_TOOL_RESULT_CHARACTERS - 1)}…`
      : raw,
  };
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, current) => {
      if (typeof current === "bigint") return String(current);
      if (current && typeof current === "object") {
        if (seen.has(current as object)) return "[Circular]";
        seen.add(current as object);
      }
      return current;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}
