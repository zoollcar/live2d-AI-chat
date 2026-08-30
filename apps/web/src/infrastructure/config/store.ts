import type {
  AppSettings,
  GoogleRealtimeSettings,
  LlmSettings,
  RealtimeSettings,
  SttSettings,
  TtsSettings,
  VoiceInteractionSettings,
  VoiceRoute,
} from "@live2d-chat/shared";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { defaultSettings } from "./defaults";

type SecretSection = "llm" | "stt" | "tts" | "realtime";

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
  updateVoiceInteraction(patch: Partial<VoiceInteractionSettings>): void;
  updateLlm(patch: Partial<LlmSettings>): void;
  updateStt(patch: Partial<SttSettings>): void;
  updateTts(patch: Partial<TtsSettings>): void;
  updateRealtime(patch: Partial<GoogleRealtimeSettings>): void;
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

type PersistedSettings = Partial<Omit<AppSettings, "llm" | "stt" | "tts" | "realtime" | "voiceInteraction">> & {
  llm?: Partial<LlmSettings>;
  stt?: Partial<SttSettings>;
  tts?: Partial<TtsSettings>;
  realtime?: LegacyRealtimeSettings;
  voiceInteraction?: Partial<VoiceInteractionSettings>;
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

function normalizePersistedRealtime(saved?: LegacyRealtimeSettings): RealtimeSettings {
  const google = saved?.google ?? {};
  return {
    provider: "google",
    google: {
      ...defaultSettings.realtime.google,
      ...google,
      modelId: defaultSettings.realtime.google.modelId,
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
export function migratePersistedSettings(persisted: unknown, version: number): PersistedSettingsState {
  const state = (persisted ?? {}) as PersistedSettingsState;
  const saved = state.settings;
  if (!saved) return state;

  let llm = saved.llm;
  if (version < 3 && llm?.transport === "proxy" && isLocalProxyUrl(llm.baseUrl ?? "")) {
    llm = {
      ...llm,
      baseUrl: "https://api.openai.com/v1",
      modelId: llm.modelId?.trim() ? llm.modelId : "gpt-4.1-mini",
    };
  }

  if (version >= 5) {
    return llm === saved.llm ? state : { ...state, settings: { ...saved, llm } };
  }

  const handsFree = saved.voiceInteraction?.handsFree
    ?? saved.stt?.continuous
    ?? defaultSettings.voiceInteraction.handsFree;
  return {
    ...state,
    settings: {
      ...saved,
      llm,
      version: 3,
      voiceRoute: saved.voiceRoute === "realtime" ? "realtime" : "classic",
      voiceInteraction: {
        handsFree,
        allowVoiceInterruption: saved.voiceInteraction?.allowVoiceInterruption
          ?? defaultSettings.voiceInteraction.allowVoiceInterruption,
      },
      stt: saved.stt ? { ...saved.stt, continuous: handsFree } : saved.stt,
      realtime: normalizePersistedRealtime(saved.realtime),
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
          },
        });
      },
      setVoiceRoute(voiceRoute) {
        set((state) => ({ settings: { ...state.settings, voiceRoute } }));
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
          modelId: defaultSettings.realtime.google.modelId,
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
      setSubtitlesEnabled(enabled) {
        set((state) => ({
          settings: { ...state.settings, subtitlesEnabled: enabled },
        }));
      },
      reset() {
        for (const section of ["llm", "stt", "tts", "realtime"] as const) {
          localStorage.removeItem(secretKey(section));
          sessionStorage.removeItem(secretKey(section));
        }
        set({ settings: defaultSettings, hydrated: true });
      },
    }),
    {
      name: "live2d-chat:settings:v2",
      // Keep the established key so existing installations are discovered.
      // Version 5 nests provider-specific settings under realtime.google while
      // keeping the established storage key and migrating the earlier flat v4.
      version: 5,
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
        },
      }),
      migrate: migratePersistedSettings,
      merge: (persisted, current) => {
        const saved = (persisted as PersistedSettingsState)?.settings;
        const handsFree = saved?.voiceInteraction?.handsFree
          ?? saved?.stt?.continuous
          ?? defaultSettings.voiceInteraction.handsFree;
        return {
          ...current,
          settings: {
            ...defaultSettings,
            ...saved,
            voiceRoute: saved?.voiceRoute === "realtime" ? "realtime" : "classic",
            llm: { ...defaultSettings.llm, ...saved?.llm },
            stt: { ...defaultSettings.stt, ...saved?.stt, continuous: handsFree },
            tts: { ...defaultSettings.tts, ...saved?.tts },
            realtime: normalizePersistedRealtime(saved?.realtime),
            voiceInteraction: {
              ...defaultSettings.voiceInteraction,
              ...saved?.voiceInteraction,
              handsFree,
            },
            version: 3,
          },
        };
      },
    },
  ),
);
