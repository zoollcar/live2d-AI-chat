// @vitest-environment jsdom

import type { ChatMessage } from "@/agent";
import { defaultCharacterProfile } from "@/model/character-profile";
import type { Conversation } from "@/model/conversation";
import type { SceneController } from "@/model/live2d/scene-controller";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleLiveSessionError } from "@/interaction/realtime/errors";
import { useGoogleRealtime, type GoogleRealtimeControls } from "./use-google-realtime";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const realtimeMocks = vi.hoisted(() => {
  interface SessionOptions {
    activityHandling: string;
    history?: unknown[];
    historyProvider?: () => readonly unknown[];
    emit(event: unknown): void;
  }

  interface AudioOptions {
    onOutputLevel?(level: number): void;
    onOutputIdle?(): void;
  }

  let startInputGate: Promise<void> | undefined;

  class MockGoogleLiveSession {
    attemptHistory?: readonly unknown[];
    readonly connect = vi.fn(async () => {
      this.attemptHistory ??= this.options.historyProvider?.() ?? this.options.history ?? [];
    });
    readonly sendText = vi.fn();
    readonly sendAudio = vi.fn();
    readonly endAudio = vi.fn();
    readonly dispose = vi.fn();

    constructor(readonly options: SessionOptions) {
      sessions.push(this);
    }

    emit(event: unknown): void {
      this.options.emit(event);
    }
  }

  class MockRealtimeAudioEngine {
    private inputGeneration = 0;
    inputActive = false;
    outputIdle = true;
    inputCallback?: (pcm16: Int16Array) => void;
    readonly resume = vi.fn(async () => undefined);
    readonly startInput = vi.fn(async (callback: (pcm16: Int16Array) => void) => {
      const generation = this.inputGeneration;
      await startInputGate;
      if (generation !== this.inputGeneration) return;
      this.inputCallback = callback;
      this.inputActive = true;
    });
    readonly stopInput = vi.fn(() => {
      this.inputGeneration += 1;
      this.inputCallback = undefined;
      this.inputActive = false;
    });
    readonly enqueueOutput = vi.fn((_pcm16: Int16Array) => {
      this.outputIdle = false;
    });
    readonly clearOutput = vi.fn(() => {
      const wasActive = !this.outputIdle;
      this.outputIdle = true;
      if (wasActive) this.options.onOutputIdle?.();
    });
    readonly whenOutputIdle = vi.fn(async () => undefined);
    readonly isOutputIdle = vi.fn(() => this.outputIdle);
    readonly dispose = vi.fn(async () => {
      this.inputActive = false;
      this.outputIdle = true;
    });

    constructor(readonly options: AudioOptions) {
      audioEngines.push(this);
    }

    finishOutput(): void {
      if (this.outputIdle) return;
      this.outputIdle = true;
      this.options.onOutputIdle?.();
    }
  }

  const sessions: MockGoogleLiveSession[] = [];
  const audioEngines: MockRealtimeAudioEngine[] = [];
  const createToolAdapter = vi.fn(() => ({
    declarations: [],
    execute: vi.fn(async () => ({ ok: true })),
  }));

  return {
    MockGoogleLiveSession,
    MockRealtimeAudioEngine,
    sessions,
    audioEngines,
    createToolAdapter,
    setStartInputGate(gate: Promise<void> | undefined) {
      startInputGate = gate;
    },
  };
});

const conversationStoreMock = vi.hoisted(() => {
  interface StoredConversation {
    id: string;
    messages: unknown[];
    [key: string]: unknown;
  }

  const state = {
    conversations: [] as StoredConversation[],
    activeConversationId: undefined as string | undefined,
    updateMessages: vi.fn((updater: (messages: unknown[]) => unknown[]) => {
      const activeId = state.activeConversationId;
      state.conversations = state.conversations.map((conversation) =>
        conversation.id === activeId
          ? { ...conversation, messages: updater(conversation.messages) }
          : conversation);
    }),
    flushActive: vi.fn(async () => undefined),
  };
  return { state };
});

vi.mock("@/interaction/realtime", async () => {
  const reducer = await import("@/interaction/realtime/turn-reducer");
  return {
    ...reducer,
    GoogleLiveSession: realtimeMocks.MockGoogleLiveSession,
    createGoogleLiveSceneToolAdapter: realtimeMocks.createToolAdapter,
  };
});

vi.mock("@/interaction/realtime/realtime-audio-engine", () => ({
  RealtimeAudioEngine: realtimeMocks.MockRealtimeAudioEngine,
}));

vi.mock("@/infrastructure/conversation/store", () => ({
  useConversationStore: {
    getState: () => conversationStoreMock.state,
  },
}));

type HookOptions = Parameters<typeof useGoogleRealtime>[0];

