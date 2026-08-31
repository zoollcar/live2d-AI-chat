// @vitest-environment jsdom

import type { AppSettings } from "@live2d-chat/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultSettings } from "./defaults";
import { migratePersistedSettings, useSettingsStore } from "./store";

const persistedKey = "live2d-chat:settings:v2";
const realtimeSecretKey = "live2d-chat:realtime:api-key";

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(defaultSettings)) as AppSettings;
}

describe("settings route persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useSettingsStore.setState({ settings: cloneDefaults(), hydrated: true });
  });

  it("migrates legacy continuous recognition into shared hands-free behavior", () => {
    const migrated = migratePersistedSettings({
      settings: {
        version: 2,
        llm: {
          transport: "direct",
          baseUrl: "https://example.test/v1",
          modelId: "kept-classic-model",
        },
        stt: { continuous: true },
        tts: { voice: "kept-classic-voice" },
        realtime: {
          modelId: "legacy-realtime-model",
          voice: "Aoede",
        },
      },
    }, 3);

    expect(migrated.settings).toMatchObject({
      version: 4,
      voiceRoute: "classic",
      voiceInteraction: {
        handsFree: true,
        allowVoiceInterruption: true,
      },
      llm: {
        transport: "direct",
        baseUrl: "https://example.test/v1",
        modelId: "kept-classic-model",
      },
      stt: { continuous: true },
      tts: { voice: "kept-classic-voice" },
      realtime: {
        provider: "google",
        google: {
          modelId: "legacy-realtime-model",
          voiceName: "Aoede",
          apiKey: "",
          rememberApiKey: false,
        },
      },
    });
  });

  it("migrates the removed proxy transport and URL to extension defaults", () => {
    const migrated = migratePersistedSettings({
      settings: {
        llm: {
          transport: "proxy",
          baseUrl: "/api/llm/v1",
          modelId: "",
        },
        stt: { continuous: false },
      },
    }, 2);

    expect(migrated.settings).toMatchObject({
      voiceRoute: "classic",
      llm: {
        transport: "extension",
        baseUrl: "https://api.openai.com/v1",
        modelId: "",
      },
      voiceInteraction: { handsFree: false },
    });
  });

  it("migrates the flat v4 Realtime provider payload into realtime.google", () => {
    const migrated = migratePersistedSettings({
      settings: {
        version: 3,
        voiceRoute: "realtime",
        realtime: {
          provider: "google",
          modelId: "obsolete-live-model",
          voice: "Aoede",
          apiKey: "must-not-persist",
          rememberApiKey: true,
        },
      },
    }, 4);

    expect(migrated.settings?.realtime).toEqual({
      provider: "google",
      google: {
        modelId: "obsolete-live-model",
        voiceName: "Aoede",
        apiKey: "",
        rememberApiKey: true,
      },
    });
  });

  it("keeps inactive route settings when switching pipelines", () => {
    const store = useSettingsStore.getState();
    store.updateLlm({ modelId: "classic-model" });
    store.updateTts({ voice: "classic-voice" });
    store.updateRealtime({ voiceName: "Aoede", modelId: "discovered-live-model" });

    store.setVoiceRoute("realtime");
    store.setVoiceRoute("classic");

    expect(useSettingsStore.getState().settings).toMatchObject({
      voiceRoute: "classic",
      llm: { modelId: "classic-model" },
      tts: { voice: "classic-voice" },
      realtime: {
        google: {
          voiceName: "Aoede",
          modelId: "discovered-live-model",
        },
      },
    });
  });

  it("keeps the Realtime provider as an explicit selectable setting", () => {
    useSettingsStore.getState().setRealtimeProvider("google");

    expect(useSettingsStore.getState().settings.realtime.provider).toBe("google");
  });

  it("keeps the deprecated STT continuous flag synchronized with hands-free", () => {
    useSettingsStore.getState().updateVoiceInteraction({ handsFree: true });
    expect(useSettingsStore.getState().settings.stt.continuous).toBe(true);

    useSettingsStore.getState().updateStt({ continuous: false });
    expect(useSettingsStore.getState().settings.voiceInteraction.handsFree).toBe(false);
  });

  it("moves the Realtime key between session and local storage only when Remember changes", () => {
    const store = useSettingsStore.getState();
    store.updateRealtime({ apiKey: "session-key" });
    expect(sessionStorage.getItem(realtimeSecretKey)).toBe("session-key");
    expect(localStorage.getItem(realtimeSecretKey)).toBeNull();
    const persisted = JSON.parse(localStorage.getItem(persistedKey) || "null") as {
      version?: number;
      state?: { settings?: { realtime?: { google?: { apiKey?: string } } } };
    } | null;
    expect(persisted?.version).toBe(6);
    expect(persisted?.state?.settings?.realtime?.google?.apiKey).toBe("");

    store.updateRealtime({ rememberApiKey: true });
    expect(sessionStorage.getItem(realtimeSecretKey)).toBeNull();
    expect(localStorage.getItem(realtimeSecretKey)).toBe("session-key");

    useSettingsStore.setState((state) => ({
      ...state,
      hydrated: false,
      settings: {
        ...state.settings,
        realtime: {
          ...state.settings.realtime,
          google: { ...state.settings.realtime.google, apiKey: "" },
        },
      },
    }));
    useSettingsStore.getState().hydrateSecrets();
    expect(useSettingsStore.getState().settings.realtime.google.apiKey).toBe("session-key");

    useSettingsStore.getState().reset();
    expect(localStorage.getItem(realtimeSecretKey)).toBeNull();
    expect(sessionStorage.getItem(realtimeSecretKey)).toBeNull();
    expect(localStorage.getItem(persistedKey)).not.toContain("session-key");
  });
});
