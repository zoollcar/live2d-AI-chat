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

export function planConversationCompaction(conversation: Conversation): ConversationCompactionPlan | undefined {
  const nonSystem = conversation.messages.filter((message) => message.role !== "system");
  const userIndexes = nonSystem.flatMap((message, index) => message.role === "user" ? [index] : []);
  if (userIndexes.length < COMPACTION_TRIGGER_TURNS) return undefined;

  const firstRetainedUserIndex = userIndexes[userIndexes.length - RECENT_TURNS_TO_KEEP];
  const messages = nonSystem.slice(0, firstRetainedUserIndex);
  if (messages.length === 0) return undefined;
  return {
    conversationId: conversation.id,
    previousSummary: conversation.summary?.content,
    messages,
    compactedNonSystemCount: messages.length,
    prefixFingerprint: fingerprintMessages(messages),
  };
}

export function buildRuntimeConversationMessages(conversation: Conversation): ChatMessage[] {
  const systemMessages = conversation.messages.filter((message) => message.role === "system");
  const recentMessages = conversation.messages.filter((message) => message.role !== "system");
  const summaryMessage: ChatMessage[] = conversation.summary ? [{
    role: "system",
    content: `<conversation_summary>\n${conversation.summary.content}\n</conversation_summary>`,
  }] : [];
  return [...systemMessages, ...summaryMessage, ...recentMessages];
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
  const systemMessages = conversation.messages.filter((message) => message.role === "system");
  return conversationSchema.parse({
    ...conversation,
    updatedAt: now,
    summary: {
      content: summary,
      compactedMessageCount: (conversation.summary?.compactedMessageCount ?? 0) + plan.compactedNonSystemCount,
      updatedAt: now,
    },
    messages: [...systemMessages, ...nonSystem.slice(plan.compactedNonSystemCount)],
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
