import { useDeferredValue, useMemo, useRef, useState } from "react";
import type { ToolCallRecord } from "@/agent";
import { useCharacterStore } from "@/infrastructure/character/store";
import { useConversationStore } from "@/infrastructure/conversation/store";
import {
  exportConversationLibraryArchive,
  importConversationLibraryArchive,
} from "@/infrastructure/resources/conversation-archive";
import { resourceRepository } from "@/infrastructure/resources/indexed-db-v2";

interface Props {
  onClose(): void;
  onCreateConversation(): Promise<void>;
  onDeleteConversation(id: string): Promise<void>;
  onSelectConversation(id: string): Promise<void>;
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, raw) => {
      if (typeof raw === "function" || typeof raw === "symbol" || typeof raw === "bigint") return String(raw);
      if (raw && typeof raw === "object") {
        if (seen.has(raw as object)) return "[Circular]";
        seen.add(raw as object);
      }
      return raw;
    }, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ToolCallEntry({ call }: { call: ToolCallRecord }) {
  const outputText = call.canceled
    ? "Canceled before execution"
    : call.output !== undefined ? safeStringify(call.output) : call.error;
  return (
    <details className="history-tool-call">
      <summary>{call.name}</summary>
      <div className="history-tool-call-body">
        <div className="history-tool-call-block"><span className="history-tool-call-label">Input</span><pre>{safeStringify(call.input)}</pre></div>
        <div className="history-tool-call-block"><span className="history-tool-call-label">{call.error ? "Error" : "Output"}</span><pre>{outputText}</pre></div>
      </div>
    </details>
  );
}