let renderedControls: GoogleRealtimeControls | undefined;
let mountedRoot: Root | undefined;
let mountedContainer: HTMLDivElement | undefined;

function HookHarness({ options }: { options: HookOptions }) {
  renderedControls = useGoogleRealtime(options);
  return null;
}

function createConversation(messages: ChatMessage[] = []): Conversation {
  return {
    id: "conversation-1",
    title: "Realtime test",
    createdAt: 1,
    updatedAt: 1,
    starred: false,
    characterId: defaultCharacterProfile.id,
    modelSnapshot: {
      transport: "extension",
      baseUrl: "https://example.test/v1",
      modelId: "classic-model",
    },
    messages,
  };
}

function createHookOptions(
  conversation: Conversation,
  interaction: HookOptions["interaction"] = {
    handsFree: true,
    allowVoiceInterruption: true,
  },
) {
  const callbacks = {
    setListening: vi.fn(),
    setRunning: vi.fn(),
    setSubtitle: vi.fn(),
    setStatus: vi.fn(),
    openSettings: vi.fn(),
  };
  const scene = {
    snapshot: vi.fn(() => ({
      modelId: "ice-girl",
      state: "neutral",
      decorations: [],
      layout: "full-body-center",
      layoutRevision: 0,
      viewport: { width: 1_280, height: 720 },
    })),
    beginStreamingSpeech: vi.fn(),
    setStreamingSpeechLevel: vi.fn(),
    endStreamingSpeech: vi.fn(),
  } as unknown as SceneController;
  const options: HookOptions = {
    enabled: true,
    scene,
    profile: defaultCharacterProfile,
    conversation,
    settings: {
      provider: "google",
      google: {
        modelId: "gemini-3.1-flash-live-preview",
        voiceName: "Kore",
        apiKey: "test-key",
        rememberApiKey: false,
      },
    },
    interaction,
    callbacks,
  };
  return { options, callbacks, scene };
}

async function mountHook(options: HookOptions): Promise<GoogleRealtimeControls> {
  mountedContainer = document.createElement("div");
  document.body.append(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  await act(async () => {
    mountedRoot!.render(createElement(HookHarness, { options }));
  });
  if (!renderedControls) throw new Error("Realtime hook did not render controls.");
  return renderedControls;
}

async function run(action: () => void | Promise<void>): Promise<void> {
  await act(async () => {
    await action();
    for (let count = 0; count < 4; count += 1) await Promise.resolve();
  });
}

function activeMessages(): ChatMessage[] {
  const activeId = conversationStoreMock.state.activeConversationId;
  const conversation = conversationStoreMock.state.conversations.find((item) => item.id === activeId);
  return (conversation?.messages ?? []) as ChatMessage[];
}

beforeEach(() => {
  renderedControls = undefined;
  realtimeMocks.sessions.length = 0;
  realtimeMocks.audioEngines.length = 0;
  realtimeMocks.setStartInputGate(undefined);
  const conversation = createConversation();
  conversationStoreMock.state.conversations = [conversation as unknown as (
    typeof conversationStoreMock.state.conversations
  )[number]];
  conversationStoreMock.state.activeConversationId = conversation.id;
  vi.clearAllMocks();
});

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => mountedRoot!.unmount());
    mountedRoot = undefined;
  }
  mountedContainer?.remove();
  mountedContainer = undefined;
});

