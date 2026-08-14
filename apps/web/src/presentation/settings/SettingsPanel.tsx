import type { LlmSettings, SttSettings, TtsSettings } from "@live2d-chat/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  downloadLocalModel,
  getLocalModelPartialProgress,
  isLocalModelDownloaded,
  localModelPresets,
} from "@/agent/local-models";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import { useSettingsStore } from "@/infrastructure/config/store";
import { downloadVitsVoice, getVitsVoicePartialProgress, isVitsVoiceDownloaded } from "@/interaction/tts/model-download";

interface Props {
  open: boolean;
  onClose(): void;
  onTestStt(): void;
  onTestTts(): void;
}

interface ModelOption {
  label: string;
  value: string;
}

const customValue = "__custom__";
const languages = [
  { label: "English", value: "en-US" },
  { label: "Chinese", value: "zh-CN" },
];
const llmUrlPresets = [
  { label: "Built-in Hono proxy", value: "/api/llm/v1" },
  { label: "OpenAI", value: "https://api.openai.com/v1" },
  { label: "Ollama", value: "http://127.0.0.1:11434/v1" },
  { label: "LM Studio", value: "http://127.0.0.1:1234/v1" },
] as const;
const openAiLlmModels: ModelOption[] = [
  { label: "GPT-4.1 mini · Recommended", value: "gpt-4.1-mini" },
  { label: "GPT-4o mini · Fast and economical", value: "gpt-4o-mini" },
  { label: "GPT-4.1 · Higher quality", value: "gpt-4.1" },
];
const ollamaModels: ModelOption[] = [
  { label: "Qwen 3.5 0.8B · Lightweight", value: "qwen3.5:0.8b" },
  { label: "Qwen 3 1.7B · Balanced", value: "qwen3:1.7b" },
  { label: "Llama 3.2 1B · Lightweight", value: "llama3.2:1b" },
];
const sttModels: ModelOption[] = [
  { label: "GPT-4o mini Transcribe · Recommended", value: "gpt-4o-mini-transcribe" },
  { label: "GPT-4o Transcribe · Higher quality", value: "gpt-4o-transcribe" },
  { label: "Whisper 1 · Compatible", value: "whisper-1" },
];
const ttsModels: ModelOption[] = [
  { label: "GPT-4o mini TTS · Recommended", value: "gpt-4o-mini-tts" },
  { label: "TTS 1 · Low latency", value: "tts-1" },
  { label: "TTS 1 HD · Higher quality", value: "tts-1-hd" },
];
const localVoices: Record<string, ModelOption[]> = {
  "en-US": [
    { label: "HFC Female · Recommended", value: "en_US-hfc_female-medium" },
    { label: "HFC Male", value: "en_US-hfc_male-medium" },
  ],
  "zh-CN": [
    { label: "Huayan · Standard", value: "zh_CN-huayan-medium" },
    { label: "Huayan · Lightweight", value: "zh_CN-huayan-x_low" },
  ],
};

