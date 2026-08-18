import type { AppSettings, LlmSettings, SttSettings, TtsSettings } from "@live2d-chat/shared";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { defaultSettings } from "./defaults";

type SecretSection = "llm" | "stt" | "tts";

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
  updateLlm(patch: Partial<LlmSettings>): void;
  updateStt(patch: Partial<SttSettings>): void;
  updateTts(patch: Partial<TtsSettings>): void;
  setSubtitlesEnabled(enabled: boolean): void;
  reset(): void;
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
          },
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
        set((state) => ({ settings: { ...state.settings, stt: next } }));
      },
      updateTts(patch) {
        const next = { ...get().settings.tts, ...patch };
        if (patch.apiKey !== undefined || patch.rememberApiKey !== undefined) {
          writeSecret("tts", next.apiKey, next.rememberApiKey);
        }
        set((state) => ({ settings: { ...state.settings, tts: next } }));
      },
      setSubtitlesEnabled(enabled) {
        set((state) => ({
          settings: { ...state.settings, subtitlesEnabled: enabled },
        }));
      },
      reset() {
        for (const section of ["llm", "stt", "tts"] as const) {
          localStorage.removeItem(secretKey(section));
          sessionStorage.removeItem(secretKey(section));
        }
        set({ settings: defaultSettings, hydrated: true });
      },
    }),
    {
      name: "live2d-chat:settings:v2",
      // Bumped from 2 → 3 so the `migrate` below runs against any state
      // persisted by the previous release. The previous version stored
      // `/api/llm/v1` (the local proxy URL) as `baseUrl` in proxy mode
      // because the old "Built-in Hono proxy" preset had that value;
      // that's no longer a valid upstream and needs to be replaced.
      version: 3,
      partialize: ({ settings }) => ({
        settings: {
          ...settings,
          llm: { ...settings.llm, apiKey: "" },
          stt: { ...settings.stt, apiKey: "" },
          tts: { ...settings.tts, apiKey: "" },
        },
      }),
      migrate: (persisted, version) => {
        // Local-proxy URLs in proxy mode were valid in the previous
        // release's UI but no longer resolve to a real upstream. Replace
        // with the same default the rest of the app uses (OpenAI) so the
        // user lands on a working provider without having to manually
        // re-select one.
        const state = persisted as Partial<SettingsStore> | undefined;
        const llm = state?.settings?.llm;
        if (version < 3 && llm && llm.transport === "proxy" && isLocalProxyUrl(llm.baseUrl ?? "")) {
          return {
            ...state,
            settings: {
              ...state?.settings,
              llm: {
                ...llm,
                baseUrl: "https://api.openai.com/v1",
                modelId: llm.modelId?.trim() ? llm.modelId : "gpt-4.1-mini",
              },
            },
          } as SettingsStore;
        }
        return state as SettingsStore;
      },
      merge: (persisted, current) => {
        const saved = (persisted as Partial<SettingsStore>)?.settings;
        return {
          ...current,
          settings: {
            ...defaultSettings,
            ...saved,
            llm: { ...defaultSettings.llm, ...saved?.llm },
            stt: { ...defaultSettings.stt, ...saved?.stt },
            tts: { ...defaultSettings.tts, ...saved?.tts },
            version: 2,
          },
        };
      },
    },
  ),
);
