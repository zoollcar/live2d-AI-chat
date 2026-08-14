import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAgentRuntime, type AgentEvent, type ChatMessage } from "@/agent";
import { useSettingsStore } from "@/infrastructure/config/store";
import { createSttProvider, type SpeechRecognitionProvider } from "@/interaction/stt";
import { SpeechQueue } from "@/interaction/speech/speech-queue";
import { SentenceSegmenter } from "@/interaction/speech/sentence-segmenter";
import { createTtsProvider } from "@/interaction/tts";
import type { SceneController } from "@/model/live2d/scene-controller";
import { Live2DStage } from "@/presentation/stage/Live2DStage";

const SettingsPanel = lazy(() => import("@/presentation/settings/SettingsPanel")
  .then((module) => ({ default: module.SettingsPanel })));

const systemMessage: ChatMessage = {
  role: "system",
  content: "You are a playful Live2D companion. Be concise, warm, subjective, and entertaining.",
};

export default function App() {
  const { settings, hydrated, hydrateSecrets } = useSettingsStore();
  const [scene, setScene] = useState<SceneController>();
  const [messages, setMessages] = useState<ChatMessage[]>([systemMessage]);
  const [input, setInput] = useState("");
  const [subtitle, setSubtitle] = useState("正在载入 Ice Girl…");
  const [status, setStatus] = useState("初始化舞台");
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
    setStatus("AI 正在思考");
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
        setStatus(`执行工具：${event.name}`);
      } else if (event.type === "error") {
        setStatus(`错误：${event.error.message}`);
        setRunning(false);
      } else if (event.type === "done") {
        const remaining = segmenterRef.current.flush();
        if (remaining) speechQueueRef.current?.enqueue(remaining);
        setStatus("就绪");
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
          setStatus(next === "processing" ? "正在识别语音" : next === "listening" ? "正在聆听" : "就绪");
        },
        onError: (error) => {
          setStatus(`语音识别错误：${error.message}`);
          setListening(false);
        },
      });
    } catch (error) {
      setStatus(`语音识别错误：${error instanceof Error ? error.message : "不可用"}`);
    }
  }, [cancelCurrent, sendMessage, settings.stt]);

  const stopListening = useCallback(async () => {
    await sttRef.current?.stop();
    setListening(false);
  }, []);

  const onStageReady = useCallback((controller: SceneController) => {
    setScene(controller);
    setSubtitle("你好，想聊点什么？");
    setStatus("就绪");
  }, []);

  const onStageError = useCallback((error: Error) => {
    setStatus(`模型载入失败：${error.message}`);
  }, []);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <Live2DStage onReady={onStageReady} onError={onStageError} />

      <header className="top-bar glass-panel">
        <div className="brand"><span className="brand-mark">L2</span><div><strong>Live2D AI Chat</strong><small>{status}</small></div></div>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="打开设置">⚙</button>
      </header>

      <section className="conversation glass-panel" aria-live="polite">
        {visibleMessages.length === 0 ? (
          <div className="empty-copy"><p className="eyebrow">READY WHEN YOU ARE</p><h1>和 Ice Girl 聊聊天</h1><p>可以打字，也可以按住舞台下方的麦克风开始说话。</p></div>
        ) : (
          <div className="message-list">
            {visibleMessages.slice(-8).map((message, index) => (
              <div className={`message ${message.role}`} key={`${index}-${message.content.slice(0, 12)}`}>
                <span>{message.role === "user" ? "你" : "Ice Girl"}</span>
                <p>{message.content || "…"}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {settings.subtitlesEnabled && subtitle && <div className="subtitle">{subtitle}</div>}

      <form className="composer glass-panel" onSubmit={(event) => { event.preventDefault(); void sendMessage(input); }}>
        <button type="button" className={`mic-button ${listening ? "active" : ""}`} onClick={() => void (listening ? stopListening() : startListening())} aria-label={listening ? "停止识别" : "开始识别"}>●</button>
        <textarea rows={1} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void sendMessage(input);
          }
        }} placeholder="输入消息…" />
        {running ? <button type="button" className="send-button stop" onClick={cancelCurrent}>■</button> : <button className="send-button" disabled={!scene || !input.trim()}>↑</button>}
      </form>

      {settingsOpen ? (
        <Suspense fallback={<div className="settings-loading">正在加载设置…</div>}>
          <SettingsPanel open onClose={() => setSettingsOpen(false)}
            onTestStt={() => void startListening()}
            onTestTts={() => speechQueueRef.current?.enqueue("你好，这是语音合成测试。")} />
        </Suspense>
      ) : null}
    </main>
  );
}
