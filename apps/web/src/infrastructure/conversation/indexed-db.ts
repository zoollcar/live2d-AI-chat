import { conversationSchema, type Conversation } from "@/model/conversation";
import { deleteConversationWithResources } from "@/infrastructure/resources/conversation-cascade";
import { openLive2dDatabaseV2, RESOURCE_STORE_NAMES } from "@/infrastructure/resources/indexed-db-v2";

const CONVERSATIONS_STORE = RESOURCE_STORE_NAMES.conversations;
const META_STORE = RESOURCE_STORE_NAMES.meta;
const ACTIVE_CONVERSATION_KEY = "activeConversationId";

function openDatabase(): Promise<IDBDatabase> {
  return openLive2dDatabaseV2();
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

export async function loadConversationDatabase(): Promise<{
  conversations: Conversation[];
  activeConversationId?: string;
}> {
  const database = await openDatabase();
  const transaction = database.transaction([CONVERSATIONS_STORE, META_STORE], "readonly");
  const conversationsRequest = transaction.objectStore(CONVERSATIONS_STORE).getAll();
  const activeRequest = transaction.objectStore(META_STORE).get(ACTIVE_CONVERSATION_KEY);
  const [records, activeConversationId] = await Promise.all([
    requestResult(conversationsRequest),
    requestResult(activeRequest),
    transactionDone(transaction),
  ]);
  const conversations = records.flatMap((record) => {
    const result = conversationSchema.safeParse(record);
    return result.success ? [result.data] : [];
  });
  return {
    conversations,
    activeConversationId: typeof activeConversationId === "string" ? activeConversationId : undefined,
  };
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CONVERSATIONS_STORE, "readwrite");
  transaction.objectStore(CONVERSATIONS_STORE).put(conversationSchema.parse(conversation));
  await transactionDone(transaction);
}

export async function saveConversations(conversations: readonly Conversation[]): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CONVERSATIONS_STORE, "readwrite");
  const store = transaction.objectStore(CONVERSATIONS_STORE);
  for (const conversation of conversations) store.put(conversationSchema.parse(conversation));
  await transactionDone(transaction);
}

export async function saveConversationImport(
  conversations: readonly Conversation[],
  activeConversationId: string,
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([CONVERSATIONS_STORE, META_STORE], "readwrite");
  const conversationStore = transaction.objectStore(CONVERSATIONS_STORE);
  for (const conversation of conversations) conversationStore.put(conversationSchema.parse(conversation));
  transaction.objectStore(META_STORE).put(activeConversationId, ACTIVE_CONVERSATION_KEY);
  await transactionDone(transaction);
}

export async function deleteConversationRecord(id: string): Promise<void> {
  await deleteConversationWithResources(id);
}

export async function saveActiveConversationId(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  transaction.objectStore(META_STORE).put(id, ACTIVE_CONVERSATION_KEY);
  await transactionDone(transaction);
}
