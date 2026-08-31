import { useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import type { ResourceRef } from "@live2d-chat/shared";

const ACCEPTED_FILES = [
  ".pdf",
  ".docx",
  ".pptx",
  ".txt",
  ".md",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".svg",
].join(",");

const URL_TRAILING_PUNCTUATION = /[),.;!?\]}>'"]+$/;

export interface ComposerAttachment extends ResourceRef {
  errorMessage?: string;
}

export function extractComposerUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>]+/gi) ?? [];
  const urls = new Set<string>();
  for (const match of matches) {
    const candidate = match.replace(URL_TRAILING_PUNCTUATION, "");
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        parsed.hash = "";
        urls.add(parsed.toString());
      }
    } catch {
      // A partial URL stays ordinary composer text.
    }
  }
  return [...urls];
}

interface MessageComposerProps {
  value: string;
  attachments: readonly ComposerAttachment[];
  listening: boolean;
  running: boolean;
  sceneReady: boolean;
  onChange(value: string): void;
  onFiles(files: readonly File[]): void;
  onRecognizedUrls(urls: readonly string[]): void;
  onRemoveAttachment(resourceId: string): void;
  onMic(): void;
  onStop(): void;
  onSubmit(): void;
}

function filesFromList(files: FileList | null): File[] {
  return files ? [...files] : [];
}

export function MessageComposer({
  value,
  attachments,
  listening,
  running,
  sceneReady,
  onChange,
  onFiles,
  onRecognizedUrls,
  onRemoveAttachment,
  onMic,
  onStop,
  onSubmit,
}: MessageComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const readyAttachments = attachments.filter((attachment) => attachment.status === "ready");
  const sendableProcessingAttachments = attachments.filter((attachment) =>
    (attachment.status === "pending" || attachment.status === "processing")
    && (attachment.kind === "web" || attachment.kind === "video-transcript"));
  const blockingProcessing = attachments.some((attachment) =>
    (attachment.status === "pending" || attachment.status === "processing")
    && attachment.kind !== "web"
    && attachment.kind !== "video-transcript");
  const canSend = sceneReady
    && !blockingProcessing
    && (Boolean(value.trim()) || readyAttachments.length > 0 || sendableProcessingAttachments.length > 0);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (canSend) onSubmit();
  };

  const recognizeText = (text: string) => {
    const urls = extractComposerUrls(text);
    if (urls.length > 0) onRecognizedUrls(urls);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromList(event.clipboardData.files);
    if (files.length > 0) onFiles(files);
    recognizeText(event.clipboardData.getData("text/plain"));
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = filesFromList(event.dataTransfer.files);
    if (files.length > 0) onFiles(files);
    const droppedText = event.dataTransfer.getData("text/plain");
    if (droppedText) recognizeText(droppedText);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      className={`composer glass-panel${dragging ? " composer-dragging" : ""}`}
      onSubmit={submit}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {attachments.length > 0 ? (
        <div className="composer-attachments" aria-label="Pending attachments">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={`composer-attachment status-${attachment.status}`}
              title={attachment.errorMessage ?? attachment.name}
            >
              <span className="composer-attachment-type">{attachment.kind.toUpperCase()}</span>
              <span className="composer-attachment-name">{attachment.name}</span>
              <span className="composer-attachment-status">
                {attachment.status === "processing" || attachment.status === "pending"
                  ? "Processing"
                  : attachment.status === "error" ? "Failed" : "Ready"}
              </span>
              <button
                type="button"
                onClick={() => onRemoveAttachment(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="composer-row">
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept={ACCEPTED_FILES}
          multiple
          onChange={(event) => {
            onFiles(filesFromList(event.currentTarget.files));
            event.currentTarget.value = "";
          }}
        />
        <button type="button" className="attach-button" onClick={() => inputRef.current?.click()}>
          Attach
        </button>
        <button
          type="button"
          className={`mic-button ${listening ? "active" : ""} ${running && !listening ? "interrupting" : ""}`}
          onClick={onMic}
          aria-label={listening ? "Stop listening" : running ? "Interrupt AI" : "Start listening"}
        >
          Mic
        </button>
        <textarea
          rows={1}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={() => recognizeText(value)}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          placeholder="Type a message, paste a link, or attach a file…"
        />
        {running ? (
          <button type="button" className="send-button stop" onClick={onStop}>Stop</button>
        ) : (
          <button className="send-button" disabled={!canSend}>Send</button>
        )}
      </div>
      {dragging ? <div className="composer-drop-hint">Drop supported files here</div> : null}
    </form>
  );
}