export function SettingsPanel({ open, onClose, onTestStt, onTestTts }: Props) {
  const { settings, updateLlm, updateStt, updateTts, setSubtitlesEnabled, reset } = useSettingsStore();
  const [connectionStatus, setConnectionStatus] = useState("");
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [localDownloaded, setLocalDownloaded] = useState<Record<string, boolean>>({});
  const [voiceDownloaded, setVoiceDownloaded] = useState<Record<string, boolean>>({});
  const [llmProgress, setLlmProgress] = useState<number>();
  const [voiceProgress, setVoiceProgress] = useState<number>();
  const [llmResumeProgress, setLlmResumeProgress] = useState(0);
  const [voiceResumeProgress, setVoiceResumeProgress] = useState(0);
  const [llmDownloadStatus, setLlmDownloadStatus] = useState("");
  const [voiceDownloadStatus, setVoiceDownloadStatus] = useState("");
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  const llmAbortRef = useRef<AbortController | undefined>(undefined);
  const voiceAbortRef = useRef<AbortController | undefined>(undefined);

  const llmOptions = useMemo(() => {
    if (settings.llm.transport === "local") {
      return localModelPresets.map((model) => ({
        label: `${model.label} · ${model.size}`,
        value: model.id,
      }));
    }
    const presets = settings.llm.transport === "proxy"
      ? [...ollamaModels, ...openAiLlmModels]
      : settings.llm.baseUrl.includes("11434")
        ? ollamaModels
        : openAiLlmModels;
    const known = new Set(presets.map(({ value }) => value));
    return [
      ...presets,
      ...discoveredModels.filter((model) => !known.has(model)).map((model) => ({ label: model, value: model })),
    ];
  }, [discoveredModels, settings.llm.baseUrl, settings.llm.transport]);

  const currentVoices = localVoices[settings.tts.language] || localVoices["en-US"];
  const filteredBrowserVoices = useMemo(() => {
    const language = settings.tts.language.split("-")[0].toLowerCase();
    return browserVoices.filter((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === language);
  }, [browserVoices, settings.tts.language]);
  const selectedBrowserVoice = filteredBrowserVoices.find((voice) =>
    voice.voiceURI === settings.tts.voice || voice.name === settings.tts.voice);

  useEffect(() => {
    if (!open || settings.llm.transport !== "local") return;
    let active = true;
    void Promise.all(localModelPresets.map(async ({ id }) => [id, await isLocalModelDownloaded(id)] as const))
      .then((entries) => active && setLocalDownloaded(Object.fromEntries(entries)))
      .catch(() => undefined);
    return () => { active = false; };
  }, [open, settings.llm.transport]);

  useEffect(() => {
    if (!open || settings.llm.transport !== "local" || localDownloaded[settings.llm.modelId]) {
      setLlmResumeProgress(0);
      return;
    }
    let active = true;
    void getLocalModelPartialProgress(settings.llm.modelId)
      .then((progress) => active && setLlmResumeProgress(progress))
      .catch(() => undefined);
    return () => { active = false; };
  }, [localDownloaded, open, settings.llm.modelId, settings.llm.transport]);

  useEffect(() => {
    if (!open || settings.tts.provider !== "vits-local") return;
    let active = true;
    void Promise.all(Object.values(localVoices).flat().map(async ({ value }) => [value, await isVitsVoiceDownloaded(value)] as const))
      .then((entries) => active && setVoiceDownloaded(Object.fromEntries(entries)))
      .catch(() => undefined);
    return () => { active = false; };
  }, [open, settings.tts.provider]);

  useEffect(() => {
    if (!open || settings.tts.provider !== "vits-local" || voiceDownloaded[settings.tts.voice]) {
      setVoiceResumeProgress(0);
      return;
    }
    let active = true;
    void getVitsVoicePartialProgress(settings.tts.voice)
      .then((progress) => active && setVoiceResumeProgress(progress))
      .catch(() => undefined);
    return () => { active = false; };
  }, [open, settings.tts.provider, settings.tts.voice, voiceDownloaded]);

  useEffect(() => () => {
    llmAbortRef.current?.abort();
    voiceAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!open || settings.tts.provider !== "browser-speech" || !("speechSynthesis" in window)) return;
    const updateVoices = () => setBrowserVoices([...window.speechSynthesis.getVoices()]);
    updateVoices();
    window.speechSynthesis.addEventListener("voiceschanged", updateVoices);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", updateVoices);
  }, [open, settings.tts.provider]);

  useEffect(() => {
    if (settings.tts.provider !== "browser-speech" || filteredBrowserVoices.length === 0) return;
    const selectedExists = filteredBrowserVoices.some((voice) =>
      voice.voiceURI === settings.tts.voice || voice.name === settings.tts.voice);
    if (!selectedExists) updateTts({ voice: filteredBrowserVoices[0].voiceURI });
  }, [filteredBrowserVoices, settings.tts.provider, settings.tts.voice, updateTts]);

  if (!open) return null;

  const testConnection = async () => {
    if (settings.llm.transport === "local") {
      setConnectionStatus("Checking model files…");
      try {
        const downloaded = await isLocalModelDownloaded(settings.llm.modelId);
        setLocalDownloaded((current) => ({ ...current, [settings.llm.modelId]: downloaded }));
        setConnectionStatus(downloaded ? "Test passed: the model files are complete and ready to load." : "The model has not been downloaded yet.");
      } catch (error) {
        setConnectionStatus(`Check failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
      return;
    }
    setConnectionStatus("Connecting…");
    try {
      const response = await fetch(`${normalizeBaseUrl(settings.llm.baseUrl)}/models`, {
        headers: settings.llm.apiKey ? { authorization: `Bearer ${settings.llm.apiKey}` } : undefined,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = payload.data?.flatMap((model) => (model.id ? [model.id] : [])) || [];
      setDiscoveredModels(ids);
      setConnectionStatus(`Connected. Found ${ids.length} available model${ids.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setConnectionStatus(`Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const downloadLlm = async () => {
    if (!settings.llm.modelId.trim()) return;
    const controller = new AbortController();
    llmAbortRef.current = controller;
    setLlmProgress(llmResumeProgress);
    setLlmDownloadStatus(llmResumeProgress > 0 ? "Resuming the download…" : "Preparing the language model download…");
    try {
      await downloadLocalModel(settings.llm.modelId, setLlmProgress, controller.signal);
      setLocalDownloaded((current) => ({ ...current, [settings.llm.modelId]: true }));
      setLlmResumeProgress(0);
      setLlmDownloadStatus("The language model has been downloaded and saved in your browser.");
    } catch (error) {
      if (controller.signal.aborted) {
        setLlmDownloadStatus("Download paused. Your progress has been saved.");
      } else {
        setLlmDownloadStatus(`Download failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    } finally {
      llmAbortRef.current = undefined;
      setLlmProgress(undefined);
      void getLocalModelPartialProgress(settings.llm.modelId).then(setLlmResumeProgress).catch(() => undefined);
    }
  };

  const downloadVoice = async () => {
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    setVoiceProgress(voiceResumeProgress);
    setVoiceDownloadStatus(voiceResumeProgress > 0 ? "Resuming the voice model download…" : "Downloading the voice model…");
    try {
      await downloadVitsVoice(settings.tts.voice, setVoiceProgress, controller.signal);
      setVoiceDownloaded((current) => ({ ...current, [settings.tts.voice]: true }));
      setVoiceResumeProgress(0);
      setVoiceDownloadStatus("The voice model has been downloaded and saved in your browser.");
    } catch (error) {
      if (controller.signal.aborted) {
        setVoiceDownloadStatus("Download paused. Your progress has been saved.");
      } else {
        setVoiceDownloadStatus(`Download failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    } finally {
      voiceAbortRef.current = undefined;
      setVoiceProgress(undefined);
      void getVitsVoicePartialProgress(settings.tts.voice).then(setVoiceResumeProgress).catch(() => undefined);
    }
  };

  return (
    <div className="settings-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="settings-panel" aria-label="Settings">
        <header className="settings-header">
          <div><p className="eyebrow">CONFIGURATION</p><h2>Settings</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">×</button>
        </header>

        <section className="settings-section">
          <h3>Language model</h3>
          <Field label="Connection">
            <select value={settings.llm.transport} onChange={(event) => {
              const transport = event.target.value as LlmSettings["transport"];
              updateLlm({
                transport,
                modelId: transport === "local"
                  ? localModelPresets[0].id
                  : settings.llm.transport === "local"
                    ? (transport === "proxy" ? ollamaModels[0].value : openAiLlmModels[0].value)
                    : settings.llm.modelId,
                baseUrl: transport === "proxy" ? "/api/llm/v1" : transport === "direct" && settings.llm.baseUrl.startsWith("/") ? "https://api.openai.com/v1" : settings.llm.baseUrl,
              });
              setConnectionStatus("");
            }}>
              <option value="proxy">Built-in Hono proxy</option>
              <option value="direct">Direct OpenAI-compatible API</option>
              <option value="local">Local wllama in the browser</option>
            </select>
          </Field>
          {settings.llm.transport !== "local" && (
            <>
              <Field label="URL preset">
                <select value={llmUrlPresets.some(({ value }) => value === settings.llm.baseUrl) ? settings.llm.baseUrl : customValue} onChange={(event) => {
                  if (event.target.value !== customValue) updateLlm({ baseUrl: event.target.value });
                }}>
                  {llmUrlPresets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                  <option value={customValue}>Custom OpenAI-compatible API</option>
                </select>
              </Field>
              <Field label="API URL"><input value={settings.llm.baseUrl} onChange={(event) => updateLlm({ baseUrl: event.target.value })} /></Field>
              <SecretField value={settings.llm.apiKey} remember={settings.llm.rememberApiKey} onChange={(apiKey) => updateLlm({ apiKey })} onRemember={(rememberApiKey) => updateLlm({ rememberApiKey })} />
            </>
          )}
          <ModelChoiceField
            label="Model"
            value={settings.llm.modelId}
            options={llmOptions}
            downloaded={settings.llm.transport === "local" ? localDownloaded : undefined}
            searchUrl={(query) => settings.llm.transport === "local" ? huggingFaceSearch(query) : modelWebSearch(query)}
            onChange={(modelId) => updateLlm({ modelId })}
          />
          {settings.llm.transport === "local" && <DownloadProgress progress={llmProgress ?? (llmResumeProgress || undefined)} status={llmDownloadStatus} />}
          <div className="settings-actions">
            {settings.llm.transport === "local" && (llmProgress === undefined
              ? <button className="primary-button" onClick={() => void downloadLlm()}>{llmResumeProgress > 0 ? "▶ Resume download" : "↓ Download model"}</button>
              : <button className="pause-button" onClick={() => llmAbortRef.current?.abort()}>Ⅱ Pause download</button>)}
            <button onClick={() => void testConnection()}>Test connection</button>
          </div>
          {connectionStatus && <span className="status-copy" role="status">{connectionStatus}</span>}
        </section>

        <section className="settings-section">
          <h3>Speech recognition</h3>
          <Field label="Provider">
            <select value={settings.stt.provider} onChange={(event) => updateStt({ provider: event.target.value as SttSettings["provider"] })}>
              <option value="web-speech">Browser Web Speech</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </Field>
          {settings.stt.provider === "openai-compatible" && (
            <>
              <Field label="API URL"><input value={settings.stt.baseUrl} onChange={(event) => updateStt({ baseUrl: event.target.value })} /></Field>
              <ModelChoiceField label="Model" value={settings.stt.modelId} options={sttModels} searchUrl={modelWebSearch} onChange={(modelId) => updateStt({ modelId })} />
              <SecretField value={settings.stt.apiKey} remember={settings.stt.rememberApiKey} onChange={(apiKey) => updateStt({ apiKey })} onRemember={(rememberApiKey) => updateStt({ rememberApiKey })} />
            </>
          )}
          <LanguageField value={settings.stt.language} onChange={(language) => updateStt({ language })} />
          <label className="toggle-row"><input type="checkbox" checked={settings.stt.continuous} onChange={(event) => updateStt({ continuous: event.target.checked })} />Continuous recognition</label>
          <button onClick={onTestStt}>Test recognition</button>
        </section>

        <section className="settings-section">
          <h3>Speech synthesis</h3>
          <Field label="Provider">
            <select value={settings.tts.provider} onChange={(event) => updateTts({ provider: event.target.value as TtsSettings["provider"] })}>
              <option value="vits-local">Local VITS</option>
              <option value="browser-speech">Browser Speech Synthesis</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </Field>
          {settings.tts.provider === "openai-compatible" && (
            <>
              <Field label="API URL"><input value={settings.tts.baseUrl} onChange={(event) => updateTts({ baseUrl: event.target.value })} /></Field>
              <ModelChoiceField label="Model" value={settings.tts.modelId} options={ttsModels} searchUrl={modelWebSearch} onChange={(modelId) => updateTts({ modelId })} />
              <SecretField value={settings.tts.apiKey} remember={settings.tts.rememberApiKey} onChange={(apiKey) => updateTts({ apiKey })} onRemember={(rememberApiKey) => updateTts({ rememberApiKey })} />
            </>
          )}
          <LanguageField value={settings.tts.language} onChange={(language) => {
            const voice = localVoices[language]?.[0]?.value || settings.tts.voice;
            updateTts({ language, ...(settings.tts.provider === "vits-local" ? { voice } : {}) });
          }} />
          {settings.tts.provider === "vits-local" ? (
            <Field label="Voice model">
              <div className="select-with-status">
                <select value={settings.tts.voice} onChange={(event) => updateTts({ voice: event.target.value })}>
                  {currentVoices.map((voice) => <option key={voice.value} value={voice.value}>{voice.label} {voiceDownloaded[voice.value] ? "✓" : "↓"}</option>)}
                </select>
                <ModelStatus downloaded={Boolean(voiceDownloaded[settings.tts.voice])} />
              </div>
            </Field>
          ) : settings.tts.provider === "browser-speech" ? (
            <Field label="Browser voice">
              <select
                value={selectedBrowserVoice?.voiceURI || ""}
                onChange={(event) => updateTts({ voice: event.target.value })}
                disabled={filteredBrowserVoices.length === 0}
              >
                {filteredBrowserVoices.length === 0 && <option value="">No voice is available for this language</option>}
                {filteredBrowserVoices.map((voice) => (
                  <option key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} · {voice.lang}{voice.default ? " · Default" : ""}
                  </option>
                ))}
              </select>
            </Field>
          ) : <Field label="Voice"><input value={settings.tts.voice} onChange={(event) => updateTts({ voice: event.target.value })} /></Field>}
          <div className="range-grid">
            <Field label={`Rate ${settings.tts.rate.toFixed(1)}`}><input type="range" min="0.5" max="2" step="0.1" value={settings.tts.rate} onChange={(event) => updateTts({ rate: Number(event.target.value) })} /></Field>
            <Field label={`Pitch ${settings.tts.pitch.toFixed(1)}`}><input type="range" min="0.5" max="2" step="0.1" value={settings.tts.pitch} onChange={(event) => updateTts({ pitch: Number(event.target.value) })} /></Field>
          </div>
          {settings.tts.provider === "vits-local" && <DownloadProgress progress={voiceProgress ?? (voiceResumeProgress || undefined)} status={voiceDownloadStatus} />}
          <div className="settings-actions">
            {settings.tts.provider === "vits-local" && (voiceProgress === undefined
              ? <button className="primary-button" onClick={() => void downloadVoice()}>{voiceResumeProgress > 0 ? "▶ Resume download" : "↓ Download voice"}</button>
              : <button className="pause-button" onClick={() => voiceAbortRef.current?.abort()}>Ⅱ Pause download</button>)}
            <button onClick={onTestTts}>Test speech</button>
          </div>
        </section>

        <section className="settings-section compact">
          <label className="toggle-row"><input type="checkbox" checked={settings.subtitlesEnabled} onChange={(event) => setSubtitlesEnabled(event.target.checked)} />Show subtitles</label>
          <button className="danger-button" onClick={reset}>Restore defaults</button>
        </section>
      </aside>
    </div>
  );
}

function ModelChoiceField({ label, value, options, downloaded, searchUrl, onChange }: {
  label: string;
  value: string;
  options: ModelOption[];
  downloaded?: Record<string, boolean>;
  searchUrl(query: string): string;
  onChange(value: string): void;
}) {
  const isPreset = options.some((option) => option.value === value);
  return (
    <Field label={label}>
      <div className="select-with-status">
        <select value={isPreset ? value : customValue} onChange={(event) => onChange(event.target.value === customValue ? "" : event.target.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}{downloaded ? ` ${downloaded[option.value] ? "✓" : "↓"}` : ""}</option>)}
          <option value={customValue}>Custom model…</option>
        </select>
        {downloaded && <ModelStatus downloaded={Boolean(downloaded[value])} />}
      </div>
      {!isPreset && (
        <div className="custom-model-row">
          <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Enter a model name" />
          <a className="search-button" href={searchUrl(value)} target="_blank" rel="noreferrer" aria-label="Search for available models" title="Search for available models">⌕</a>
        </div>
      )}
    </Field>
  );
}

function ModelStatus({ downloaded }: { downloaded: boolean }) {
  return <span className={`model-status ${downloaded ? "downloaded" : "not-downloaded"}`} title={downloaded ? "Downloaded" : "Not downloaded"} aria-label={downloaded ? "Downloaded" : "Not downloaded"}>{downloaded ? "✓" : "↓"}</span>;
}

function DownloadProgress({ progress, status }: { progress?: number; status: string }) {
  if (progress === undefined && !status) return null;
  return (
    <div className="download-progress" role="status">
      {progress !== undefined && <progress max={1} value={progress} />}
      <span>{progress !== undefined ? `${Math.round(progress * 100)}% · ` : ""}{status}</span>
    </div>
  );
}

function LanguageField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return <Field label="Language"><select value={value} onChange={(event) => onChange(event.target.value)}>{languages.map((language) => <option key={language.value} value={language.value}>{language.label}</option>)}</select></Field>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function SecretField({ value, remember, onChange, onRemember }: {
  value: string;
  remember: boolean;
  onChange(value: string): void;
  onRemember(value: boolean): void;
}) {
  return (
    <>
      <Field label="API Key"><input type="password" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Stored in this tab by default" /></Field>
      <label className="toggle-row"><input type="checkbox" checked={remember} onChange={(event) => onRemember(event.target.checked)} />Remember this key on this device</label>
    </>
  );
}

function huggingFaceSearch(query: string) {
  return `https://huggingface.co/models?library=gguf&search=${encodeURIComponent(query || "GGUF Q4_K_M")}`;
}

function modelWebSearch(query: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(`OpenAI-compatible model ID ${query}`)}`;
}