describe("useGoogleRealtime", () => {
  it("keeps a late input transcript on the same voice turn after output has started", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options, callbacks } = createHookOptions(conversation);
    const controls = await mountHook(options);
    await run(() => controls.startListening());
    const session = realtimeMocks.sessions[0]!;

    await run(() => session.emit({ type: "output-transcript", text: "Answer first." }));
    await run(() => session.emit({
      type: "input-transcript",
      text: "Question arrived late.",
      interim: false,
    }));
    await run(() => session.emit({ type: "generation-complete" }));
    await run(() => session.emit({ type: "turn-complete" }));

    expect(activeMessages()).toMatchObject([
      {
        role: "user",
        content: "Question arrived late.",
        inputMode: "voice",
      },
      { role: "assistant", content: "Answer first." },
    ]);
    expect(activeMessages()).toHaveLength(2);
    expect(callbacks.setSubtitle).toHaveBeenLastCalledWith("Answer first.");
  });

  it("does not create a ghost turn for input transcription delivered after turn completion", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options } = createHookOptions(conversation);
    const controls = await mountHook(options);
    await run(() => controls.startListening());
    const session = realtimeMocks.sessions[0]!;

    await run(() => session.emit({ type: "output-transcript", text: "Completed answer" }));
    await run(() => session.emit({ type: "turn-complete" }));
    const completedMessages = activeMessages();
    await run(() => session.emit({
      type: "input-transcript",
      text: "Late previous transcript",
      interim: false,
    }));

    expect(activeMessages()).toEqual(completedMessages);
    expect(activeMessages()).toHaveLength(2);
  });

  it("starts a separate voice turn when microphone transcription barges into a typed turn", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options } = createHookOptions(conversation);
    const controls = await mountHook(options);
    await run(() => controls.sendText("Typed question"));
    const session = realtimeMocks.sessions[0]!;
    await run(() => session.emit({ type: "output-transcript", text: "Typed partial" }));
    await run(() => controls.startListening());
    await run(() => session.emit({
      type: "input-transcript",
      text: "Spoken interruption",
      interim: false,
    }));
    await run(() => session.emit({ type: "interrupted" }));
    await run(() => session.emit({ type: "turn-complete" }));

    expect(activeMessages()).toMatchObject([
      { role: "user", content: "Typed question", inputMode: "text" },
      { role: "assistant", content: "Typed partial", interrupted: true },
      { role: "user", content: "Spoken interruption", inputMode: "voice" },
      { role: "assistant", content: "" },
    ]);
  });

  it("persists interrupted partial output and tool call state", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options } = createHookOptions(conversation);
    const controls = await mountHook(options);
    await run(() => controls.startListening());
    const session = realtimeMocks.sessions[0]!;

    await run(() => session.emit({
      type: "input-transcript",
      text: "Please change the scene",
      interim: false,
    }));
    await run(() => session.emit({ type: "output-transcript", text: "I will start" }));
    await run(() => session.emit({
      type: "tool-call",
      id: "tool-1",
      name: "setState",
      args: { state: "happy" },
    }));
    await run(() => session.emit({
      type: "tool-result",
      id: "tool-1",
      name: "setState",
      output: { ok: true, state: "happy" },
    }));
    await run(() => session.emit({ type: "tool-cancelled", ids: ["tool-1"] }));
    await run(() => session.emit({ type: "interrupted" }));
    await run(() => session.emit({ type: "turn-complete" }));

    expect(activeMessages()[1]).toMatchObject({
      role: "assistant",
      content: "I will start",
      interrupted: true,
      toolCalls: [{
        callId: "tool-1",
        name: "setState",
        input: { state: "happy" },
        output: { ok: true, state: "happy" },
        canceled: true,
      }],
    });
  });

  it("attaches a tool result that settles after turn completion to its original assistant turn", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options } = createHookOptions(conversation);
    const controls = await mountHook(options);
    await run(() => controls.startListening());
    const session = realtimeMocks.sessions[0]!;

    await run(() => session.emit({
      type: "input-transcript",
      text: "Change the layout",
      interim: false,
    }));
    await run(() => session.emit({
      type: "tool-call",
      id: "late-tool",
      name: "setStageLayout",
      args: { layout: "half-body-left" },
    }));
    await run(() => session.emit({ type: "turn-complete" }));
    await run(() => session.emit({
      type: "tool-result",
      id: "late-tool",
      name: "setStageLayout",
      output: { ok: true, layout: "half-body-left" },
    }));

    expect(activeMessages()[1]).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [{
        callId: "late-tool",
        output: { ok: true, layout: "half-body-left" },
      }],
    });
  });

  it("keeps a noninterruptible hands-free microphone gated until server completion and true audio idle", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options, callbacks } = createHookOptions(conversation, {
      handsFree: true,
      allowVoiceInterruption: false,
    });
    const controls = await mountHook(options);
    await run(() => controls.startListening());
    const session = realtimeMocks.sessions[0]!;
    const audio = realtimeMocks.audioEngines[0]!;

    await run(() => session.emit({
      type: "input-transcript",
      text: "Hands-free question",
      interim: false,
    }));
    await run(() => session.emit({
      type: "audio",
      pcm16: new Int16Array([1, -1]),
      sampleRate: 24_000,
    }));
    expect(audio.stopInput).toHaveBeenCalledOnce();
    expect(session.endAudio).toHaveBeenCalledOnce();
    expect(audio.startInput).toHaveBeenCalledOnce();

    await run(() => session.emit({ type: "turn-complete" }));
    expect(audio.startInput).toHaveBeenCalledOnce();
    expect(callbacks.setRunning).not.toHaveBeenLastCalledWith(false);

    await run(() => audio.finishOutput());
    expect(audio.startInput).toHaveBeenCalledTimes(2);
    expect(callbacks.setListening).toHaveBeenLastCalledWith(true);
    expect(callbacks.setRunning).toHaveBeenLastCalledWith(false);
  });

  it.each([
    { handsFree: true, allow: true, stoppedDuringOutput: false, startsAfterIdle: 1, listeningAfterIdle: true },
    { handsFree: true, allow: false, stoppedDuringOutput: true, startsAfterIdle: 2, listeningAfterIdle: true },
    { handsFree: false, allow: true, stoppedDuringOutput: false, startsAfterIdle: 1, listeningAfterIdle: false },
    { handsFree: false, allow: false, stoppedDuringOutput: true, startsAfterIdle: 1, listeningAfterIdle: false },
  ])("keeps interruption and hands-free independent: $handsFree/$allow", async ({
    handsFree,
    allow,
    stoppedDuringOutput,
    startsAfterIdle,
    listeningAfterIdle,
  }) => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options, callbacks } = createHookOptions(conversation, {
      handsFree,
      allowVoiceInterruption: allow,
    });
    const controls = await mountHook(options);
    await run(() => controls.startListening());
    const session = realtimeMocks.sessions[0]!;
    const audio = realtimeMocks.audioEngines[0]!;

    await run(() => session.emit({
      type: "input-transcript",
      text: "Matrix question",
      interim: false,
    }));
    await run(() => session.emit({
      type: "audio",
      pcm16: new Int16Array([1, -1]),
      sampleRate: 24_000,
    }));
    expect(audio.stopInput.mock.calls.length > 0).toBe(stoppedDuringOutput);

    await run(() => session.emit({ type: "turn-complete" }));
    await run(() => audio.finishOutput());

    expect(audio.startInput).toHaveBeenCalledTimes(startsAfterIdle);
    expect(callbacks.setListening).toHaveBeenLastCalledWith(listeningAfterIdle);
    if (!handsFree) expect(session.endAudio).toHaveBeenCalledOnce();
  });

  it("stops microphone capture when reconnect retries terminate", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options, callbacks } = createHookOptions(conversation);
    const controls = await mountHook(options);
    await run(() => controls.startListening());
    const session = realtimeMocks.sessions[0]!;
    const audio = realtimeMocks.audioEngines[0]!;

    await run(() => session.emit({
      type: "error",
      error: new GoogleLiveSessionError(
        "CONNECTION_FAILED",
        "Realtime connection failed.",
      ),
    }));
    await run(() => session.emit({ type: "status", status: "closed" }));

    expect(audio.stopInput).toHaveBeenCalledOnce();
    expect(audio.inputActive).toBe(false);
    expect(callbacks.setListening).toHaveBeenLastCalledWith(false);
    expect(callbacks.setStatus).toHaveBeenLastCalledWith(
      "error",
      "Realtime connection failed.",
    );
  });

  it("does not reopen a microphone whose asynchronous startup was stopped", async () => {
    let releaseStart!: () => void;
    realtimeMocks.setStartInputGate(new Promise<void>((resolve) => {
      releaseStart = resolve;
    }));
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options, callbacks } = createHookOptions(conversation);
    const controls = await mountHook(options);
    let starting!: Promise<void>;
    await act(async () => {
      starting = controls.startListening();
      for (let count = 0; count < 4; count += 1) await Promise.resolve();
    });
    const audio = realtimeMocks.audioEngines[0]!;
    expect(audio.startInput).toHaveBeenCalledOnce();

    await run(() => controls.stopListening());
    releaseStart();
    await run(() => starting);

    expect(audio.inputActive).toBe(false);
    expect(callbacks.setListening).toHaveBeenLastCalledWith(false);
  });

  it("seeds a replacement session from the just-persisted interrupted turn", async () => {
    const staleConversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options } = createHookOptions(staleConversation);
    const controls = await mountHook(options);
    await run(() => controls.sendText("First question"));
    const firstSession = realtimeMocks.sessions[0]!;
    await run(() => firstSession.emit({ type: "output-transcript", text: "Partial answer" }));

    await run(() => controls.sendText("Replacement question"));

    expect(realtimeMocks.sessions).toHaveLength(2);
    expect(realtimeMocks.sessions[1]!.attemptHistory).toEqual([
      { role: "user", text: "First question" },
      { role: "model", text: "Partial answer" },
    ]);
    expect(activeMessages().slice(0, 2)).toMatchObject([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Partial answer", interrupted: true },
    ]);
  });

  it("closes an in-flight turn on a fresh retry without resending its input", async () => {
    const conversation = conversationStoreMock.state.conversations[0] as unknown as Conversation;
    const { options } = createHookOptions(conversation);
    const controls = await mountHook(options);
    await run(() => controls.sendText("Do this once"));
    const session = realtimeMocks.sessions[0]!;
    await run(() => session.emit({ type: "output-transcript", text: "Partial result" }));
    expect(session.sendText).toHaveBeenCalledOnce();

    await run(() => session.emit({ type: "setup-complete", resumed: false }));

    expect(session.sendText).toHaveBeenCalledOnce();
    expect(activeMessages()).toMatchObject([
      { role: "user", content: "Do this once" },
      { role: "assistant", content: "Partial result", interrupted: true },
    ]);
    expect(session.options.historyProvider?.()).toEqual([
      { role: "user", text: "Do this once" },
      { role: "model", text: "Partial result" },
    ]);
  });
});
