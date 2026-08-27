import { conversationSchema, type Conversation } from "@/model/conversation";

const DATABASE_NAME = "live2d-chat";
const DATABASE_VERSION = 1;
const CONVERSATIONS_STORE = "conversations";
const META_STORE = "meta";
const ACTIVE_CONVERSATION_KEY = "activeConversationId";

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  databasePromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        const store = database.createObjectStore(CONVERSATIONS_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open the conversation database."));
    request.onblocked = () => reject(new Error("Conversation database upgrade is blocked by another tab."));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
  return databasePromise;
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

export async function deleteConversationRecord(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CONVERSATIONS_STORE, "readwrite");
  transaction.objectStore(CONVERSATIONS_STORE).delete(id);
  await transactionDone(transaction);
}

export async function saveActiveConversationId(id: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(META_STORE, "readwrite");
  transaction.objectStore(META_STORE).put(id, ACTIVE_CONVERSATION_KEY);
  await transactionDone(transaction);
}
