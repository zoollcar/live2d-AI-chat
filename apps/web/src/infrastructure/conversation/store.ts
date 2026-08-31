import { create } from "zustand";
import type { ChatMessage } from "@/agent";
import { applyConversationCompaction, type ConversationCompactionPlan } from "@/model/conversation-compaction";
import {
  conversationSchema,
  createConversation,
  createConversationId,
  deriveConversationTitle,
  parseConversationExport,
  type Conversation,
  type ConversationModelSnapshot,
} from "@/model/conversation";
import {
  deleteConversationRecord,
  loadConversationDatabase,
  saveActiveConversationId,
  saveConversation,
  saveConversationImport,
} from "./indexed-db";

export interface NewConversationInput {
  characterId: string;
  modelSnapshot: ConversationModelSnapshot;
  messages: ChatMessage[];
  title?: string;
}

interface ConversationStore {
  conversations: Conversation[];
  activeConversationId?: string;
  hydrated: boolean;
  storageError?: string;
  hydrate(seed: NewConversationInput): Promise<void>;
  create(input: NewConversationInput): Promise<Conversation>;
  select(id: string): Promise<void>;
  updateActiveModelSnapshot(modelSnapshot: ConversationModelSnapshot): void;
  updateMessages(updater: (messages: ChatMessage[]) => ChatMessage[]): void;
  applyCompaction(plan: ConversationCompactionPlan, summary: string): Promise<boolean>;
  flushActive(): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  toggleStar(id: string): Promise<void>;
  delete(id: string, fallback: NewConversationInput): Promise<void>;
  importJson(json: string): Promise<number>;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let hydrationPromise: Promise<void> | undefined;

function sortConversations(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) =>
    Number(right.starred) - Number(left.starred) || right.updatedAt - left.updatedAt);
}

function scheduleSave(conversation: Conversation) {
  const pending = saveTimers.get(conversation.id);
  if (pending) clearTimeout(pending);
  saveTimers.set(conversation.id, setTimeout(() => {
    saveTimers.delete(conversation.id);
    void saveConversation(conversation).catch((error) => {
      useConversationStore.setState({
        storageError: error instanceof Error ? error.message : "Unable to save the conversation.",
      });
    });
  }, 250));
}

