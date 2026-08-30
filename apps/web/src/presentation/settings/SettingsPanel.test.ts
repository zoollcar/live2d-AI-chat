// @vitest-environment jsdom

import type { AppSettings } from "@live2d-chat/shared";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/infrastructure/config/defaults";
import { useSettingsStore } from "@/infrastructure/config/store";
import { useConversationStore } from "@/infrastructure/conversation/store";
import { createConversation } from "@/model/conversation";
import { SettingsPanel } from "./SettingsPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/agent/local-models", () => ({
  downloadLocalModel: vi.fn(async () => undefined),
  getLocalModelPartialProgress: vi.fn(async () => 0),
  isLocalModelDownloaded: vi.fn(async () => false),
  localModelPresets: [{ id: "local-test-model", label: "Local test model", size: "1 MB" }],
}));

vi.mock("@/interaction/tts/model-download", () => ({
  downloadVitsVoice: vi.fn(async () => undefined),
  getVitsVoicePartialProgress: vi.fn(async () => 0),
  isVitsVoiceDownloaded: vi.fn(async () => false),
}));

function settingsFor(route: AppSettings["voiceRoute"]): AppSettings {
  return {
    ...defaultSettings,
    voiceRoute: route,
    voiceInteraction: { ...defaultSettings.voiceInteraction },
    llm: { ...defaultSettings.llm },
    stt: { ...defaultSettings.stt },
    tts: { ...defaultSettings.tts },
    realtime: {
      ...defaultSettings.realtime,
      google: { ...defaultSettings.realtime.google },
    },
  };
}

const settingsPanelProps = {
  open: true,
  onClose: vi.fn(),
  onActivateCharacter: vi.fn(async () => undefined),
  onCreateConversation: vi.fn(async () => undefined),
  onDeleteConversation: vi.fn(async () => undefined),
  onSelectConversation: vi.fn(async () => undefined),
  onTestRealtime: vi.fn(async () => undefined),
  onTestStt: vi.fn(),
  onTestTts: vi.fn(),
};

async function renderOpenSettings(): Promise<string> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(SettingsPanel, settingsPanelProps));
  });
  const markup = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return markup;
}

async function renderSettings(route: AppSettings["voiceRoute"]): Promise<string> {
  useSettingsStore.setState({ settings: settingsFor(route), hydrated: true });
  return renderOpenSettings();
}

describe("SettingsPanel voice routes", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ upstreams: [] }),
    })));
  });

  afterEach(() => {
    useConversationStore.setState({
      conversations: [],
      activeConversationId: undefined,
      hydrated: false,
      storageError: undefined,
    });
    vi.unstubAllGlobals();
  });

  it("shows only Classic STT, LLM, and TTS controls for the classic route", async () => {
    const markup = await renderSettings("classic");

    expect(markup).toContain("Realtime voice");
    expect(markup).toContain("Classic pipeline");
    expect(markup).toContain("Language model");
    expect(markup).toContain("Speech recognition");
    expect(markup).toContain("Speech synthesis");
    expect(markup).toContain("<details");
    expect(markup).toContain("route-settings-details");
    expect(markup).not.toContain("Test Realtime connection");
    expect(markup).toContain("These controls apply to both voice pipelines");
    expect(markup.indexOf("Conversation behavior")).toBeLessThan(
      markup.indexOf("aria-label=\"Classic voice pipeline settings\""),
    );
  });

  it("shows the fixed Google model, prebuilt voices, and browser-key warning for Realtime", async () => {
    const markup = await renderSettings("realtime");

    expect(markup).toContain("gemini-3.1-flash-live-preview");
    expect(markup).toContain("Preview");
    expect(markup).toContain("Kore · Firm · Recommended");
    expect(markup).toContain("Sulafat · Warm");
    expect(markup).toContain("page scripts and browser tooling can extract it");
    expect(markup).toContain("Test Realtime connection");
    expect(markup).toContain("Show API key");
    expect(markup.indexOf("Conversation behavior")).toBeLessThan(
      markup.indexOf("aria-label=\"Google Gemini Live settings\""),
    );
    expect(markup).not.toContain(">Speech recognition<");
    expect(markup).not.toContain(">Speech synthesis<");
  });

  it("renders Classic LLM controls from the active conversation snapshot without changing the global default", async () => {
    const conversation = createConversation({
      characterId: "ai-secretary",
      modelSnapshot: {
        transport: "direct",
        baseUrl: "https://active-chat.example/v1",
        modelId: "active-chat-model",
      },
      messages: [{ role: "system", content: "Stable prompt" }],
      now: 100,
    });
    useConversationStore.setState({
      conversations: [conversation],
      activeConversationId: conversation.id,
      hydrated: true,
      storageError: undefined,
    });
    const globalSettings = settingsFor("classic");
    globalSettings.llm.modelId = "global-default-model";
    useSettingsStore.setState({ settings: globalSettings, hydrated: true });

    const markup = await renderOpenSettings();

    expect(markup).toContain("active-chat-model");
    expect(markup).toContain("https://active-chat.example/v1");
    expect(useSettingsStore.getState().settings.llm.modelId).toBe("global-default-model");
  });
});
