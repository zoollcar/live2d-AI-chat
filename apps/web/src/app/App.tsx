import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAgentRuntime, type AgentEvent, type ChatMessage } from "@/agent";
import type { StatusKind } from "@/agent/types";
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

interface Status {
  kind: StatusKind;
  message: string;
  progress?: number;
}

const STATUS_READY: Status = { kind: "idle", message: "Ready" };

export default function App() {
  const { settings, hydrated, hydrateSecrets } = useSettingsStore();
  const [scene, setScene] = useState<SceneController>();
  const [messages, setMessages] = useState<ChatMessage[]>([SYSTEM_MESSAGE]);
  const [input, setInput] = useState("");
  const [subtitle, setSubtitle] = useState("Loading the Live2D model…");
  const [status, setStatus] = useState<Status>({ kind: "busy", message: "Initializing stage" });
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
  // Set when the user submits a message by typing (form submit / Enter) so the
  // LLM `done` handler and Chrome's no-speech `onAutoEnd` know to skip the
  // mic auto-restart. Without this, after the AI replies to a typed message
  // the mic would pop back on whenever `settings.stt.continuous` is on —
  // which is wrong because the user explicitly chose to type rather than speak.
  const userTypedRef = useRef(false);

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
    setStatus({ kind: "busy", message: "AI is thinking" });
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
      } else if (event.type === "reasoning-delta") {
        // Append reasoning onto the trailing assistant message so the chat
        // history's "Thinking" section grows in sync with the stream. We
        // don't surface reasoning in the subtitle or send it to TTS — only
        // the visible reply text should be spoken aloud.
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + event.delta };
          }
          return next;
        });
      } else if (event.type === "status") {
        // Forward the structured status as-is so the chip can render the
        // correct colour/animation/progress bar. Drop `progress` when the
        // kind isn't `progress` to avoid a stale bar sticking around.
        const { kind, message, progress } = event;
        setStatus(kind === "progress" && typeof progress === "number"
          ? { kind, message, progress }
          : { kind, message });
      } else if (event.type === "tool-call") {
        // The registry emits this when a tool's execute() actually runs
        // (after the SDK parsed the input). Keep the chip consistent with
        // what we already announced in tool-input-start, and record the
        // call on the trailing assistant message so chat history can show
        // it later.
        setStatus({ kind: "busy", message: `Running tool: ${event.name}` });
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant") {
            const toolCalls = [...(last.toolCalls ?? []), { name: event.name, input: event.input }];
            next[next.length - 1] = { ...last, toolCalls };
          }
          return next;
        });
      } else if (event.type === "tool-result") {
        // The tool finished — patch its output onto the matching record so
        // chat history can show the input/output pair. The local runtime
        // runs tools sequentially and emits `tool-result` in execution order;
        // the remote runtime can fire them in parallel but each `tool-result`
        // event still carries the matching `name`. The last record whose
        // `name` matches and `output` is still unset is the one we just
        // finished.
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant" && last.toolCalls) {
            const toolCalls = last.toolCalls.map((record, index, records) => {
              if (record.name !== event.name) return record;
              if (record.output !== undefined) return record;
              // Guard against out-of-order results: only attach if this is
              // the earliest unmatched record with this name.
              const earlierUnmatched = records
                .slice(0, index)
                .some((other) => other.name === event.name && other.output === undefined);
              return earlierUnmatched ? record : { ...record, output: event.output };
            });
            next[next.length - 1] = { ...last, toolCalls };
          }
          return next;
        });
      } else if (event.type === "error") {
        setStatus({ kind: "error", message: `Error: ${event.error.message}` });
        setRunning(false);
      } else if (event.type === "done") {
        const remaining = segmenterRef.current.flush();
        if (remaining) speechQueueRef.current?.enqueue(remaining);
        setStatus(STATUS_READY);
        setRunning(false);
        // Auto-restart the mic so the next utterance flows without a click.
        // We use restartListening() (not startListening()) because Chrome's
        // `continuous: true` mode keeps the same recognition object alive and
        // starts returning empty-final noise from the AI's TTS bleeding into
        // the mic. A hard teardown + fresh session gives us a clean slate.
        // Skip this when the user just typed the message — they explicitly
        // chose text input, so the mic should stay off until they click it.
        if (continuousRef.current && !userTypedRef.current) {
          log.debug("agent done — auto-restarting listener (fresh session)");
          void restartListeningRef.current?.();
        }
        userTypedRef.current = false;
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
          if (next === "processing") {
            setStatus({ kind: "busy", message: "Transcribing speech" });
          } else if (next === "listening") {
            setStatus({ kind: "busy", message: "Listening" });
          } else {
            setStatus(STATUS_READY);
          }
        },
        onError: (error) => {
          log.error("onError", { message: error.message });
          setStatus({ kind: "error", message: `Speech recognition error: ${error.message}` });
          setListening(false);
          listeningRef.current = false;
        },
        onAutoEnd: () => {
          log.debug("onAutoEnd — recognition session ended on its own");
          setListening(false);
          listeningRef.current = false;
          // In continuous mode, reopen the mic after Chrome's no-speech
          // timeout. Guard against the case where the user toggled continuous
          // off mid-session and the LLM `done` is still pending. Also skip
          // when the user just typed their last message — they're using
          // text input and don't want the mic popping back on.
          if (continuousRef.current && !userTypedRef.current) {
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
      setStatus({ kind: "error", message: `Speech recognition error: ${error instanceof Error ? error.message : "Unavailable"}` });
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

  // Shared entry point for messages the user typed instead of spoke. Marks
  // the turn as typed so the auto-restart logic in the LLM `done` handler
  // (and Chrome's no-speech `onAutoEnd`) leave the mic off until the user
  // clicks it again. Called from both the form submit and the textarea
  // Enter-key path.
  const submitTypedMessage = useCallback((text: string) => {
    userTypedRef.current = true;
    void sendMessage(text);
  }, [sendMessage]);

  const onMicButtonClick = useCallback(async () => {
    if (running) {
      // Barge-in: stop the AI's playback and reopen the mic without making
      // the user click again. Leave continuous mode alone so the next reply
      // also auto-restarts. Clear the typed flag so this turn counts as a
      // voice interaction — the AI reply that follows should re-open the
      // mic just like a spoken utterance would.
      log.debug("mic click while running — interrupting AI and opening mic");
      userTypedRef.current = false;
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
    setStatus(STATUS_READY);
  }, []);

  const onStageError = useCallback((error: Error) => {
    setStatus({ kind: "error", message: `Model failed to load: ${error.message}` });
  }, []);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <Live2DStage onReady={onStageReady} onError={onStageError} />

      <header className="top-bar glass-panel">
        <div className="brand">
          <img className="brand-mark" src="/brand/ice-girl-logo.png" alt="" aria-hidden="true" />
          <div>
            <strong>Live2D AI</strong>
            <small className={`status-chip status-${status.kind}`} aria-live="polite">
              <span className="status-message">{status.message}</span>
              {status.kind === "progress" && typeof status.progress === "number" && (
                <span
                  className="status-progress"
                  role="progressbar"
                  aria-valuenow={Math.round(status.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
                </span>
              )}
            </small>
          </div>
        </div>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">⚙</button>
      </header>

      {visibleMessages.length === 0 && (
        <section className="conversation glass-panel" aria-live="polite">
          <div className="empty-copy"><p className="eyebrow">READY WHEN YOU ARE</p><h1>Start a conversation</h1><p>Type a message or use the microphone.</p></div>
        </section>
      )}

      {settings.subtitlesEnabled && subtitle && <div className="subtitle">{subtitle}</div>}

      <form className="composer glass-panel" onSubmit={(event) => { event.preventDefault(); submitTypedMessage(input); }}>
        <button type="button" className={`mic-button ${listening ? "active" : ""} ${running && !listening ? "interrupting" : ""}`} onClick={() => void onMicButtonClick()} aria-label={listening ? "Stop listening" : running ? "Interrupt AI" : "Start listening"}>●</button>
        <textarea rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submitTypedMessage(input);
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