async function flushConversation(conversation: Conversation | undefined) {
  if (!conversation) return;
  const pending = saveTimers.get(conversation.id);
  if (pending) {
    clearTimeout(pending);
    saveTimers.delete(conversation.id);
  }
  await saveConversation(conversation);
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
  conversations: [],
  hydrated: false,
  async hydrate(seed) {
    hydrationPromise ??= (async () => {
      try {
        const loaded = await loadConversationDatabase();
        let conversations = sortConversations(loaded.conversations);
        if (conversations.length === 0) {
          const initial = createConversation(seed);
          conversations = [initial];
          await Promise.all([saveConversation(initial), saveActiveConversationId(initial.id)]);
        }
        const activeConversationId = conversations.some((item) => item.id === loaded.activeConversationId)
          ? loaded.activeConversationId
          : conversations[0].id;
        set({ conversations, activeConversationId, hydrated: true, storageError: undefined });
      } catch (error) {
        const initial = createConversation(seed);
        set({
          conversations: [initial],
          activeConversationId: initial.id,
          hydrated: true,
          storageError: error instanceof Error ? error.message : "IndexedDB is unavailable.",
        });
      }
    })();
    await hydrationPromise;
  },
  async create(input) {
    await get().flushActive();
    const conversation = createConversation(input);
    set((state) => ({
      conversations: sortConversations([...state.conversations, conversation]),
      activeConversationId: conversation.id,
    }));
    try {
      await Promise.all([saveConversation(conversation), saveActiveConversationId(conversation.id)]);
      set({ storageError: undefined });
    } catch (error) {
      set({ storageError: error instanceof Error ? error.message : "Unable to create the conversation." });
    }
    return conversation;
  },
  async select(id) {
    const target = get().conversations.find((conversation) => conversation.id === id);
    if (!target || id === get().activeConversationId) return;
    await get().flushActive();
    set({ activeConversationId: id });
    try {
      await saveActiveConversationId(id);
      set({ storageError: undefined });
    } catch (error) {
      set({ storageError: error instanceof Error ? error.message : "Unable to remember the active conversation." });
    }
  },
  updateActiveModelSnapshot(modelSnapshot) {
    const activeId = get().activeConversationId;
    if (!activeId) return;
    let snapshot: Conversation | undefined;
    set((state) => ({
      conversations: state.conversations.map((conversation) => {
        if (conversation.id !== activeId) return conversation;
        if (conversation.modelSnapshot.transport === modelSnapshot.transport
          && conversation.modelSnapshot.baseUrl === modelSnapshot.baseUrl
          && conversation.modelSnapshot.modelId === modelSnapshot.modelId) {
          return conversation;
        }
        snapshot = conversationSchema.parse({
          ...conversation,
          modelSnapshot,
          updatedAt: Date.now(),
        });
        return snapshot;
      }),
    }));
    if (snapshot) scheduleSave(snapshot);
  },
  updateMessages(updater) {
    const activeId = get().activeConversationId;
    if (!activeId) return;
    let snapshot: Conversation | undefined;
    set((state) => ({
      conversations: sortConversations(state.conversations.map((conversation) => {
        if (conversation.id !== activeId) return conversation;
        const messages = updater(conversation.messages);
        const automaticTitle = conversation.title === "New conversation"
          ? deriveConversationTitle(messages)
          : undefined;
        snapshot = conversationSchema.parse({
          ...conversation,
          title: automaticTitle ?? conversation.title,
          updatedAt: Date.now(),
          messages,
        });
        return snapshot;
      })),
    }));
    if (snapshot) scheduleSave(snapshot);
  },
  async applyCompaction(plan, rawSummary) {
    let snapshot: Conversation | undefined;
    set((state) => ({
      conversations: sortConversations(state.conversations.map((conversation) => {
        if (conversation.id !== plan.conversationId) return conversation;
        snapshot = applyConversationCompaction(conversation, plan, rawSummary);
        return snapshot ?? conversation;
      })),
    }));
    if (!snapshot) return false;
    try {
      await flushConversation(snapshot);
      set({ storageError: undefined });
      return true;
    } catch (error) {
      set({ storageError: error instanceof Error ? error.message : "Unable to save compressed conversation memory." });
      return false;
    }
  },
  async flushActive() {
    const state = get();
    const active = state.conversations.find((conversation) => conversation.id === state.activeConversationId);
    try {
      await flushConversation(active);
      set({ storageError: undefined });
    } catch (error) {
      set({ storageError: error instanceof Error ? error.message : "Unable to save the conversation." });
    }
  },
  async rename(id, rawTitle) {
    const title = rawTitle.trim();
    if (!title) return;
    let snapshot: Conversation | undefined;
    set((state) => ({
      conversations: state.conversations.map((conversation) => {
        if (conversation.id !== id) return conversation;
        snapshot = conversationSchema.parse({ ...conversation, title, updatedAt: Date.now() });
        return snapshot;
      }),
    }));
    if (snapshot) await flushConversation(snapshot);
  },
  async toggleStar(id) {
    let snapshot: Conversation | undefined;
    set((state) => {
      const conversations = state.conversations.map((conversation) => {
        if (conversation.id !== id) return conversation;
        snapshot = conversationSchema.parse({ ...conversation, starred: !conversation.starred, updatedAt: Date.now() });
        return snapshot;
      });
      return { conversations: sortConversations(conversations) };
    });
    if (snapshot) await flushConversation(snapshot);
  },
  async delete(id, fallback) {
    const state = get();
    const pending = saveTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      saveTimers.delete(id);
    }
    let conversations = state.conversations.filter((conversation) => conversation.id !== id);
    if (conversations.length === 0) conversations = [createConversation(fallback)];
    const activeConversationId = state.activeConversationId === id
      ? conversations[0].id
      : state.activeConversationId;
    set({ conversations: sortConversations(conversations), activeConversationId });
    try {
      await deleteConversationRecord(id);
      const replacement = conversations.find((conversation) => conversation.id === activeConversationId);
      if (replacement) await Promise.all([saveConversation(replacement), saveActiveConversationId(replacement.id)]);
      set({ storageError: undefined });
    } catch (error) {
      set({ storageError: error instanceof Error ? error.message : "Unable to delete the conversation." });
    }
  },
  async importJson(json) {
    const payload = parseConversationExport(json);
    const existingIds = new Set(get().conversations.map((conversation) => conversation.id));
    const imported = payload.conversations.map((conversation) => {
      const id = existingIds.has(conversation.id) ? createConversationId() : conversation.id;
      existingIds.add(id);
      return conversationSchema.parse({ ...conversation, id });
    });
    if (imported.length === 0) return 0;
    const previousState = get();
    const active = previousState.conversations.find((conversation) =>
      conversation.id === previousState.activeConversationId);
    try {
      await flushConversation(active);
      await saveConversationImport(imported, imported[0].id);
      set({
        conversations: sortConversations([...previousState.conversations, ...imported]),
        activeConversationId: imported[0].id,
        storageError: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to import conversations.";
      set({ storageError: message });
      throw error instanceof Error ? error : new Error(message);
    }
    return imported.length;
  },
}));
