import type { LlmSettings, RealtimeProviderId, SttSettings, TtsSettings, VoiceRoute } from "@live2d-chat/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  downloadLocalModel,
  getLocalModelPartialProgress,
  isLocalModelDownloaded,
  localModelPresets,
} from "@/agent/local-models";
import { CHROME_MODEL_ID, CHROME_MODEL_URL } from "@/agent/chrome-agent";
import {
  getChromePromptApiAvailability,
  isChromePromptApiSupported,
  type ChromePromptApiAvailability,
} from "@/agent/chrome-prompt-api";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import { useSettingsStore } from "@/infrastructure/config/store";
import { useCharacterStore } from "@/infrastructure/character/store";
import { useConversationStore } from "@/infrastructure/conversation/store";
import { fetchGoogleRealtimeModels, type GoogleRealtimeModel } from "@/interaction/realtime";
import { fetchGoogleCloudVoices, type GoogleCloudVoice } from "@/interaction/tts/google-cloud-tts";
import { downloadVitsVoice, getVitsVoicePartialProgress, isVitsVoiceDownloaded } from "@/interaction/tts/model-download";
import type { CharacterProfile } from "@/model/character-profile";
import { createModelSnapshot } from "@/model/conversation";
import { CharacterProfileEditor } from "./CharacterProfileEditor";
import { ConversationLibrary } from "./ConversationLibrary";

interface Props {
  open: boolean;
  onClose(): void;
  onActivateCharacter(profile: CharacterProfile): Promise<void>;
  onCreateConversation(): Promise<void>;
  onDeleteConversation(id: string): Promise<void>;
  onSelectConversation(id: string): Promise<void>;
  onTestRealtime(): Promise<void>;
  onTestStt(): void;
  onTestTts(): void;
}

/**
 * State of the "fetch model list" action. Tracks the baseUrl the result
 * applies to so changing Provider / Transport correctly invalidates an
 * older success result — otherwise switching from OpenAI to OpenRouter
 * would leave OpenAI's model list in the dropdown until the user clicked
 * fetch again.
 */
type DiscoverState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; baseUrl: string; models: string[] }
  | { status: "error"; message: string };

type GoogleVoiceState =
  | { status: "idle"; voices: GoogleCloudVoice[] }
  | { status: "loading"; voices: GoogleCloudVoice[] }
  | { status: "success"; voices: GoogleCloudVoice[] }
  | { status: "error"; voices: GoogleCloudVoice[]; message: string };

type GoogleRealtimeCatalogState =
  | { status: "idle"; models: GoogleRealtimeModel[] }
  | { status: "loading"; models: GoogleRealtimeModel[] }
  | { status: "success"; models: GoogleRealtimeModel[] }
  | { status: "error"; models: GoogleRealtimeModel[]; message: string };

interface ModelOption {
  label: string;
  value: string;
}

const customValue = "__custom__";
const languages = [
  { label: "English", value: "en-US" },
  { label: "Chinese", value: "zh-CN" },
];
const openAiLlmModels: ModelOption[] = [
  { label: "GPT-4.1 mini · Recommended", value: "gpt-4.1-mini" },
  { label: "GPT-4o mini · Fast and economical", value: "gpt-4o-mini" },
  { label: "GPT-4.1 · Higher quality", value: "gpt-4.1" },
];
const openRouterLlmModels: ModelOption[] = [
  { label: "Claude Sonnet 4.5 · Recommended", value: "anthropic/claude-sonnet-4.5" },
  { label: "GPT-4.1 mini", value: "openai/gpt-4.1-mini" },
  { label: "Gemini 2.5 Flash", value: "google/gemini-2.5-flash" },
  { label: "Llama 3.3 70B Instruct", value: "meta-llama/llama-3.3-70b-instruct" },
];
const minimaxCnLlmModels: ModelOption[] = [
  { label: "MiniMax-M3 · Latest", value: "MiniMax-M3" },
  { label: "MiniMax-M2 · Balanced", value: "MiniMax-M2" },
];
interface LlmProvider {
  id: string;
  label: string;
  baseUrl: string;
  models: ModelOption[];
}
// Built-in default whitelist. Mirrors the env var on the Hono proxy and is
// used as a fallback when the proxy is unreachable so the settings UI still
// renders something useful (e.g. during local development without the API).
const defaultProxyProviders: LlmProvider[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", models: openAiLlmModels },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: openRouterLlmModels },
  { id: "minimax-cn", label: "MiniMax (China)", baseUrl: "https://api.minimaxi.com/v1", models: minimaxCnLlmModels },
];
// Local/self-hosted OpenAI-compatible platforms used when Connection is set
// to "Direct OpenAI-compatible API". Each entry bundles a default base URL
// and a small set of model presets that the dropdown can show before the
// user fetches the live list from their own server.
const defaultDirectProviders: LlmProvider[] = [
  {
    id: "ollama",
    label: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: [
      { label: "Qwen 3.5 0.8B · Lightweight", value: "qwen3.5:0.8b" },
      { label: "Qwen 3 1.7B · Balanced", value: "qwen3:1.7b" },
      { label: "Llama 3.2 1B · Lightweight", value: "llama3.2:1b" },
    ],
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    models: [],
  },
  {
    id: "localai",
    label: "LocalAI",
    baseUrl: "http://127.0.0.1:8080/v1",
    models: [],
  },
  {
    id: "llamacpp",
    label: "llama.cpp server",
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
  },
  {
    id: "vllm",
    label: "vLLM",
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
  },
];
function findLlmProvider(providers: LlmProvider[], baseUrl: string): LlmProvider | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return providers.find((provider) => provider.baseUrl === normalized);
}

