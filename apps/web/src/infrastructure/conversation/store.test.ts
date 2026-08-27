import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversation } from "@/model/conversation";
import { useConversationStore } from "./store";

describe("conversation model snapshots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const conversation = createConversation({
      characterId: "ai-secretary",
      modelSnapshot: {
        transport: "proxy",
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
});
