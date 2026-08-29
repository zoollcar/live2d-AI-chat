import { describe, expect, it } from "vitest";
import {
  CONVERSATION_EXPORT_FORMAT,
  createConversation,
  deriveConversationTitle,
  parseConversationExport,
  serializeConversationExport,
} from "./conversation";

const modelSnapshot = {
  transport: "proxy" as const,
  baseUrl: "https://api.openai.com/v1",
  modelId: "gpt-4.1-mini",
};

describe("conversation persistence", () => {
  it("accepts Chrome built-in AI model snapshots", () => {
    const conversation = createConversation({
      characterId: "ai-secretary",
      modelSnapshot: {
        transport: "chrome",
        baseUrl: "chrome://built-in-ai",
        modelId: "gemini-nano",
      },
      messages: [{ role: "user", content: "Hello" }],
      now: 1,
    });
    expect(conversation.modelSnapshot.transport).toBe("chrome");
  });

  it("round-trips reasoning and tool calls without credentials", () => {
    const conversation = createConversation({
      characterId: "ai-secretary",
      modelSnapshot,
      now: 100,
      messages: [
        { role: "system", content: "Stable prompt" },
        { role: "user", content: "Show me the state" },
        {
          role: "assistant",
          content: "Done",
          reasoning: "Inspect the scene",
          toolCalls: [{ name: "setState", input: { state: "happy" }, output: { ok: true } }],
        },
      ],
    });

    const json = serializeConversationExport([conversation]);
    const parsed = parseConversationExport(json);
    expect(parsed.conversations).toEqual([conversation]);
    expect(json).not.toContain("apiKey");
  });

  it("migrates the legacy model field and missing starred flag", () => {
    const migrated = parseConversationExport(JSON.stringify({
      format: CONVERSATION_EXPORT_FORMAT,
      version: 0,
      conversations: [{
        id: "legacy",
        title: "Legacy chat",
        createdAt: 10,
        updatedAt: 20,
        characterId: "ai-secretary",
        model: modelSnapshot,
        messages: [{ role: "user", content: "Hello" }],
      }],
    }));

    expect(migrated.version).toBe(1);
    expect(migrated.conversations[0]).toMatchObject({ starred: false, modelSnapshot });
  });

  it("rejects malformed imported messages", () => {
    expect(() => parseConversationExport(JSON.stringify({
      format: CONVERSATION_EXPORT_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      conversations: [{
        id: "bad",
        title: "Bad chat",
        createdAt: 20,
        updatedAt: 10,
        starred: false,
        characterId: "ai-secretary",
        modelSnapshot,
        messages: [{ role: "developer", content: 42 }],
      }],
    }))).toThrow();
  });

  it("derives a compact title from the first user message", () => {
    expect(deriveConversationTitle([
      { role: "assistant", content: "Welcome" },
      { role: "user", content: "  Explain   IndexedDB persistence  " },
    ])).toBe("Explain IndexedDB persistence");
  });
});
