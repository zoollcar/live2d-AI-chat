import type {
  AppSettings,
  ContentProviderSettings,
  GoogleRealtimeSettings,
  LlmSettings,
  ModelCapabilitySettings,
  RealtimeProviderId,
  RealtimeSettings,
  SttSettings,
  TtsSettings,
  VoiceInteractionSettings,
  VoiceRoute,
} from "@live2d-chat/shared";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { defaultSettings } from "./defaults";

type SecretSection = "llm" | "stt" | "tts" | "realtime" | "exa" | "supadata";

const secretKey = (section: SecretSection) => `live2d-chat:${section}:api-key`;

function readSecret(section: SecretSection, remember: boolean): string {
  const storage = remember ? localStorage : sessionStorage;
  return storage.getItem(secretKey(section)) || "";
}

function writeSecret(section: SecretSection, value: string, remember: boolean) {
  const selected = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  other.removeItem(secretKey(section));
  if (value) selected.setItem(secretKey(section), value);
  else selected.removeItem(secretKey(section));
}

interface SettingsStore {
  settings: AppSettings;
  hydrated: boolean;
  hydrateSecrets(): void;
  setVoiceRoute(route: VoiceRoute): void;
  setRealtimeProvider(provider: RealtimeProviderId): void;
  updateVoiceInteraction(patch: Partial<VoiceInteractionSettings>): void;
  updateLlm(patch: Partial<LlmSettings>): void;
  updateStt(patch: Partial<SttSettings>): void;
  updateTts(patch: Partial<TtsSettings>): void;
  updateRealtime(patch: Partial<GoogleRealtimeSettings>): void;
  updateContent(patch: Partial<Pick<ContentProviderSettings, "webProvider" | "videoTranscriptProvider">>): void;
  updateContentSecret(provider: "exa" | "supadata", patch: Partial<ContentProviderSettings["exa"]>): void;
  updateCapabilities(patch: Partial<ModelCapabilitySettings>): void;
  setSubtitlesEnabled(enabled: boolean): void;
  reset(): void;
}

type LegacyRealtimeSettings = Omit<Partial<RealtimeSettings>, "google"> & {
  modelId?: string;
  voice?: string;
  voiceName?: string;
  apiKey?: string;
  rememberApiKey?: boolean;
  google?: Partial<GoogleRealtimeSettings>;
};

type LegacyLlmSettings = Omit<Partial<LlmSettings>, "transport"> & {
  transport?: LlmSettings["transport"] | "proxy";
};

type LegacySttSettings = Omit<Partial<SttSettings>, "transport"> & {
  transport?: SttSettings["transport"] | "proxy";
};

type LegacyTtsSettings = Omit<Partial<TtsSettings>, "transport"> & {
  transport?: TtsSettings["transport"] | "proxy";
};

type PersistedSettings = Partial<Omit<AppSettings, "llm" | "stt" | "tts" | "realtime" | "voiceInteraction" | "content" | "capabilities">> & {
  llm?: LegacyLlmSettings;
  stt?: LegacySttSettings;
  tts?: LegacyTtsSettings;
  realtime?: LegacyRealtimeSettings;
  voiceInteraction?: Partial<VoiceInteractionSettings>;
  content?: Partial<Omit<ContentProviderSettings, "exa" | "supadata">> & {
    exa?: Partial<ContentProviderSettings["exa"]>;
    supadata?: Partial<ContentProviderSettings["supadata"]>;
  };
  capabilities?: Partial<ModelCapabilitySettings>;
};

interface PersistedSettingsState {
  settings?: PersistedSettings;
}

// Recognise URLs that point at the local Hono proxy itself rather than an
// upstream. We used to ship a "Built-in Hono proxy" preset whose value was
// `/api/llm/v1`, which made sense when the browser talked straight to the
// upstream. After the runtime started sending the upstream URL via the
// `X-LLM-Base-URL` header, this same value now gets forwarded to the proxy
// and rejected by the allow list (`upstream_not_allowed`). Any URL that
// starts with `/api/llm/` has the same problem.
function isLocalProxyUrl(url: string): boolean {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed === "/api/llm/v1" || trimmed.startsWith("/api/llm/");
}

function migrateRemoteTransport<T extends { transport?: string; baseUrl?: string }>(
  saved: T | undefined,
  fallbackBaseUrl: string,
): T | undefined {
  if (!saved || saved.transport !== "proxy") return saved;
  return {
    ...saved,
    transport: "extension",
    baseUrl: isLocalProxyUrl(saved.baseUrl ?? "") ? fallbackBaseUrl : saved.baseUrl,
  };
}

