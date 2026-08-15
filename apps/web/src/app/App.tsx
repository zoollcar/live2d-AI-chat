import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAgentRuntime, type AgentEvent, type ChatMessage } from "@/agent";
import { SYSTEM_MESSAGE } from "@/agent/system-prompt";
import { useSettingsStore } from "@/infrastructure/config/store";
import { createLogger } from "@/infrastructure/log";
import { createSttProvider, type SpeechRecognitionProvider } from "@/interaction/stt";
import { SpeechQueue } from "@/interaction/speech/speech-queue";
import { SentenceSegmenter } from "@/interaction/speech/sentence-segmenter";
import { createTtsProvider } from "@/interaction/tts";
import type { SceneController } from "@/model/live2d/scene-controller";
import { Live2DStage } from "@/presentation/stage/Live2DStage";

const log = createLogger("app");

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
  // Tracks whether continuous recognition should be active across turns so the
  // auto-restart effect can decide whether to reopen the mic once the AI is
  // done talking. The ref (not state) is read inside async callbacks where we
  // don't want a stale closure to over- or under-restart STT.
  const continuousRef = useRef(false);
  // Mirrors `listening` as a ref so async callbacks can ask "is the mic still
  // supposed to be on right now?" without re-creating callbacks on every state
  // change.
  const listeningRef = useRef(false);

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

  // Mirror `messages` into a ref so `sendMessage` can read the latest history
  // snapshot regardless of which version of the callback actually runs.
  // Without this, `useCallback([..., messages, ...])` would recreate
  // sendMessage on every message update, but the recognition callbacks that
  // fire onFinal would still hold the first version and replay the original
  // exchange forever.
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const visibleMessages = useMemo(() => messages.filter((message) => message.role !== "system"), [messages]);

  // Full teardown — used when the user explicitly wants to leave the
  // conversation (escape, close tab, switch provider, etc.). Stops the LLM
  // stream, the TTS queue and the mic.
  const stopEverything = useCallback(() => {
    log.debug("stopEverything invoked", { hadAbort: !!abortRef.current, hadStt: !!sttRef.current });
    abortRef.current?.abort();
    abortRef.current = undefined;
    sttRef.current?.abort();
    sttRef.current = undefined;
    segmenterRef.current.reset();
    speechQueueRef.current?.cancel();
    listeningRef.current = false;
    continuousRef.current = false;
    setListening(false);
    setRunning(false);
  }, []);

  // Soft interrupt — stops the AI's current LLM stream and any in-flight TTS
  // but leaves the STT session alive so the user can barge in with another
  // utterance without re-clicking the mic. Used by `onFinal` and the mic
  // button's "interrupt" action.
  const interruptPlayback = useCallback(() => {
    log.debug("interruptPlayback invoked", { hadAbort: !!abortRef.current });
    abortRef.current?.abort();
    abortRef.current = undefined;
    segmenterRef.current.reset();
    speechQueueRef.current?.cancel();
    setRunning(false);
  }, []);

  const sendMessage = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || !scene) return;
    // Only stop the AI's playback; keep STT alive so continuous listeners can
    // barge in without re-clicking the mic.
    interruptPlayback();
    const controller = new AbortController();
    abortRef.current = controller;
    // Read the latest history from the ref so this callback works correctly
    // even when called from a stale closure (e.g. the onFinal handler that was
    // registered before subsequent messages were appended).
    const history: ChatMessage[] = [...messagesRef.current, { role: "user", content: text }];
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
        // Auto-restart the mic so the next utterance flows without a click.
        // We use restartListening() (not startListening()) because Chrome's
        // `continuous: true` mode keeps the same recognition object alive and
        // starts returning empty-final noise from the AI's TTS bleeding into
        // the mic. A hard teardown + fresh session gives us a clean slate.
        if (continuousRef.current) {
          log.debug("agent done — auto-restarting listener (fresh session)");
          void restartListeningRef.current?.();
        }
      }
    };

    await runtime.run({ messages: history, settings: settings.llm, scene, signal: controller.signal, emit });
  }, [interruptPlayback, scene, settings.llm]);

  // startListeningRef mirrors `startListening` so async callbacks above can
  // reach the latest version without rebuilding sendMessage every time STT
  // settings change.
  const startListeningRef = useRef<(() => Promise<void>) | undefined>(undefined);
  // sendMessageRef mirrors `sendMessage` so the recognition callbacks
  // registered in startListening() always reach the version built against the
  // latest `messages` snapshot. Without this, the first onFinal wires up
  // callbacks that close over `messages` at that instant; subsequent turns
  // would then build history from the stale array and either repeat the first
  // exchange or send a history missing the LLM's previous reply.
  const sendMessageRef = useRef<((text: string) => Promise<void>) | undefined>(undefined);

  const startListening = useCallback(async () => {
    log.debug("startListening: invoked", { provider: settings.stt.provider, lang: settings.stt.language });
    // Tear down any prior STT instance — this is the only safe path that
    // touches the mic. sendMessage() no longer aborts STT, so this is the
    // sole place that does.
    sttRef.current?.abort();
    sttRef.current = undefined;
    const provider = createSttProvider(settings.stt);
    log.debug("startListening: provider created", { id: provider.id, isSupported: provider.isSupported() });
    sttRef.current = provider;
    try {
      await provider.start({
        onInterim: (text) => {
          log.debug("onInterim", { length: text.length, text });
          setSubtitle(text);
        },
        onFinal: (text) => {
          log.debug("onFinal", { length: text.length, text });
          setSubtitle(text);
          if (!text) return;
          // Barge-in: cut the AI's playback but keep this STT session alive
          // so the next utterance flows through the same recognition stream.
          interruptPlayback();
          // Go through the ref so we always invoke the version of sendMessage
          // built against the latest `messages`, not the one captured when
          // these callbacks were first registered.
          void sendMessageRef.current?.(text);
        },
        onStatus: (next) => {
          log.debug("onStatus", { next });
          setListening(next === "listening");
          listeningRef.current = next === "listening";
          setStatus(next === "processing" ? "Transcribing speech" : next === "listening" ? "Listening" : "Ready");
        },
        onError: (error) => {
          log.error("onError", { message: error.message });
          setStatus(`Speech recognition error: ${error.message}`);
          setListening(false);
          listeningRef.current = false;
        },
        onAutoEnd: () => {
          log.debug("onAutoEnd — recognition session ended on its own");
          setListening(false);
          listeningRef.current = false;
          // In continuous mode, reopen the mic after Chrome's no-speech
          // timeout. Guard against the case where the user toggled continuous
          // off mid-session and the LLM `done` is still pending.
          if (continuousRef.current) {
            log.debug("onAutoEnd — continuous mode, restarting mic");
            void restartListeningRef.current?.();
          }
        },
      });
      log.debug("startListening: provider.start() resolved");
    } catch (error) {
      log.error("startListening: provider.start() threw", { error: String(error) });
      if (sttRef.current === provider) {
        sttRef.current?.abort();
        sttRef.current = undefined;
      }
      setStatus(`Speech recognition error: ${error instanceof Error ? error.message : "Unavailable"}`);
      setListening(false);
      listeningRef.current = false;
    }
  }, [interruptPlayback, settings.stt]);

  // Force a clean STT session: abort whatever's running and start fresh. This
  // is what the auto-restart path uses after the LLM finishes speaking,
  // because Chrome's `continuous: true` mode never fires `onend` on its own —
  // it keeps the same recognition object alive across turns and starts
  // returning bogus empty-final results once the AI's TTS bleeds into the
  // mic. A hard restart gives us a clean Chrome session per turn.
  const restartListening = useCallback(async () => {
    log.debug("restartListening: tearing down STT for fresh session");
    sttRef.current?.abort();
    sttRef.current = undefined;
    setListening(false);
    listeningRef.current = false;
    // Small grace period so the user can hear the AI's last sentence fully
    // before the mic reopens — keeps feedback from being interpreted as the
    // user's next utterance.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await startListeningRef.current?.();
  }, []);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  // restartListeningRef mirrors restartListening for the same reason — the
  // recognition callbacks and the LLM's emit() handler both need the latest
  // version without rebuilding sendMessage on every render.
  const restartListeningRef = useRef<(() => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    restartListeningRef.current = restartListening;
  }, [restartListening]);

  const stopListening = useCallback(async () => {
    log.debug("stopListening: invoked");
    continuousRef.current = false;
    await sttRef.current?.stop();
    setListening(false);
    listeningRef.current = false;
    log.debug("stopListening: stopped");
  }, []);

  const onMicButtonClick = useCallback(async () => {
    if (running) {
      // Barge-in: stop the AI's playback and reopen the mic without making
      // the user click again. Leave continuous mode alone so the next reply
      // also auto-restarts.
      log.debug("mic click while running — interrupting AI and opening mic");
      interruptPlayback();
      if (!listeningRef.current) await startListening();
      return;
    }
    if (listeningRef.current) {
      log.debug("mic click while listening — stopping");
      await stopListening();
    } else {
      log.debug("mic click while idle — starting continuous listening");
      continuousRef.current = settings.stt.continuous;
      await startListening();
    }
  }, [interruptPlayback, running, settings.stt.continuous, startListening, stopListening]);

  // When the user toggles the "Continuous recognition" setting on while idle,
  // we want the next click of the mic (or a fresh click cycle) to behave
  // accordingly. When they toggle it off mid-session, immediately stop so the
  // auto-restart doesn't kick in after the next AI reply.
  useEffect(() => {
    continuousRef.current = settings.stt.continuous;
    if (!settings.stt.continuous && !running && listeningRef.current) {
      void stopListening();
    }
  }, [running, settings.stt.continuous, stopListening]);

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

      {visibleMessages.length === 0 && (
        <section className="conversation glass-panel" aria-live="polite">
          <div className="empty-copy"><p className="eyebrow">READY WHEN YOU ARE</p><h1>Start a conversation</h1><p>Type a message or use the microphone.</p></div>
        </section>
      )}

      {settings.subtitlesEnabled && subtitle && <div className="subtitle">{subtitle}</div>}

      <form className="composer glass-panel" onSubmit={(event) => { event.preventDefault(); void sendMessage(input); }}>
        <button type="button" className={`mic-button ${listening ? "active" : ""} ${running && !listening ? "interrupting" : ""}`} onClick={() => void onMicButtonClick()} aria-label={listening ? "Stop listening" : running ? "Interrupt AI" : "Start listening"}>●</button>
        <textarea rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void sendMessage(input);
          }
        }} placeholder="Type a message…" />
        {running ? <button type="button" className="send-button stop" onClick={() => { continuousRef.current = false; stopEverything(); }}>■</button> : <button className="send-button" disabled={!scene || !input.trim()}>↑</button>}
      </form>

      {settingsOpen ? (
        <Suspense fallback={<div className="settings-loading">Loading settings…</div>}>
          <SettingsPanel open onClose={() => setSettingsOpen(false)}
            messages={visibleMessages}
            onTestStt={() => void startListening()}
            onTestTts={() => speechQueueRef.current?.enqueue("Hello, this is a speech synthesis test.")} />
        </Suspense>
      ) : null}
    </main>
  );
}
