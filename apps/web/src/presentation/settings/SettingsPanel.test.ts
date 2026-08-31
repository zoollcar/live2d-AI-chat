// @vitest-environment jsdom

import type { AppSettings } from "@live2d-chat/shared";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/infrastructure/config/defaults";
import { useSettingsStore } from "@/infrastructure/config/store";
import { useConversationStore } from "@/infrastructure/conversation/store";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { createConversation } from "@/model/conversation";
import { SettingsPanel } from "./SettingsPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bridgeMocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock("@/infrastructure/extension/bridge-client", () => ({
  createExtensionFetch: vi.fn(() => bridgeMocks.fetch),
  extensionBridge: { connect: vi.fn(async () => undefined) },
}));

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
    bridgeMocks.fetch.mockReset();
    vi.mocked(createExtensionFetch).mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ upstreams: [] }),
    })));
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(markup).not.toContain("Test provider connection");
    expect(markup).toContain("These controls apply to both voice pipelines");
    expect(markup.indexOf("Conversation behavior")).toBeLessThan(
      markup.indexOf("aria-label=\"Classic voice pipeline settings\""),
    );
  });

  it("shows provider-neutral Realtime settings and asks for a key before loading options", async () => {
    const markup = await renderSettings("realtime");

    expect(markup).toContain("Enter an API key to load models");
    expect(markup).toContain("Enter an API key to load voices");
    expect(markup).not.toContain("gemini-3.1-flash-live-preview");
    expect(markup).not.toContain("Kore · Firm · Recommended");
    expect(markup).not.toContain("page scripts and browser tooling can extract it");
    expect(markup).toContain("Realtime voice settings");
    expect(markup).toContain("The selected provider handles listening");
    expect(markup).toContain("<option value=\"google\">Google Gemini Live</option>");
    expect(markup).toContain("href=\"https://aistudio.google.com/apikey\"");
    expect(markup).toContain("Get a key ↗");
    expect(markup).toContain("Test provider connection");
    expect(markup).toContain("Show API key");
    expect(markup.indexOf("Conversation behavior")).toBeLessThan(
      markup.indexOf("aria-label=\"Realtime voice settings\""),
    );
    expect(markup).not.toContain(">Speech recognition<");
    expect(markup).not.toContain(">Speech synthesis<");
  });

  it("automatically loads and selects models after a Realtime API key is entered", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://generativelanguage.googleapis.com/")) {
        return {
          ok: true,
          json: async () => ({
            models: [{
              name: "models/gemini-live-from-api",
              displayName: "Gemini Live From API",
              supportedGenerationMethods: ["bidiGenerateContent"],
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({ upstreams: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const settings = settingsFor("realtime");
    settings.realtime.google.apiKey = "test-key";
    useSettingsStore.setState({ settings, hydrated: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(SettingsPanel, settingsPanelProps)));
    await act(async () => vi.advanceTimersByTimeAsync(400));

    expect(container.innerHTML).toContain("Gemini Live From API · gemini-live-from-api");
    expect(container.innerHTML).toContain("Kore · Firm · Recommended");
    expect(container.innerHTML).not.toContain("Models were loaded from the Gemini API");
    expect(useSettingsStore.getState().settings.realtime.google.modelId).toBe("gemini-live-from-api");

    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
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

  it("shows Google Cloud transport and loads voices through the selected extension", async () => {
    vi.useFakeTimers();
    bridgeMocks.fetch.mockResolvedValue(new Response(JSON.stringify({
      voices: [
        {
          languageCodes: ["en-US"],
          name: "en-US-Wavenet-A",
          ssmlGender: "FEMALE",
          naturalSampleRateHertz: 24_000,
        },
        {
          languageCodes: ["cmn-CN"],
          name: "cmn-CN-Wavenet-A",
          ssmlGender: "FEMALE",
          naturalSampleRateHertz: 24_000,
        },
      ],
    }), { headers: { "content-type": "application/json" } }));
    const settings = settingsFor("classic");
    settings.tts = {
      ...settings.tts,
      provider: "google-cloud",
      transport: "extension",
      apiKey: "google-key",
      language: "zh-CN",
      voice: "",
    };
    useSettingsStore.setState({ settings, hydrated: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => root.render(createElement(SettingsPanel, settingsPanelProps)));
    const synthesisSection = Array.from(container.querySelectorAll("details"))
      .find((section) => section.textContent?.includes("Speech synthesis"));
    const transportField = Array.from(synthesisSection?.querySelectorAll("label.field") ?? [])
      .find((field) => field.querySelector(":scope > span")?.textContent === "Transport");
    const transportSelect = transportField?.querySelector("select");
    expect(transportSelect?.value).toBe("extension");
    expect(transportSelect?.textContent).toContain("Direct from browser");
    expect(transportSelect?.textContent).toContain("Companion extension");

    await act(async () => vi.advanceTimersByTimeAsync(400));

    expect(createExtensionFetch).toHaveBeenCalledWith({
      operation: "models",
      provider: "google-cloud",
      apiKey: "google-key",
    });
    expect(container.textContent).toContain("cmn-CN-Wavenet-A · Female · 24 kHz");
    expect(container.textContent).not.toContain("en-US-Wavenet-A");
    expect(useSettingsStore.getState().settings.tts.voice).toBe("cmn-CN-Wavenet-A");
    const directFetch = vi.mocked(globalThis.fetch);
    expect(directFetch.mock.calls.some(([input]) => String(input).includes("texttospeech.googleapis.com"))).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});