function getCurrentLlmBaseUrl(): string {
  const conversationState = useConversationStore.getState();
  const activeConversation = conversationState.conversations.find((conversation) =>
    conversation.id === conversationState.activeConversationId);
  return activeConversation?.modelSnapshot.baseUrl ?? useSettingsStore.getState().settings.llm.baseUrl;
}

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
// Google documents these as the prebuilt voices accepted by Gemini Live, but
// unlike models it does not expose a voices.list resource in the Gemini API.
const googleOfficialRealtimeVoices: ModelOption[] = [
  { label: "Kore · Firm · Recommended", value: "Kore" },
  { label: "Zephyr · Bright", value: "Zephyr" },
  { label: "Puck · Upbeat", value: "Puck" },
  { label: "Charon · Informative", value: "Charon" },
  { label: "Fenrir · Excitable", value: "Fenrir" },
  { label: "Leda · Youthful", value: "Leda" },
  { label: "Orus · Firm", value: "Orus" },
  { label: "Aoede · Breezy", value: "Aoede" },
  { label: "Callirrhoe · Easy-going", value: "Callirrhoe" },
  { label: "Autonoe · Bright", value: "Autonoe" },
  { label: "Enceladus · Breathy", value: "Enceladus" },
  { label: "Iapetus · Clear", value: "Iapetus" },
  { label: "Umbriel · Easy-going", value: "Umbriel" },
  { label: "Algieba · Smooth", value: "Algieba" },
  { label: "Despina · Smooth", value: "Despina" },
  { label: "Erinome · Clear", value: "Erinome" },
  { label: "Algenib · Gravelly", value: "Algenib" },
  { label: "Rasalgethi · Informative", value: "Rasalgethi" },
  { label: "Laomedeia · Upbeat", value: "Laomedeia" },
  { label: "Achernar · Soft", value: "Achernar" },
  { label: "Alnilam · Firm", value: "Alnilam" },
  { label: "Schedar · Even", value: "Schedar" },
  { label: "Gacrux · Mature", value: "Gacrux" },
  { label: "Pulcherrima · Forward", value: "Pulcherrima" },
  { label: "Achird · Friendly", value: "Achird" },
  { label: "Zubenelgenubi · Casual", value: "Zubenelgenubi" },
  { label: "Vindemiatrix · Gentle", value: "Vindemiatrix" },
  { label: "Sadachbia · Lively", value: "Sadachbia" },
  { label: "Sadaltager · Knowledgeable", value: "Sadaltager" },
  { label: "Sulafat · Warm", value: "Sulafat" },
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

export function SettingsPanel({
  open,
  onClose,
  onActivateCharacter,
  onCreateConversation,
  onDeleteConversation,
  onSelectConversation,
  onTestRealtime,
  onTestStt,
  onTestTts,
}: Props) {
  const {
    settings,
    setVoiceRoute,
    setRealtimeProvider,
    updateVoiceInteraction,
    updateLlm,
    updateStt,
    updateTts,
    updateRealtime,
    setSubtitlesEnabled,
    reset,
  } = useSettingsStore();
  const activeConversation = useConversationStore((state) =>
    state.conversations.find((conversation) => conversation.id === state.activeConversationId));
  const effectiveLlm = useMemo<LlmSettings>(() => ({
    ...settings.llm,
    ...activeConversation?.modelSnapshot,
  }), [activeConversation?.modelSnapshot, settings.llm]);
  const activeCharacter = useCharacterStore((state) =>
    state.profiles.find((profile) => profile.id === state.activeProfileId) ?? state.profiles[0]);
  const characterCount = useCharacterStore((state) => state.profiles.length);
  const visibleMessageCount = activeConversation?.messages.filter((message) => message.role !== "system").length ?? 0;
  const [connectionStatus, setConnectionStatus] = useState("");
  const [realtimeConnectionStatus, setRealtimeConnectionStatus] = useState("");
  const [realtimeTesting, setRealtimeTesting] = useState(false);
  const [googleRealtimeCatalog, setGoogleRealtimeCatalog] = useState<GoogleRealtimeCatalogState>({
    status: "idle",
    models: [],
  });
  const [discoverState, setDiscoverState] = useState<DiscoverState>({ status: "idle" });
  const [googleVoiceState, setGoogleVoiceState] = useState<GoogleVoiceState>({ status: "idle", voices: [] });
  const [localDownloaded, setLocalDownloaded] = useState<Record<string, boolean>>({});
  const [voiceDownloaded, setVoiceDownloaded] = useState<Record<string, boolean>>({});
  const [llmProgress, setLlmProgress] = useState<number>();
  const [voiceProgress, setVoiceProgress] = useState<number>();
  const [llmResumeProgress, setLlmResumeProgress] = useState(0);
  const [voiceResumeProgress, setVoiceResumeProgress] = useState(0);
  const [llmDownloadStatus, setLlmDownloadStatus] = useState("");
  const [voiceDownloadStatus, setVoiceDownloadStatus] = useState("");
  const [browserVoices, setBrowserVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [charactersOpen, setCharactersOpen] = useState(false);
  const [proxyProviders, setProxyProviders] = useState<LlmProvider[]>(defaultProxyProviders);
  const [chromeAvailability, setChromeAvailability] = useState<ChromePromptApiAvailability>("unsupported");
  const llmAbortRef = useRef<AbortController | undefined>(undefined);
  const voiceAbortRef = useRef<AbortController | undefined>(undefined);

  const updateActiveConversationLlm = useCallback((patch: Partial<LlmSettings>) => {
    const next = { ...effectiveLlm, ...patch };
    updateLlm(next);
    useConversationStore.getState().updateActiveModelSnapshot(createModelSnapshot(next));
  }, [effectiveLlm, updateLlm]);

  const resetSettings = useCallback(() => {
    reset();
    const next = useSettingsStore.getState().settings.llm;
    useConversationStore.getState().updateActiveModelSnapshot(createModelSnapshot(next));
    setConnectionStatus("");
    setRealtimeConnectionStatus("");
  }, [reset]);

  const llmOptions = useMemo(() => {
    if (effectiveLlm.transport === "chrome") {
      return [{ label: "Gemini Nano · Managed by Chrome", value: CHROME_MODEL_ID }];
    }
    if (effectiveLlm.transport === "local") {
      return localModelPresets.map((model) => ({
        label: `${model.label} · ${model.size}`,
        value: model.id,
      }));
    }
    const providers = effectiveLlm.transport === "proxy" ? proxyProviders : defaultDirectProviders;
    const provider = findLlmProvider(providers, effectiveLlm.baseUrl);
    // Only use provider preset models when the user hasn't already pulled a
    // fresh list from the live API for this exact baseUrl. Once they hit
    // the magnifying glass and the fetch succeeds, the dropdown reflects
    // what the server actually offers — the built-in presets are stale
    // guesses by definition.
    const haveFreshFetch = discoverState.status === "success" && discoverState.baseUrl === effectiveLlm.baseUrl;
    const presets = haveFreshFetch ? [] : (provider?.models ?? []);
    if (haveFreshFetch) {
      return discoverState.models.map((model) => ({ label: model, value: model }));
    }
    return presets.map((preset) => ({ label: preset.label, value: preset.value }));
  }, [discoverState, effectiveLlm.baseUrl, effectiveLlm.transport, proxyProviders]);

  useEffect(() => {
    const apiKey = settings.realtime.google.apiKey.trim();
    if (!open || settings.voiceRoute !== "realtime" || !apiKey) {
      setGoogleRealtimeCatalog({ status: "idle", models: [] });
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setGoogleRealtimeCatalog((current) => ({ status: "loading", models: current.models }));
      void fetchGoogleRealtimeModels(apiKey, controller.signal)
        .then((models) => {
          setGoogleRealtimeCatalog({ status: "success", models });
          const selectedModel = useSettingsStore.getState().settings.realtime.google.modelId;
          if (models.length > 0 && !models.some((model) => model.id === selectedModel)) {
            updateRealtime({ modelId: models[0].id });
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setGoogleRealtimeCatalog({
            status: "error",
            models: [],
            message: error instanceof Error ? error.message : "Unable to load Realtime models.",
          });
        });
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, settings.realtime.google.apiKey, settings.voiceRoute, updateRealtime]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void getChromePromptApiAvailability().then((availability) => {
      if (active) setChromeAvailability(availability);
    });
    return () => { active = false; };
  }, [open]);

  const currentVoices = localVoices[settings.tts.language] || localVoices["en-US"];
  const filteredBrowserVoices = useMemo(() => {
    const language = settings.tts.language.split("-")[0].toLowerCase();
    return browserVoices.filter((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === language);
  }, [browserVoices, settings.tts.language]);
  const selectedBrowserVoice = filteredBrowserVoices.find((voice) =>
    voice.voiceURI === settings.tts.voice || voice.name === settings.tts.voice);

  useEffect(() => {
    if (!open || effectiveLlm.transport !== "local") return;
    let active = true;
    void Promise.all(localModelPresets.map(async ({ id }) => [id, await isLocalModelDownloaded(id)] as const))
      .then((entries) => active && setLocalDownloaded(Object.fromEntries(entries)))
      .catch(() => undefined);
    return () => { active = false; };
  }, [effectiveLlm.transport, open]);

  useEffect(() => {
    if (!open || effectiveLlm.transport !== "local" || localDownloaded[effectiveLlm.modelId]) {
      setLlmResumeProgress(0);
      return;
    }
    let active = true;
    void getLocalModelPartialProgress(effectiveLlm.modelId)
      .then((progress) => active && setLlmResumeProgress(progress))
      .catch(() => undefined);
    return () => { active = false; };
  }, [effectiveLlm.modelId, effectiveLlm.transport, localDownloaded, open]);

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
    if (!open) return;
    let active = true;
    void fetch("/api/llm/upstreams")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as { upstreams?: Array<{ id: string; baseUrl: string }> };
      })
      .then((payload) => {
        if (!active || !payload.upstreams) return;
        // Merge server-side whitelist with the client-side label/model presets.
        // Unknown upstream ids fall back to a generic entry so the UI still
        // renders them.
        const merged = payload.upstreams.map<LlmProvider>((item) => {
          const preset = defaultProxyProviders.find((provider) => provider.id === item.id);
          return {
            id: item.id,
            label: preset?.label ?? item.id,
            baseUrl: item.baseUrl,
            models: preset?.models ?? [],
          };
        });
        if (merged.length > 0) setProxyProviders(merged);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [open]);

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

  useEffect(() => {
    const apiKey = settings.tts.apiKey.trim();
    if (!open || settings.tts.provider !== "google-cloud" || !apiKey) {
      setGoogleVoiceState({ status: "idle", voices: [] });
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setGoogleVoiceState((current) => ({ status: "loading", voices: current.voices }));
      void fetchGoogleCloudVoices(apiKey, settings.tts.language, controller.signal)
        .then((voices) => {
          setGoogleVoiceState({ status: "success", voices });
          updateTts({ voice: voices[0]?.name || "" });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setGoogleVoiceState({
            status: "error",
            voices: [],
            message: error instanceof Error ? error.message : "Unable to load Google Cloud voices.",
          });
        });
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, settings.tts.apiKey, settings.tts.language, settings.tts.provider, updateTts]);

  if (!open) return null;

  const testConnection = async () => {
    if (effectiveLlm.transport === "chrome") {
      if (typeof LanguageModel === "undefined" || !isChromePromptApiSupported(chromeAvailability)) {
        setConnectionStatus("Chrome's built-in Prompt API is not available on this browser or device.");
        return;
      }
      setConnectionStatus(chromeAvailability === "available"
        ? "Starting Chrome built-in AI…"
        : "Preparing the Chrome built-in AI download…");
      let session: LanguageModel | undefined;
      try {
        session = await LanguageModel.create({
          monitor(monitor) {
            monitor.addEventListener("downloadprogress", (event) => {
              setConnectionStatus(`Downloading Chrome built-in AI… ${Math.round(event.loaded * 100)}%`);
            });
          },
        });
        const response = await session.prompt("Reply with OK.");
        if (!response.trim()) throw new Error("The model returned an empty response.");
        setChromeAvailability("available");
        setConnectionStatus("Test passed: Chrome built-in AI responded on this device.");
      } catch (error) {
        setConnectionStatus(`Chrome built-in AI failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      } finally {
        session?.destroy();
      }
      return;
    }
    if (effectiveLlm.transport === "local") {
      setConnectionStatus("Checking model files…");
      try {
        const downloaded = await isLocalModelDownloaded(effectiveLlm.modelId);
        setLocalDownloaded((current) => ({ ...current, [effectiveLlm.modelId]: downloaded }));
        setConnectionStatus(downloaded ? "Test passed: the model files are complete and ready to load." : "The model has not been downloaded yet.");
      } catch (error) {
        setConnectionStatus(`Check failed: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
      return;
    }
    if (!effectiveLlm.modelId.trim()) {
      setConnectionStatus("Enter a model ID before testing the connection.");
      return;
    }
    setConnectionStatus("Sending a test request…");
    try {
      const viaProxy = effectiveLlm.transport === "proxy";
      const baseUrl = viaProxy ? "/api/llm/v1" : normalizeBaseUrl(effectiveLlm.baseUrl);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (effectiveLlm.apiKey) headers.authorization = `Bearer ${effectiveLlm.apiKey}`;
      if (viaProxy) headers["X-LLM-Base-URL"] = normalizeBaseUrl(effectiveLlm.baseUrl);
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: effectiveLlm.modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
      }
      setConnectionStatus("Test passed: the language model responded to the request.");
    } catch (error) {
      setConnectionStatus(`Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const testRealtimeConnection = async () => {
    if (!settings.realtime.google.apiKey.trim()) {
      setRealtimeConnectionStatus("Enter the selected provider's API key before testing Realtime voice.");
      return;
    }
    setRealtimeTesting(true);
    setRealtimeConnectionStatus("Connecting to the Realtime provider…");
    try {
      await onTestRealtime();
      setRealtimeConnectionStatus("Test passed: the selected provider is ready for realtime audio.");
    } catch (error) {
      setRealtimeConnectionStatus(`Realtime connection failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setRealtimeTesting(false);
    }
  };

  const selectVoiceRoute = (route: VoiceRoute) => {
    setVoiceRoute(route);
    setConnectionStatus("");
    setRealtimeConnectionStatus("");
  };

  const fetchRemoteModels = async () => {
    if (effectiveLlm.transport === "local") {
      // Local models are not fetched — they live in `localModelPresets` and
      // are managed through the download list. Surface this in the shared
      // status line and bail out without touching `discoverState`.
      setConnectionStatus("Local models are managed from the download list, not fetched from an API.");
      return;
    }
    const viaProxy = effectiveLlm.transport === "proxy";
    // Capture the URL we're fetching from so a Provider/Transport change
    // mid-flight can't apply the stale result to the new baseUrl. The
    // guard below ignores responses whose `baseUrl` no longer matches.
    const targetBaseUrl = effectiveLlm.baseUrl;
    setDiscoverState({ status: "loading" });
    setConnectionStatus("Fetching the model list…");
    try {
      const baseUrl = viaProxy ? "/api/llm/v1" : normalizeBaseUrl(targetBaseUrl);
      const headers: Record<string, string> = {};
      if (effectiveLlm.apiKey) headers.authorization = `Bearer ${effectiveLlm.apiKey}`;
      if (viaProxy) headers["X-LLM-Base-URL"] = normalizeBaseUrl(targetBaseUrl);
      const response = await fetch(`${baseUrl}/models`, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = payload.data?.flatMap((model) => (model.id ? [model.id] : [])) || [];
      if (getCurrentLlmBaseUrl() !== targetBaseUrl) return;
      setDiscoverState({ status: "success", baseUrl: targetBaseUrl, models: ids });
      setConnectionStatus(`Discovered ${ids.length} model${ids.length === 1 ? "" : "s"} from the API.`);
    } catch (error) {
      if (getCurrentLlmBaseUrl() !== targetBaseUrl) return;
      const message = error instanceof Error ? error.message : "Unknown error";
      setDiscoverState({ status: "error", message });
      setConnectionStatus(`Failed to fetch models: ${message}`);
    }
  };

  const downloadLlm = async () => {
    if (!effectiveLlm.modelId.trim()) return;
    const controller = new AbortController();
    llmAbortRef.current = controller;
    setLlmProgress(llmResumeProgress);
    setLlmDownloadStatus(llmResumeProgress > 0 ? "Resuming the download…" : "Preparing the language model download…");
    try {
      await downloadLocalModel(effectiveLlm.modelId, setLlmProgress, controller.signal);
      setLocalDownloaded((current) => ({ ...current, [effectiveLlm.modelId]: true }));
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
      void getLocalModelPartialProgress(effectiveLlm.modelId).then(setLlmResumeProgress).catch(() => undefined);
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

        <section className="settings-section history-setting">
          <div>
            <h3>Conversation</h3>
            <span className="status-copy">{visibleMessageCount} message{visibleMessageCount === 1 ? "" : "s"} in this chat</span>
          </div>
          <button onClick={() => setHistoryOpen(true)}>View chat history</button>
        </section>

        <section className="settings-section history-setting">
          <div>
            <h3>Character profile</h3>
            <span className="status-copy">{activeCharacter.name} · {characterCount} profile{characterCount === 1 ? "" : "s"}</span>
          </div>
          <button onClick={() => setCharactersOpen(true)}>Manage characters</button>
        </section>

        <section className="settings-section voice-route-section">
          <h3>Voice experience</h3>
          <p className="settings-section-copy">Choose one route for voice conversations. The inactive route keeps its configuration for later.</p>
          <div className="voice-route-grid" role="radiogroup" aria-label="Voice experience">
            <VoiceRouteCard
              route="realtime"
              checked={settings.voiceRoute === "realtime"}
              title="Realtime voice"
              detail="Microphone ↔ native low-latency audio"
              onChange={selectVoiceRoute}
            />
            <VoiceRouteCard
              route="classic"
              checked={settings.voiceRoute === "classic"}
              title="Classic pipeline"
              detail="Speech recognition → Language model → Speech synthesis"
              onChange={selectVoiceRoute}
            />
          </div>
        </section>

        <section className="settings-section voice-behavior-section">
          <h3>Conversation behavior</h3>
          <p className="settings-section-copy">These controls apply to both voice pipelines.</p>
          <label className="toggle-row toggle-detail">
            <input
              type="checkbox"
              checked={settings.voiceInteraction.handsFree}
              onChange={(event) => updateVoiceInteraction({ handsFree: event.target.checked })}
            />
            <span><strong>Hands-free conversation</strong><small>Keep listening across spoken turns until you stop the microphone.</small></span>
          </label>
          <label className="toggle-row toggle-detail">
            <input
              type="checkbox"
              checked={settings.voiceInteraction.allowVoiceInterruption}
              onChange={(event) => updateVoiceInteraction({ allowVoiceInterruption: event.target.checked })}
            />
            <span><strong>Allow spoken interruptions</strong><small>Let your voice interrupt an assistant reply. The Stop button always remains available.</small></span>
          </label>
          <label className="toggle-row toggle-detail">
            <input type="checkbox" checked={settings.subtitlesEnabled} onChange={(event) => setSubtitlesEnabled(event.target.checked)} />
            <span><strong>Show subtitles</strong><small>Transcripts still stay in chat history when subtitles are hidden.</small></span>
          </label>
          <div className="shared-capabilities" aria-label="Available in both pipelines">
            <span>✓ Live2D tools</span>
            <span>✓ Chat history</span>
            <span>✓ Character profiles</span>
          </div>
        </section>

        {settings.voiceRoute === "classic" ? (
          <div className="settings-route-stack" aria-label="Classic voice pipeline settings">
            <details className="settings-section route-settings-details" open>
              <summary><strong>Language model</strong><small>{effectiveLlm.transport} · {effectiveLlm.modelId}</small></summary>
              <Field label="Connection">
                <select value={effectiveLlm.transport} onChange={(event) => {
                  const transport = event.target.value as LlmSettings["transport"];
                  // Pick a sensible default model + baseUrl whenever the user
                  // crosses transport boundaries, so the Model dropdown always
                  // has a matching preset to show.
                  let nextBaseUrl = effectiveLlm.baseUrl;
                  let nextModelId = effectiveLlm.modelId;
                  if (transport === "chrome") {
                    nextBaseUrl = CHROME_MODEL_URL;
                    nextModelId = CHROME_MODEL_ID;
                  } else if (transport === "local") {
                    nextModelId = localModelPresets[0].id;
                  } else if (effectiveLlm.transport === "local" || effectiveLlm.transport === "chrome") {
                    if (transport === "proxy") {
                      nextBaseUrl = proxyProviders[0]?.baseUrl ?? defaultDirectProviders[0].baseUrl;
                      nextModelId = proxyProviders[0]?.models[0]?.value
                        ?? defaultDirectProviders[0].models[0]?.value
                        ?? "";
                    } else {
                      nextBaseUrl = defaultDirectProviders[0].baseUrl;
                      nextModelId = defaultDirectProviders[0].models[0]?.value ?? "";
                    }
                  } else if (transport === "proxy" && !findLlmProvider(proxyProviders, effectiveLlm.baseUrl)) {
                    nextBaseUrl = proxyProviders[0]?.baseUrl ?? effectiveLlm.baseUrl;
                    nextModelId = proxyProviders[0]?.models[0]?.value ?? "";
                  } else if (transport === "direct" && !findLlmProvider(defaultDirectProviders, effectiveLlm.baseUrl)) {
                    nextBaseUrl = defaultDirectProviders[0].baseUrl;
                    nextModelId = defaultDirectProviders[0].models[0]?.value ?? "";
                  }
                  updateActiveConversationLlm({
                    transport,
                    baseUrl: nextBaseUrl,
                    modelId: nextModelId,
                  });
                  // The previously-fetched model list was bound to the old
                  // baseUrl — dropping it so the dropdown falls back to the
                  // new provider's built-in presets instead of a stale result.
                  setDiscoverState({ status: "idle" });
                  setConnectionStatus("");
                }}>
                  <option value="proxy">Built-in Hono proxy</option>
                  <option value="direct">Direct OpenAI-compatible API</option>
                  <option value="local">Local wllama in the browser</option>
                  {(isChromePromptApiSupported(chromeAvailability) || effectiveLlm.transport === "chrome") && (
                    <option value="chrome" disabled={!isChromePromptApiSupported(chromeAvailability)}>
                      Chrome built-in AI (Gemini Nano)
                    </option>
                  )}
                </select>
              </Field>
              {(effectiveLlm.transport === "proxy" || effectiveLlm.transport === "direct") && (() => {
                const viaProxy = effectiveLlm.transport === "proxy";
                const providers = viaProxy ? proxyProviders : defaultDirectProviders;
                const allowCustom = !viaProxy;
                const matchedProvider = findLlmProvider(providers, effectiveLlm.baseUrl);
                return (
                  <>
                    <Field label="Provider">
                      <select
                        value={matchedProvider?.id ?? customValue}
                        onChange={(event) => {
                          if (event.target.value === customValue) return;
                          const provider = providers.find((item) => item.id === event.target.value);
                          if (!provider) return;
                          updateActiveConversationLlm({
                            baseUrl: provider.baseUrl,
                            modelId: provider.models[0]?.value ?? "",
                          });
                          // Provider switched — clear any stale fetch so the
                          // dropdown lands on the new provider's presets.
                          setDiscoverState({ status: "idle" });
                        }}
                      >
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.label}</option>
                        ))}
                        {allowCustom
                          ? <option value={customValue}>Custom OpenAI-compatible API</option>
                          : !matchedProvider && <option value={customValue} disabled>Unavailable configured provider</option>}
                      </select>
                    </Field>
                    <Field label="API URL">
                      <input
                        value={effectiveLlm.baseUrl}
                        onChange={(event) => updateActiveConversationLlm({ baseUrl: event.target.value })}
                        readOnly={viaProxy}
                        aria-readonly={viaProxy || undefined}
                        title={viaProxy ? "The URL is locked to the proxy's upstream whitelist." : undefined}
                      />
                    </Field>
                    <SecretField value={effectiveLlm.apiKey} remember={effectiveLlm.rememberApiKey} onChange={(apiKey) => updateActiveConversationLlm({ apiKey })} onRemember={(rememberApiKey) => updateActiveConversationLlm({ rememberApiKey })} />
                  </>
                );
              })()}
              <ModelChoiceField
                label="Model"
                value={effectiveLlm.modelId}
                options={llmOptions}
                downloaded={effectiveLlm.transport === "local" ? localDownloaded : undefined}
                searchUrl={(query) => effectiveLlm.transport === "local"
                  ? huggingFaceSearch(query)
                  : effectiveLlm.transport === "chrome"
                    ? "https://developer.chrome.com/docs/ai/prompt-api"
                    : modelWebSearch(query)}
                onChange={(modelId) => updateActiveConversationLlm({ modelId })}
                onFetchModels={effectiveLlm.transport === "proxy" || effectiveLlm.transport === "direct"
                  ? () => void fetchRemoteModels()
                  : undefined}
                fetching={discoverState.status === "loading"}
                fetchError={discoverState.status === "error" ? discoverState.message : undefined}
              />
              {effectiveLlm.transport === "local" && <DownloadProgress progress={llmProgress ?? (llmResumeProgress || undefined)} status={llmDownloadStatus} />}
              <div className="settings-actions">
                {effectiveLlm.transport === "local" && (llmProgress === undefined
                  ? <button className="primary-button" onClick={() => void downloadLlm()}>{llmResumeProgress > 0 ? "▶ Resume download" : "↓ Download model"}</button>
                  : <button className="pause-button" onClick={() => llmAbortRef.current?.abort()}>Ⅱ Pause download</button>)}
                <button onClick={() => void testConnection()}>Test connection</button>
              </div>
              {connectionStatus && <span className="status-copy" role="status">{connectionStatus}</span>}
            </details>

        <details className="settings-section route-settings-details">
          <summary><strong>Speech recognition</strong><small>{settings.stt.provider}</small></summary>
          <Field label="Provider">
            <select value={settings.stt.provider} onChange={(event) => updateStt({ provider: event.target.value as SttSettings["provider"] })}>
              <option value="web-speech">Browser Web Speech</option>
              <option value="openai-compatible">OpenAI-compatible</option>
            </select>
          </Field>
          {settings.stt.provider === "openai-compatible" && (
            <>
              <Field label="Transport">
                <select value={settings.stt.transport} onChange={(event) => updateStt({ transport: event.target.value as SttSettings["transport"] })}>
                  <option value="proxy">Built-in proxy</option>
                  <option value="direct">Direct from browser</option>
                </select>
              </Field>
              <Field label="API URL"><input value={settings.stt.baseUrl} onChange={(event) => updateStt({ baseUrl: event.target.value })} /></Field>
              <ModelChoiceField label="Model" value={settings.stt.modelId} options={sttModels} searchUrl={modelWebSearch} onChange={(modelId) => updateStt({ modelId })} />
              <SecretField value={settings.stt.apiKey} remember={settings.stt.rememberApiKey} onChange={(apiKey) => updateStt({ apiKey })} onRemember={(rememberApiKey) => updateStt({ rememberApiKey })} />
            </>
          )}
          <LanguageField value={settings.stt.language} onChange={(language) => updateStt({ language })} />
          <button onClick={onTestStt}>Test recognition</button>
        </details>

        <details className="settings-section route-settings-details">
          <summary><strong>Speech synthesis</strong><small>{settings.tts.provider} · {settings.tts.voice}</small></summary>
          <Field label="Provider">
            <select value={settings.tts.provider} onChange={(event) => {
              const provider = event.target.value as TtsSettings["provider"];
              if (provider === "google-cloud") updateTts({ provider, voice: "", apiKey: "" });
              else if (provider === "openai-compatible") updateTts({ provider, voice: "alloy", apiKey: "" });
              else if (provider === "vits-local") updateTts({ provider, voice: localVoices[settings.tts.language]?.[0]?.value || "" });
              else updateTts({ provider });
            }}>
              <option value="vits-local">Local VITS</option>
              <option value="browser-speech">Browser Speech Synthesis</option>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="google-cloud">Google Cloud Text-to-Speech</option>
            </select>
          </Field>
          {settings.tts.provider === "openai-compatible" && (
            <>
              <Field label="Transport">
                <select value={settings.tts.transport} onChange={(event) => updateTts({ transport: event.target.value as TtsSettings["transport"] })}>
                  <option value="proxy">Built-in proxy</option>
                  <option value="direct">Direct from browser</option>
                </select>
              </Field>
              <Field label="API URL"><input value={settings.tts.baseUrl} onChange={(event) => updateTts({ baseUrl: event.target.value })} /></Field>
              <ModelChoiceField label="Model" value={settings.tts.modelId} options={ttsModels} searchUrl={modelWebSearch} onChange={(modelId) => updateTts({ modelId })} />
              <SecretField value={settings.tts.apiKey} remember={settings.tts.rememberApiKey} onChange={(apiKey) => updateTts({ apiKey })} onRemember={(rememberApiKey) => updateTts({ rememberApiKey })} />
            </>
          )}
          {settings.tts.provider === "google-cloud" && (
            <SecretField value={settings.tts.apiKey} remember={settings.tts.rememberApiKey} onChange={(apiKey) => updateTts({ apiKey })} onRemember={(rememberApiKey) => updateTts({ rememberApiKey })} />
          )}
          <LanguageField value={settings.tts.language} onChange={(language) => {
            const voice = localVoices[language]?.[0]?.value || settings.tts.voice;
            updateTts({ language, ...(settings.tts.provider === "vits-local" ? { voice } : {}), ...(settings.tts.provider === "google-cloud" ? { voice: "" } : {}) });
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
          ) : settings.tts.provider === "google-cloud" ? (
            <>
              <Field label="Google voice">
                <select
                  value={googleVoiceState.voices.some((voice) => voice.name === settings.tts.voice) ? settings.tts.voice : ""}
                  onChange={(event) => updateTts({ voice: event.target.value })}
                  disabled={googleVoiceState.status === "loading" || googleVoiceState.voices.length === 0}
                >
                  {googleVoiceState.status === "idle" && <option value="">Enter an API key to load voices</option>}
                  {googleVoiceState.status === "loading" && <option value="">Loading voices…</option>}
                  {googleVoiceState.status === "error" && <option value="">Unable to load voices</option>}
                  {googleVoiceState.status === "success" && googleVoiceState.voices.length === 0 && <option value="">No voices are available for this language</option>}
                  {googleVoiceState.voices.map((voice) => (
                    <option key={voice.name} value={voice.name}>
                      {voice.name} · {formatGoogleVoiceGender(voice.ssmlGender)} · {Math.round(voice.naturalSampleRateHertz / 1000)} kHz
                    </option>
                  ))}
                </select>
              </Field>
              {googleVoiceState.status === "error" && <span className="status-copy" role="alert">{googleVoiceState.message}</span>}
            </>
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
        </details>
          </div>
        ) : (
          <section className="settings-section realtime-settings" aria-label="Realtime voice settings">
            <div className="settings-section-heading">
              <h3>Realtime voice</h3>
              <span className="settings-badge">Realtime</span>
            </div>
            <p className="settings-section-copy">The selected provider handles listening, reasoning, and native speech in one low-latency session. Classic STT and TTS are bypassed.</p>
            <Field label="Provider">
              <select
                value={settings.realtime.provider}
                onChange={(event) => setRealtimeProvider(event.target.value as RealtimeProviderId)}
              >
                <option value="google">Google Gemini Live</option>
              </select>
            </Field>
            <SecretField
              value={settings.realtime.google.apiKey}
              remember={settings.realtime.google.rememberApiKey}
              onChange={(apiKey) => updateRealtime({ apiKey })}
              onRemember={(rememberApiKey) => updateRealtime({ rememberApiKey })}
              autoFocus={!settings.realtime.google.apiKey}
              helpLink={{
                href: "https://aistudio.google.com/apikey",
                label: "Get a key ↗",
              }}
            />
            <Field label="Model">
              <select
                value={googleRealtimeCatalog.models.some((model) => model.id === settings.realtime.google.modelId)
                  ? settings.realtime.google.modelId
                  : ""}
                onChange={(event) => updateRealtime({ modelId: event.target.value })}
                disabled={googleRealtimeCatalog.status !== "success" || googleRealtimeCatalog.models.length === 0}
              >
                {googleRealtimeCatalog.status === "idle" && <option value="">Enter an API key to load models</option>}
                {googleRealtimeCatalog.status === "loading" && <option value="">Loading models…</option>}
                {googleRealtimeCatalog.status === "error" && <option value="">Unable to load models</option>}
                {googleRealtimeCatalog.status === "success" && googleRealtimeCatalog.models.length === 0 && <option value="">No Live API models are available for this key</option>}
                {googleRealtimeCatalog.models.map((model) => (
                  <option key={model.id} value={model.id}>{model.label} · {model.id}</option>
                ))}
              </select>
            </Field>
            <Field label="Prebuilt voice">
              <select
                value={googleRealtimeCatalog.status === "success" ? settings.realtime.google.voiceName : ""}
                onChange={(event) => updateRealtime({ voiceName: event.target.value })}
                disabled={googleRealtimeCatalog.status !== "success"}
              >
                {googleRealtimeCatalog.status === "idle" && <option value="">Enter an API key to load voices</option>}
                {googleRealtimeCatalog.status === "loading" && <option value="">Loading voices…</option>}
                {googleRealtimeCatalog.status === "error" && <option value="">Unable to load voices</option>}
                {googleRealtimeCatalog.status === "success" && googleOfficialRealtimeVoices.map((voice) => (
                  <option key={voice.value} value={voice.value}>{voice.label}</option>
                ))}
              </select>
            </Field>
            {googleRealtimeCatalog.status === "error" ? (
              <span className="status-copy" role="alert">Could not load Realtime models: {googleRealtimeCatalog.message}</span>
            ) : null}
            <div className="settings-actions">
              <button disabled={realtimeTesting} onClick={() => void testRealtimeConnection()}>
                {realtimeTesting ? "Testing provider…" : "Test provider connection"}
              </button>
            </div>
            {realtimeConnectionStatus ? <span className="status-copy" role="status">{realtimeConnectionStatus}</span> : null}
          </section>
        )}

        <section className="settings-section settings-reset">
          <button className="danger-button" onClick={resetSettings}>Restore defaults</button>
        </section>
      </aside>

      {historyOpen ? (
        <ConversationLibrary
          onClose={() => setHistoryOpen(false)}
          onCreateConversation={onCreateConversation}
          onDeleteConversation={onDeleteConversation}
          onSelectConversation={onSelectConversation}
        />
      ) : null}

      {charactersOpen ? (
        <CharacterProfileEditor
          onActivateProfile={onActivateCharacter}
          onClose={() => setCharactersOpen(false)}
        />
      ) : null}
    </div>
  );
}

function VoiceRouteCard({ route, checked, title, detail, onChange }: {
  route: VoiceRoute;
  checked: boolean;
  title: string;
  detail: string;
  onChange(route: VoiceRoute): void;
}) {
  return (
    <label className={`voice-route-card${checked ? " selected" : ""}`}>
      <input
        type="radio"
        name="voice-route"
        value={route}
        checked={checked}
        onChange={() => onChange(route)}
      />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function ModelChoiceField({ label, value, options, downloaded, searchUrl, onChange, onFetchModels, fetching, fetchError }: {
  label: string;
  value: string;
  options: ModelOption[];
  downloaded?: Record<string, boolean>;
  searchUrl(query: string): string;
  onChange(value: string): void;
  onFetchModels?(): void;
  // Live state for the magnifying-glass action. When `fetching` is true
  // the button is disabled and shows a spinner glyph; when `fetchError`
  // is set, the error is rendered inline below the dropdown so the user
  // knows the preset list they're seeing is a fallback, not what the API
  // actually returned.
  fetching?: boolean;
  fetchError?: string;
}) {
  const isPreset = options.some((option) => option.value === value);
  const fetchTitle = onFetchModels ? "Fetch available models from the API" : "Search for available models";
  return (
    <Field label={label}>
      <div className="select-with-status">
        <select value={isPreset ? value : customValue} onChange={(event) => onChange(event.target.value === customValue ? "" : event.target.value)}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}{downloaded ? ` ${downloaded[option.value] ? "✓" : "↓"}` : ""}</option>)}
          <option value={customValue}>Custom model…</option>
        </select>
        {downloaded ? (
          <ModelStatus downloaded={Boolean(downloaded[value])} />
        ) : onFetchModels ? (
          <button
            type="button"
            className={`search-button${fetching ? " loading" : ""}${fetchError ? " error" : ""}`}
            onClick={() => onFetchModels()}
            disabled={fetching}
            aria-label="Fetch available models"
            title={fetchError ? `Last fetch failed: ${fetchError} — click to retry` : fetchTitle}
          >{fetching ? "↻" : "⌕"}</button>
        ) : (
          <a className="search-button" href={searchUrl(value)} target="_blank" rel="noreferrer" aria-label="Search for available models" title={fetchTitle}>⌕</a>
        )}
      </div>
      {fetchError && (
        <span className="model-fetch-error" role="alert">
          Couldn't load the model list: {fetchError}. Showing built-in presets — click ⌕ to retry.
        </span>
      )}
      {!isPreset && (
        <input className="custom-model-input" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Enter a model name" />
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

function SecretField({ value, remember, onChange, onRemember, autoFocus = false, helpLink }: {
  value: string;
  remember: boolean;
  onChange(value: string): void;
  onRemember(value: boolean): void;
  autoFocus?: boolean;
  helpLink?: { href: string; label: string };
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <>
      <div className="field">
        <span className="field-label-row">
          <span>API Key</span>
          {helpLink ? (
            <a href={helpLink.href} target="_blank" rel="noreferrer">{helpLink.label}</a>
          ) : null}
        </span>
        <div className="secret-input-row">
          <input
            aria-label="API Key"
            type={revealed ? "text" : "password"}
            autoComplete="off"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Stored in this tab by default"
            autoFocus={autoFocus}
          />
          <button
            type="button"
            className="secret-visibility-button"
            aria-label={revealed ? "Hide API key" : "Show API key"}
            aria-pressed={revealed}
            onClick={() => setRevealed((current) => !current)}
          >{revealed ? "Hide" : "Show"}</button>
        </div>
      </div>
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

function formatGoogleVoiceGender(gender: string) {
  if (gender === "MALE") return "Male";
  if (gender === "FEMALE") return "Female";
  if (gender === "NEUTRAL") return "Neutral";
  return "Unspecified";
}
