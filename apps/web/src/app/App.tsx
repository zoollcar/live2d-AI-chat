import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAgentRuntime, type AgentEvent, type ChatMessage } from "@/agent";
import { SYSTEM_MESSAGE } from "@/agent/system-prompt";
import { useSettingsStore } from "@/infrastructure/config/store";
import { createSttProvider, type SpeechRecognitionProvider } from "@/interaction/stt";
import { SpeechQueue } from "@/interaction/speech/speech-queue";
import { SentenceSegmenter } from "@/interaction/speech/sentence-segmenter";
import { createTtsProvider } from "@/interaction/tts";
import type { SceneController } from "@/model/live2d/scene-controller";
import { Live2DStage } from "@/presentation/stage/Live2DStage";

const SettingsPanel = lazy(() => import("@/presentation/settings/SettingsPanel")
  .then((module) => ({ default: module.SettingsPanel })));

export default function App() {
  const { settings, hydrated, hydrateSecrets } = useSettingsStore();
  const [scene, setScene] = useState<SceneController>();
  const [messages, setMessages] = useState<ChatMessage[]>([SYSTEM_MESSAGE]);
  const [input, setInput] = useState("");
  const [subtitle, setSubtitle] = useState("Loading the Live2D model…");
  const [status, setStatus] = useState("Initializing stage");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sttRef = useRef<SpeechRecognitionProvider | undefined>(undefined);
  const speechQueueRef = useRef<SpeechQueue | undefined>(undefined);
  const segmenterRef = useRef(new SentenceSegmenter());

  useEffect(() => {
    if (!hydrated) hydrateSecrets();
  }, [hydrateSecrets, hydrated]);

  useEffect(() => {
    if (!scene) return;
    speechQueueRef.current?.cancel();
    const provider = createTtsProvider(settings.tts);
    speechQueueRef.current = new SpeechQueue(provider, settings.tts, scene, setSubtitle);
    return () => speechQueueRef.current?.cancel();
  }, [scene, settings.tts]);

  const visibleMessages = useMemo(() => messages.filter((message) => message.role !== "system"), [messages]);

  const cancelCurrent = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = undefined;
    sttRef.current?.abort();
    sttRef.current = undefined;
    segmenterRef.current.reset();
    speechQueueRef.current?.cancel();
    setListening(false);
    setRunning(false);
  }, []);

  const sendMessage = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || !scene) return;
    cancelCurrent();
    const controller = new AbortController();
    abortRef.current = controller;
    const history: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setSubtitle(text);
    setStatus("AI is thinking");
    setRunning(true);
    const runtime = createAgentRuntime(settings.llm);

    const emit = (event: AgentEvent) => {
      if (event.type === "text-delta") {
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + event.delta };
          return next;
        });
        for (const sentence of segmenterRef.current.push(event.delta)) speechQueueRef.current?.enqueue(sentence);
      } else if (event.type === "status") {
        setStatus(event.message);
      } else if (event.type === "tool-call") {
        setStatus(`Running tool: ${event.name}`);
      } else if (event.type === "error") {
        setStatus(`Error: ${event.error.message}`);
        setRunning(false);
      } else if (event.type === "done") {
        const remaining = segmenterRef.current.flush();
        if (remaining) speechQueueRef.current?.enqueue(remaining);
        setStatus("Ready");
        setRunning(false);
      }
    };

    await runtime.run({ messages: history, settings: settings.llm, scene, signal: controller.signal, emit });
  }, [cancelCurrent, messages, scene, settings.llm]);

  const startListening = useCallback(async () => {
    cancelCurrent();
    sttRef.current?.abort();
    const provider = createSttProvider(settings.stt);
    sttRef.current = provider;
    try {
      await provider.start({
        onInterim: setSubtitle,
        onFinal: (text) => {
          setSubtitle(text);
          if (text) void sendMessage(text);
        },
        onStatus: (next) => {
          setListening(next === "listening");
          setStatus(next === "processing" ? "Transcribing speech" : next === "listening" ? "Listening" : "Ready");
        },
        onError: (error) => {
          setStatus(`Speech recognition error: ${error.message}`);
          setListening(false);
        },
      });
    } catch (error) {
      setStatus(`Speech recognition error: ${error instanceof Error ? error.message : "Unavailable"}`);
    }
  }, [cancelCurrent, sendMessage, settings.stt]);

  const stopListening = useCallback(async () => {
    await sttRef.current?.stop();
    setListening(false);
  }, []);

  const onStageReady = useCallback((controller: SceneController) => {
    setScene(controller);
    setSubtitle("");
    setStatus("Ready");
  }, []);

  const onStageError = useCallback((error: Error) => {
    setStatus(`Model failed to load: ${error.message}`);
  }, []);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <Live2DStage onReady={onStageReady} onError={onStageError} />

      <header className="top-bar glass-panel">
        <div className="brand"><span className="brand-mark">L2</span><div><strong>Live2D AI</strong><small>{status}</small></div></div>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">⚙</button>
      </header>

      <section className="conversation glass-panel" aria-live="polite">
        {visibleMessages.length === 0 ? (
          <div className="empty-copy"><p className="eyebrow">READY WHEN YOU ARE</p><h1>Start a conversation</h1><p>Type a message or use the microphone.</p></div>
        ) : (
          <div className="message-list">
            {visibleMessages.slice(-8).map((message, index) => (
              <div className={`message ${message.role}`} key={`${index}-${message.content.slice(0, 12)}`}>
                <span>{message.role === "user" ? "User" : "Assistant"}</span>
                <p>{message.content || "…"}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {settings.subtitlesEnabled && subtitle && <div className="subtitle">{subtitle}</div>}

      <form className="composer glass-panel" onSubmit={(event) => { event.preventDefault(); void sendMessage(input); }}>
        <button type="button" className={`mic-button ${listening ? "active" : ""}`} onClick={() => void (listening ? stopListening() : startListening())} aria-label={listening ? "Stop listening" : "Start listening"}>●</button>
        <textarea rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void sendMessage(input);
          }
        }} placeholder="Type a message…" />
        {running ? <button type="button" className="send-button stop" onClick={cancelCurrent}>■</button> : <button className="send-button" disabled={!scene || !input.trim()}>↑</button>}
      </form>

      {settingsOpen ? (
        <Suspense fallback={<div className="settings-loading">Loading settings…</div>}>
          <SettingsPanel open onClose={() => setSettingsOpen(false)}
            onTestStt={() => void startListening()}
            onTestTts={() => speechQueueRef.current?.enqueue("Hello, this is a speech synthesis test.")} />
        </Suspense>
      ) : null}
    </main>
  );
}
