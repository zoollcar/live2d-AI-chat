import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_EXPORT_FORMAT,
  CONVERSATION_EXPORT_VERSION,
  createConversation,
} from "@/model/conversation";

const indexedDb = vi.hoisted(() => ({
  deleteConversationRecord: vi.fn(async () => undefined),
  loadConversationDatabase: vi.fn(),
  saveActiveConversationId: vi.fn(async () => undefined),
  saveConversation: vi.fn(async () => undefined),
  saveConversationImport: vi.fn(async () => undefined),
}));

vi.mock("./indexed-db", () => indexedDb);

import { useConversationStore } from "./store";

describe("conversation model snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const conversation = createConversation({
      characterId: "ai-secretary",
      modelSnapshot: {
        transport: "extension",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4.1-mini",
      },
      messages: [{ role: "system", content: "Stable prompt" }],
      now: 100,
    });
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      hydrated: true,
      storageError: undefined,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    useConversationStore.setState({
      conversations: [],
      activeConversationId: undefined,
      hydrated: false,
      storageError: undefined,
    });
  });

  it("updates the active conversation when the user switches LLM settings", () => {
    useConversationStore.getState().updateActiveModelSnapshot({
      transport: "local",
      baseUrl: "https://api.openai.com/v1",
      modelId: "unsloth/Qwen3.5-0.8B-GGUF",
    });

    expect(useConversationStore.getState().conversations[0].modelSnapshot).toEqual({
      transport: "local",
      baseUrl: "https://api.openai.com/v1",
      modelId: "unsloth/Qwen3.5-0.8B-GGUF",
    });
  });

  it("keeps the conversation order stable while streaming message updates", () => {
    const active = useConversationStore.getState().conversations[0];
    const newer = createConversation({
      characterId: "ai-secretary",
      modelSnapshot: active.modelSnapshot,
      messages: [{ role: "user", content: "Newer conversation" }],
      now: 200,
    });
    useConversationStore.setState({
      conversations: [newer, active],
      activeConversationId: active.id,
    });

    useConversationStore.getState().updateMessages((messages) => [
      ...messages,
      { role: "assistant", content: "Streaming delta" },
    ]);

    expect(useConversationStore.getState().conversations.map(({ id }) => id)).toEqual([
      newer.id,
      active.id,
    ]);
  });

  it("does not expose imported conversations when their atomic persistence fails", async () => {
    const before = useConversationStore.getState();
    const imported = createConversation({
      characterId: "ai-secretary",
      modelSnapshot: {
        transport: "direct",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4.1-mini",
      },
      messages: [{ role: "user", content: "Imported" }],
      now: 200,
    });
    indexedDb.saveConversationImport.mockRejectedValueOnce(new Error("conversation storage failed"));

    await expect(useConversationStore.getState().importJson(JSON.stringify({
      format: CONVERSATION_EXPORT_FORMAT,
      version: CONVERSATION_EXPORT_VERSION,
      exportedAt: "2026-08-31T00:00:00.000Z",
      conversations: [imported],
    }))).rejects.toThrow("conversation storage failed");

    const after = useConversationStore.getState();
    expect(after.conversations).toEqual(before.conversations);
    expect(after.activeConversationId).toBe(before.activeConversationId);
    expect(after.storageError).toBe("conversation storage failed");
    expect(indexedDb.saveConversationImport).toHaveBeenCalledWith([imported], imported.id);
  });
});