function downloadConversations(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `live2d-chat-archive-${new Date().toISOString().slice(0, 10)}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ConversationLibrary({ onClose, onCreateConversation, onDeleteConversation, onSelectConversation }: Props) {
  const {
    conversations,
    activeConversationId,
    storageError,
    rename,
    toggleStar,
    importJson,
  } = useConversationStore();
  const profiles = useCharacterStore((state) => state.profiles);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const filtered = useMemo(() => {
    if (!deferredQuery) return conversations;
    return conversations.filter((conversation) =>
      conversation.title.toLowerCase().includes(deferredQuery)
      || conversation.summary?.content.toLowerCase().includes(deferredQuery)
      || conversation.messages.some((message) =>
        message.role !== "system" && message.content.toLowerCase().includes(deferredQuery)));
  }, [conversations, deferredQuery]);

  const run = async (action: () => Promise<void>, success?: string) => {
    try {
      await action();
      setStatus(success ?? "");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Conversation operation failed.");
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const previousActiveId = useConversationStore.getState().activeConversationId;
    setBusy(true);
    try {
      const result = await importConversationLibraryArchive({
        input: file,
        existingConversations: useConversationStore.getState().conversations,
        repository: resourceRepository,
        importConversations: async (payload) => {
          const count = await importJson(JSON.stringify(payload));
          const error = useConversationStore.getState().storageError;
          if (error) throw new Error(error);
          return count;
        },
      });
      const activeId = useConversationStore.getState().activeConversationId;
      if (activeId) await onSelectConversation(activeId);
      setStatus(`Imported ${result.count} conversation${result.count === 1 ? "" : "s"}${result.legacyJson ? " from legacy JSON" : " with resources"}.`);
    } catch (error) {
      if (previousActiveId) await onSelectConversation(previousActiveId).catch(() => undefined);
      setStatus(error instanceof Error ? error.message : "Unable to import conversations.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const exportAll = async () => {
    setBusy(true);
    try {
      downloadConversations(await exportConversationLibraryArchive(conversations, resourceRepository));
      setStatus(`Exported ${conversations.length} conversation${conversations.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to export conversations.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="history-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="history-dialog conversation-library" role="dialog" aria-modal="true" aria-labelledby="history-title" aria-busy={busy}>
        <header className="history-header">
          <div><p className="eyebrow">CONVERSATION LIBRARY</p><h2 id="history-title">Chat history</h2></div>
          <div className="history-header-actions">
            <button disabled={busy} onClick={() => void run(onCreateConversation, "Created a new conversation.")}>New</button>
            <button disabled={busy} onClick={() => void exportAll()}>Export ZIP</button>
            <button disabled={busy} onClick={() => fileInputRef.current?.click()}>Import</button>
            <button className="icon-button" onClick={onClose} aria-label="Close chat history">×</button>
          </div>
        </header>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/zip,application/json,.zip,.json" onChange={(event) => void importFile(event.target.files?.[0])} />
        <div className="conversation-library-body">
          <aside className="conversation-sidebar" aria-label="Conversations">
            <input className="conversation-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search conversations…" aria-label="Search conversations" />
            <div className="conversation-items">
              {filtered.map((conversation) => {
                const profile = profiles.find((item) => item.id === conversation.characterId);
                return (
                  <article className={`conversation-item${conversation.id === activeConversationId ? " active" : ""}`} key={conversation.id}>
                    <button className="conversation-select" onClick={() => void run(() => onSelectConversation(conversation.id))}>
                      <strong>{conversation.title}</strong>
                      <span>{profile?.name ?? `Missing: ${conversation.characterId}`} · {conversation.modelSnapshot.modelId}</span>
                      <time dateTime={new Date(conversation.updatedAt).toISOString()}>{new Date(conversation.updatedAt).toLocaleString()}</time>
                    </button>
                    <div className="conversation-item-actions">
                      <button onClick={() => void run(() => toggleStar(conversation.id))} aria-label={conversation.starred ? `Unstar ${conversation.title}` : `Star ${conversation.title}`}>{conversation.starred ? "★" : "☆"}</button>
                      <button onClick={() => {
                        const title = window.prompt("Conversation title", conversation.title);
                        if (title) void run(() => rename(conversation.id, title), "Conversation renamed.");
                      }} aria-label={`Rename ${conversation.title}`}>✎</button>
                      <button className="danger-button" onClick={() => {
                        if (window.confirm(`Delete “${conversation.title}”?`)) void run(() => onDeleteConversation(conversation.id), "Conversation deleted.");
                      }} aria-label={`Delete ${conversation.title}`}>×</button>
                    </div>
                  </article>
                );
              })}
              {filtered.length === 0 ? <div className="history-empty">No conversations match your search.</div> : null}
            </div>
          </aside>
          <div className="history-list" aria-label="Active conversation messages">
            {activeConversation?.summary ? (
              <details className="conversation-summary">
                <summary>Compressed memory · {activeConversation.summary.compactedMessageCount} older messages</summary>
                <p>{activeConversation.summary.content}</p>
              </details>
            ) : null}
            {activeConversation?.messages.filter((message) => message.role !== "system").map((message, index) => (
              <article className={`history-message ${message.role}`} key={`${index}-${message.role}`}>
                <span>
                  {message.role === "user" ? "User" : "Assistant"}
                  {message.inputMode === "voice" ? " · Voice" : ""}
                  {message.interrupted ? " · Interrupted" : ""}
                </span>
                <p>{message.transcriptUnavailable ? "Voice transcript unavailable" : message.content || "…"}</p>
                {message.role === "assistant" && message.reasoning ? (
                  <details className="history-thinking"><summary>Thinking</summary><pre>{message.reasoning}</pre></details>
                ) : null}
                {message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0 ? (
                  <details className="history-tool-calls">
                    <summary>Tool calls ({message.toolCalls.length})</summary>
                    <div className="history-tool-calls-list">
                      {message.toolCalls.map((call, callIndex) => <ToolCallEntry key={`${callIndex}-${call.name}`} call={call} />)}
                    </div>
                  </details>
                ) : null}
              </article>
            ))}
            {!activeConversation || activeConversation.messages.every((message) => message.role === "system") ? (
              <div className="history-empty">No messages yet. Start a conversation to see it here.</div>
            ) : null}
          </div>
        </div>
        {status || storageError ? <footer className="conversation-library-status" role="status">{status || storageError}</footer> : null}
      </section>
    </div>
  );
}
