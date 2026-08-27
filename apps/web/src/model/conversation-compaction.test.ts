import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/agent";
import { createConversation } from "./conversation";
import {
  applyConversationCompaction,
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
    expect(compacted?.summary).toMatchObject({ content: "Durable summary", compactedMessageCount: 4 });

    const changedPrefix = {
      ...conversation,
      messages: conversation.messages.map((message, index) =>
        index === 1 ? { ...message, content: "Changed while summarizing" } : message),
    };
    expect(applyConversationCompaction(changedPrefix, plan, "Stale summary", 2)).toBeUndefined();
  });
});
