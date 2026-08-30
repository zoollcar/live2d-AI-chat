import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/agent";
import { createConversation } from "./conversation";
import {
  applyConversationCompaction,
  buildRealtimeInitialHistory,
  buildRuntimeConversationMessages,
  buildSummaryPrompt,
  planConversationCompaction,
  RECENT_TURNS_TO_KEEP,
} from "./conversation-compaction";

const modelSnapshot = {
  transport: "proxy" as const,
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-4.1-mini",
};

describe("conversation compaction", () => {
  it("always preserves system messages and the most recent eight raw turns", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "Character contract" }];
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push({ role: "user", content: `Question ${turn}` });
      messages.push({ role: "assistant", content: `Answer ${turn}` });
    }
    const conversation = createConversation({ characterId: "ai-secretary", modelSnapshot, messages, now: 1 });
    const plan = planConversationCompaction(conversation);

    expect(plan?.messages.map((message) => message.content)).toEqual([
      "Question 1", "Answer 1", "Question 2", "Answer 2",
    ]);
    expect(conversation.messages[0]).toEqual({ role: "system", content: "Character contract" });
    expect(10 - (plan!.messages.length / 2)).toBe(RECENT_TURNS_TO_KEEP);
  });

  it("uses a separate summary system message before recent raw messages", () => {
    const conversation = createConversation({
      characterId: "ai-secretary",
      modelSnapshot,
      now: 1,
      messages: [
        { role: "system", content: "Character contract" },
        { role: "user", content: "Recent question" },
      ],
    });
    conversation.summary = { content: "The user prefers concise answers.", compactedMessageCount: 12, updatedAt: 2 };

    expect(buildRuntimeConversationMessages(conversation).map((message) => message.content)).toEqual([
      "Character contract",
      "<conversation_summary>\nThe user prefers concise answers.\n</conversation_summary>",
      "Recent question",
    ]);
  });

  it("seeds realtime with only the last eight transcribed user turns", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "Character contract" }];
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push({ role: "user", content: `Question ${turn}`, inputMode: "voice" });
      messages.push({ role: "assistant", content: `Answer ${turn}` });
    }
    messages.push({ role: "user", content: "", inputMode: "voice", transcriptUnavailable: true });
    const conversation = createConversation({ characterId: "ai-secretary", modelSnapshot, messages, now: 1 });

    const history = buildRealtimeInitialHistory(conversation);

    expect(history[0]).toEqual({ role: "user", text: "Question 3" });
    expect(history.at(-1)).toEqual({ role: "model", text: "Answer 10" });
    expect(history).toHaveLength(16);
  });

  it("drops reasoning and tool inputs while retaining bounded necessary results", () => {
    const conversation = createConversation({
      characterId: "ai-secretary",
      modelSnapshot,
      now: 1,
      messages: [
        { role: "system", content: "Character contract" },
        ...Array.from({ length: 10 }, (_, index) => [
          { role: "user" as const, content: `Question ${index}` },
          {
            role: "assistant" as const,
            content: `Answer ${index}`,
            reasoning: "private chain of thought",
            toolCalls: [{ name: "lookup", input: { secretQuery: "raw input" }, output: { fact: "needed result" } }],
          },
        ]).flat(),
      ],
    });
    const prompt = buildSummaryPrompt(planConversationCompaction(conversation)!);

    expect(prompt).toContain('lookup: {"fact":"needed result"}');
    expect(prompt).not.toContain("private chain of thought");
    expect(prompt).not.toContain("secretQuery");
  });

  it("keeps messages appended during compression and rejects a changed old prefix", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "Character contract" }];
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push({ role: "user", content: `Question ${turn}` });
      messages.push({ role: "assistant", content: `Answer ${turn}` });
    }
    const conversation = createConversation({ characterId: "ai-secretary", modelSnapshot, messages, now: 1 });
    const plan = planConversationCompaction(conversation)!;
    const withConcurrentTurn = {
      ...conversation,
      messages: [
        ...conversation.messages,
        { role: "user" as const, content: "Concurrent question" },
        { role: "assistant" as const, content: "Concurrent answer" },
      ],
    };
    const compacted = applyConversationCompaction(withConcurrentTurn, plan, "Durable summary", 2);

    expect(compacted?.messages[0]).toEqual({ role: "system", content: "Character contract" });
    expect(compacted?.messages.at(-1)?.content).toBe("Concurrent answer");
    expect(compacted?.messages).toEqual(withConcurrentTurn.messages);
    expect(compacted?.summary).toMatchObject({
      content: "Durable summary",
      compactedMessageCount: 4,
      transcriptRetained: true,
    });
    expect(buildRuntimeConversationMessages(compacted!).map((message) => message.content)).toEqual([
      "Character contract",
      "<conversation_summary>\nDurable summary\n</conversation_summary>",
      "Question 3",
      "Answer 3",
      "Question 4",
      "Answer 4",
      "Question 5",
      "Answer 5",
      "Question 6",
      "Answer 6",
      "Question 7",
      "Answer 7",
      "Question 8",
      "Answer 8",
      "Question 9",
      "Answer 9",
      "Question 10",
      "Answer 10",
      "Concurrent question",
      "Concurrent answer",
    ]);

    const changedPrefix = {
      ...conversation,
      messages: conversation.messages.map((message, index) =>
        index === 1 ? { ...message, content: "Changed while summarizing" } : message),
    };
    expect(applyConversationCompaction(changedPrefix, plan, "Stale summary", 2)).toBeUndefined();
  });

  it("summarizes only newly aged messages after a retained-transcript compaction", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "Character contract" }];
    for (let turn = 1; turn <= 10; turn += 1) {
      messages.push({ role: "user", content: `Question ${turn}` });
      messages.push({ role: "assistant", content: `Answer ${turn}` });
    }
    const conversation = createConversation({ characterId: "ai-secretary", modelSnapshot, messages, now: 1 });
    const firstPlan = planConversationCompaction(conversation)!;
    const firstCompaction = applyConversationCompaction(conversation, firstPlan, "First summary", 2)!;
    const extended = {
      ...firstCompaction,
      messages: [
        ...firstCompaction.messages,
        { role: "user" as const, content: "Question 11" },
        { role: "assistant" as const, content: "Answer 11" },
      ],
    };

    const secondPlan = planConversationCompaction(extended)!;

    expect(secondPlan.previousSummary).toBe("First summary");
    expect(secondPlan.messages.map((message) => message.content)).toEqual(["Question 3", "Answer 3"]);
    expect(secondPlan.compactedNonSystemCount).toBe(6);
  });
});