function normalizePersistedRealtime(saved?: LegacyRealtimeSettings): RealtimeSettings {
  const google = saved?.google ?? {};
  return {
    provider: "google",
    google: {
      ...defaultSettings.realtime.google,
      ...google,
      modelId: google.modelId
        ?? saved?.modelId
        ?? defaultSettings.realtime.google.modelId,
      voiceName: google.voiceName
        ?? saved?.voiceName
        ?? saved?.voice
        ?? defaultSettings.realtime.google.voiceName,
      apiKey: "",
      rememberApiKey: google.rememberApiKey
        ?? saved?.rememberApiKey
        ?? defaultSettings.realtime.google.rememberApiKey,
    },
  };
}

/**
 * Upgrade the persisted payload before Zustand merges it with current
 * defaults. Exported for focused migration tests; callers should still let the
 * persist middleware own storage reads and writes.
 */
export function migratePersistedSettings(persisted: unknown, _version: number): PersistedSettingsState {
  const state = (persisted ?? {}) as PersistedSettingsState;
  const saved = state.settings;
  if (!saved) return state;

  const llm = migrateRemoteTransport(saved.llm, defaultSettings.llm.baseUrl);
  const stt = migrateRemoteTransport(saved.stt, defaultSettings.stt.baseUrl);
  const tts = migrateRemoteTransport(saved.tts, defaultSettings.tts.baseUrl);

  const handsFree = saved.voiceInteraction?.handsFree
    ?? saved.stt?.continuous
    ?? defaultSettings.voiceInteraction.handsFree;
  return {
    ...state,
    settings: {
      ...saved,
      llm,
      stt: stt ? { ...stt, continuous: handsFree } : stt,
      tts,
      version: 4,
      voiceRoute: saved.voiceRoute === "realtime" ? "realtime" : "classic",
      voiceInteraction: {
        handsFree,
        allowVoiceInterruption: saved.voiceInteraction?.allowVoiceInterruption
          ?? defaultSettings.voiceInteraction.allowVoiceInterruption,
      },
      realtime: normalizePersistedRealtime(saved.realtime),
      content: {
        ...defaultSettings.content,
        ...saved.content,
        exa: { ...defaultSettings.content.exa, ...saved.content?.exa, apiKey: "" },
        supadata: { ...defaultSettings.content.supadata, ...saved.content?.supadata, apiKey: "" },
      },
      capabilities: { ...defaultSettings.capabilities, ...saved.capabilities },
    },
  };
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,
      hydrated: false,
      hydrateSecrets() {
        const { settings } = get();
        set({
          hydrated: true,
          settings: {
            ...settings,
            llm: { ...settings.llm, apiKey: readSecret("llm", settings.llm.rememberApiKey) },
            stt: { ...settings.stt, apiKey: readSecret("stt", settings.stt.rememberApiKey) },
            tts: { ...settings.tts, apiKey: readSecret("tts", settings.tts.rememberApiKey) },
            realtime: {
              ...settings.realtime,
              google: {
                ...settings.realtime.google,
                apiKey: readSecret("realtime", settings.realtime.google.rememberApiKey),
              },
            },
            content: {
              ...settings.content,
              exa: {
                ...settings.content.exa,
                apiKey: readSecret("exa", settings.content.exa.rememberApiKey),
              },
              supadata: {
                ...settings.content.supadata,
                apiKey: readSecret("supadata", settings.content.supadata.rememberApiKey),
              },
            },
          },
        });
      },
      setVoiceRoute(voiceRoute) {
        set((state) => ({ settings: { ...state.settings, voiceRoute } }));
      },
      setRealtimeProvider(provider) {
        set((state) => ({
          settings: {
            ...state.settings,
            realtime: { ...state.settings.realtime, provider },
          },
        }));
      },
      updateVoiceInteraction(patch) {
        set((state) => {
          const voiceInteraction = { ...state.settings.voiceInteraction, ...patch };
          return {
            settings: {
              ...state.settings,
              voiceInteraction,
              stt: patch.handsFree === undefined
                ? state.settings.stt
                : { ...state.settings.stt, continuous: voiceInteraction.handsFree },
            },
          };
        });
      },
      updateLlm(patch) {
        const next = { ...get().settings.llm, ...patch };
        if (patch.apiKey !== undefined || patch.rememberApiKey !== undefined) {
          writeSecret("llm", next.apiKey, next.rememberApiKey);
        }
        set((state) => ({ settings: { ...state.settings, llm: next } }));
      },
      updateStt(patch) {
        const next = { ...get().settings.stt, ...patch };
        if (patch.apiKey !== undefined || patch.rememberApiKey !== undefined) {
          writeSecret("stt", next.apiKey, next.rememberApiKey);
        }
        set((state) => ({
          settings: {
            ...state.settings,
            stt: next,
            voiceInteraction: patch.continuous === undefined
              ? state.settings.voiceInteraction
              : { ...state.settings.voiceInteraction, handsFree: next.continuous },
          },
        }));
      },
      updateTts(patch) {
        const next = { ...get().settings.tts, ...patch };
        if (patch.apiKey !== undefined || patch.rememberApiKey !== undefined) {
          writeSecret("tts", next.apiKey, next.rememberApiKey);
        }
        set((state) => ({ settings: { ...state.settings, tts: next } }));
      },
      updateRealtime(patch) {
        const google = {
          ...get().settings.realtime.google,
          ...patch,
        };
        if (patch.apiKey !== undefined || patch.rememberApiKey !== undefined) {
          writeSecret("realtime", google.apiKey, google.rememberApiKey);
        }
        set((state) => ({
          settings: {
            ...state.settings,
            realtime: { provider: "google", google },
          },
        }));
      },
      updateContent(patch) {
        set((state) => ({
          settings: {
            ...state.settings,
            content: { ...state.settings.content, ...patch },
          },
        }));
      },
      updateContentSecret(provider, patch) {
        const next = { ...get().settings.content[provider], ...patch };
        if (patch.apiKey !== undefined || patch.rememberApiKey !== undefined) {
          writeSecret(provider, next.apiKey, next.rememberApiKey);
        }
        set((state) => ({
          settings: {
            ...state.settings,
            content: { ...state.settings.content, [provider]: next },
          },
        }));
      },
      updateCapabilities(patch) {
        set((state) => ({
          settings: {
            ...state.settings,
            capabilities: { ...state.settings.capabilities, ...patch },
          },
        }));
      },
      setSubtitlesEnabled(enabled) {
        set((state) => ({
          settings: { ...state.settings, subtitlesEnabled: enabled },
        }));
      },
      reset() {
        for (const section of ["llm", "stt", "tts", "realtime", "exa", "supadata"] as const) {
          localStorage.removeItem(secretKey(section));
          sessionStorage.removeItem(secretKey(section));
        }
        set({ settings: defaultSettings, hydrated: true });
      },
    }),
    {
      name: "live2d-chat:settings:v2",
      // Keep the established key so existing installations are discovered.
      // Version 6 removes the Hono proxy transport, adds content providers,
      // and keeps secrets outside the Zustand JSON payload.
      version: 6,
      partialize: ({ settings }) => ({
        settings: {
          ...settings,
          llm: { ...settings.llm, apiKey: "" },
          stt: { ...settings.stt, apiKey: "" },
          tts: { ...settings.tts, apiKey: "" },
          realtime: {
            ...settings.realtime,
            google: { ...settings.realtime.google, apiKey: "" },
          },
          content: {
            ...settings.content,
            exa: { ...settings.content.exa, apiKey: "" },
            supadata: { ...settings.content.supadata, apiKey: "" },
          },
        },
      }),
      migrate: migratePersistedSettings,
      merge: (persisted, current) => {
        const saved = (persisted as PersistedSettingsState)?.settings;
        const llm = migrateRemoteTransport(saved?.llm, defaultSettings.llm.baseUrl) as Partial<LlmSettings> | undefined;
        const stt = migrateRemoteTransport(saved?.stt, defaultSettings.stt.baseUrl) as Partial<SttSettings> | undefined;
        const tts = migrateRemoteTransport(saved?.tts, defaultSettings.tts.baseUrl) as Partial<TtsSettings> | undefined;
        const handsFree = saved?.voiceInteraction?.handsFree
          ?? saved?.stt?.continuous
          ?? defaultSettings.voiceInteraction.handsFree;
        return {
          ...current,
          settings: {
            ...defaultSettings,
            ...saved,
            voiceRoute: saved?.voiceRoute === "realtime" ? "realtime" : "classic",
            llm: { ...defaultSettings.llm, ...llm },
            stt: { ...defaultSettings.stt, ...stt, continuous: handsFree },
            tts: { ...defaultSettings.tts, ...tts },
            realtime: normalizePersistedRealtime(saved?.realtime),
            content: {
              ...defaultSettings.content,
              ...saved?.content,
              exa: { ...defaultSettings.content.exa, ...saved?.content?.exa, apiKey: "" },
              supadata: { ...defaultSettings.content.supadata, ...saved?.content?.supadata, apiKey: "" },
            },
            capabilities: { ...defaultSettings.capabilities, ...saved?.capabilities },
            voiceInteraction: {
              ...defaultSettings.voiceInteraction,
              ...saved?.voiceInteraction,
              handsFree,
            },
            version: 4,
          },
        };
      },
    },
  ),
);
