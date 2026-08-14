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
      version: 2,
      partialize: ({ settings }) => ({
        settings: {
          ...settings,
          llm: { ...settings.llm, apiKey: "" },
          stt: { ...settings.stt, apiKey: "" },
          tts: { ...settings.tts, apiKey: "" },
        },
      }),
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
