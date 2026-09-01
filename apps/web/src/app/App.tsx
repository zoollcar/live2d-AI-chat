import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAgentRuntime, type AgentEvent, type ChatMessage } from "@/agent";
import { createAgentToolRegistry } from "@/agent/tools";
import {
  getChromePromptApiAvailability,
  isChromePromptApiSupported,
} from "@/agent/chrome-prompt-api";
import { summarizeConversation } from "@/agent/conversation-summarizer";
import { prefixAgentStatus } from "@/agent/status-context";
import type { StatusKind } from "@/agent/types";
import { createSystemMessage } from "@/agent/system-prompt";
import { useCharacterStore } from "@/infrastructure/character/store";
import { useSettingsStore } from "@/infrastructure/config/store";
import { useConversationStore, type NewConversationInput } from "@/infrastructure/conversation/store";
import { createLogger } from "@/infrastructure/log";
import {
  buildAttachmentPrompt,
  createConversationResourceController,
  resourceRepository,
  type ConversationResourceController,
} from "@/infrastructure/resources";
import {
  createCurrentModelImageInspector,
  resolveImageInspectionCapability,
} from "@/infrastructure/vision";
import { isDirectCorsGuidanceError } from "@/infrastructure/network/direct-fetch";
import { createSttProvider, type SpeechRecognitionProvider } from "@/interaction/stt";
import { SpeechQueue } from "@/interaction/speech/speech-queue";
import { SentenceSegmenter } from "@/interaction/speech/sentence-segmenter";
import { createTtsProvider } from "@/interaction/tts";
import type { CharacterProfile } from "@/model/character-profile";
import { createModelSnapshot } from "@/model/conversation";
import { buildRuntimeConversationMessages, planConversationCompaction } from "@/model/conversation-compaction";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { ArtifactRef, LlmSettings, ResourceRef, StageLayoutId } from "@live2d-chat/shared";
import {
  extractComposerUrls,
  MessageComposer,
  type ComposerAttachment,
} from "@/presentation/composer/MessageComposer";
import { StageWorkspaceDesktop } from "@/presentation/stage-desktop";
import type { StageArtifact, StageLayoutLease } from "@/model/stage-workspace";
import { Live2DStage } from "@/presentation/stage/Live2DStage";
import { useGoogleRealtime } from "./use-google-realtime";

const log = createLogger("app");

const SettingsPanel = lazy(() => import("@/presentation/settings/SettingsPanel")
  .then((module) => ({ default: module.SettingsPanel })));

interface Status {
  kind: StatusKind;
  message: string;
  progress?: number;
}

interface MemoryStatus {
  kind: "busy" | "idle" | "error";
  message: string;
}

const STATUS_READY: Status = { kind: "idle", message: "Ready" };

function conversationSeed(profile: CharacterProfile, settings: LlmSettings): NewConversationInput {
  return {
    characterId: profile.id,
    modelSnapshot: createModelSnapshot(settings),
    messages: [
      createSystemMessage(profile),
      ...(profile.firstMessage ? [{ role: "assistant", content: profile.firstMessage } satisfies ChatMessage] : []),
    ],
  };
}

function latestVisibleMessage(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "system" && message.content.trim()) return message.content;
  }
  return "";
}

function artifactRefFromToolOutput(output: unknown): ArtifactRef | undefined {
  if (!output || typeof output !== "object") return undefined;
  const value = output as Partial<ArtifactRef>;
  if (typeof value.id !== "string" || typeof value.resourceId !== "string") return undefined;
  if (value.kind !== "resource-view" && value.kind !== "svg-drawing" && value.kind !== "sticker") return undefined;
  return { id: value.id, resourceId: value.resourceId, kind: value.kind };
}

export default function App() {
  const { settings, hydrated, hydrateSecrets } = useSettingsStore();
  const { profiles, activeProfileId, setActiveProfile } = useCharacterStore();
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const {
    conversations,
    activeConversationId,
    hydrated: conversationsHydrated,
    hydrate: hydrateConversations,
    create: createConversation,
    select: selectConversation,
    updateMessages: setMessages,
    applyCompaction,
    flushActive: flushActiveConversation,
    delete: deleteConversation,
  } = useConversationStore();
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const messages = activeConversation?.messages ?? [];
  const conversationLlmSettings = useMemo(() => ({
    ...settings.llm,
    ...(activeConversation?.modelSnapshot ?? {}),
  }), [activeConversation?.modelSnapshot, settings.llm]);
  const effectiveTtsSettings = useMemo(() => ({
    ...settings.tts,
    ...(activeProfile.voice.ttsProvider ? { provider: activeProfile.voice.ttsProvider } : {}),
    ...(activeProfile.voice.voice !== undefined ? { voice: activeProfile.voice.voice } : {}),
    ...(activeProfile.voice.language !== undefined ? { language: activeProfile.voice.language } : {}),
    ...(activeProfile.voice.rate !== undefined ? { rate: activeProfile.voice.rate } : {}),
    ...(activeProfile.voice.pitch !== undefined ? { pitch: activeProfile.voice.pitch } : {}),
  }), [activeProfile.voice, settings.tts]);
  const [chromeImageInputSupported, setChromeImageInputSupported] = useState(false);
  const imageInspectionCapability = useMemo(
    () => resolveImageInspectionCapability(conversationLlmSettings, settings.capabilities, {
      chromeImageInputSupported,
    }),
    [chromeImageInputSupported, conversationLlmSettings, settings.capabilities],
  );
  const [scene, setScene] = useState<SceneController>();
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>([]);
  const [resourceController, setResourceController] = useState<ConversationResourceController>();
  const [subtitle, setSubtitle] = useState("Loading the Live2D model…");
  const [status, setStatus] = useState<Status>({ kind: "busy", message: "Initializing stage" });
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [running, setRunning] = useState(false);
  const realtimeNeedsConfiguration = settings.voiceRoute === "realtime"
    && !settings.realtime.google.apiKey.trim();

  useEffect(() => {
    let active = true;
    setChromeImageInputSupported(false);
    if (conversationLlmSettings.transport !== "chrome" || settings.capabilities.vision === "disabled") {
      return () => { active = false; };
    }
    void getChromePromptApiAvailability({ inspectImage: true }).then((availability) => {
      if (active) setChromeImageInputSupported(isChromePromptApiSupported(availability));
    });
    return () => { active = false; };
  }, [conversationLlmSettings.transport, settings.capabilities.vision]);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const sttRef = useRef<SpeechRecognitionProvider | undefined>(undefined);
  const speechQueueRef = useRef<SpeechQueue | undefined>(undefined);
  const segmenterRef = useRef(new SentenceSegmenter());
  // Tracks whether continuous recognition should be active across turns so the
  // auto-restart effect can decide whether to reopen the mic once the AI is
  // done talking. The ref (not state) is read inside async callbacks where we
  // don't want a stale closure to over- or under-restart STT.
  const continuousRef = useRef(false);
  // Mirrors `listening` as a ref so async callbacks can ask "is the mic still
  // supposed to be on right now?" without re-creating callbacks on every state
  // change.
  const listeningRef = useRef(false);
  // Set when the user submits a message by typing (form submit / Enter) so the
  // LLM `done` handler and Chrome's no-speech `onAutoEnd` know to skip the
  // mic auto-restart. Without this, after the AI replies to a typed message
  // the mic would pop back on whenever `settings.stt.continuous` is on —
  // which is wrong because the user explicitly chose to type rather than speak.
  const userTypedRef = useRef(false);
  const activeConversationRef = useRef(activeConversation);
  const compactionControllersRef = useRef(new Map<string, AbortController>());
  const memoryStatusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resourceControllerRef = useRef<ConversationResourceController | undefined>(undefined);
  const hiddenComposerResourcesRef = useRef(new Set<string>());
  const pendingAttachmentsRef = useRef<ComposerAttachment[]>([]);
  const attachmentSlotsInFlightRef = useRef(0);
  const recognizedUrlAttachmentsRef = useRef(new Map<string, {
    state: "attaching" | "attached";
    resourceId?: string;
  }>());
  const automaticStageLayoutRef = useRef<{
    original: StageLayoutId;
    applied: StageLayoutId;
    appliedRevision: number;
  } | undefined>(undefined);

  useEffect(() => { activeConversationRef.current = activeConversation; }, [activeConversation]);
  useEffect(() => { pendingAttachmentsRef.current = pendingAttachments; }, [pendingAttachments]);

  const updatePendingAttachments = useCallback((
    updater: (current: readonly ComposerAttachment[]) => ComposerAttachment[],
  ) => {
    const next = updater(pendingAttachmentsRef.current);
    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
  }, []);

  useEffect(() => {
    hiddenComposerResourcesRef.current.clear();
    const storedConversation = useConversationStore.getState().conversations.find((conversation) =>
      conversation.id === activeConversationId);
    for (const message of storedConversation?.messages ?? []) {
      for (const attachment of message.attachments ?? []) {
        hiddenComposerResourcesRef.current.add(attachment.id);
      }
    }
    recognizedUrlAttachmentsRef.current.clear();
    attachmentSlotsInFlightRef.current = 0;
    updatePendingAttachments(() => []);
    if (!activeConversationId) return;
    const inspector = createCurrentModelImageInspector({
      repository: resourceRepository,
      settings: conversationLlmSettings,
      capabilities: settings.capabilities,
      chromeImageInputSupported,
    });
    const controller = createConversationResourceController({
      conversationId: activeConversationId,
      contentSettings: settings.content,
      ...(inspector.capability.available ? { inspectImage: inspector.inspect } : {}),
      onUpdate: ({ resource, errorMessage }) => {
        if (resourceControllerRef.current !== controller) return;
        if (errorMessage && isDirectCorsGuidanceError(new Error(errorMessage))) setSettingsOpen(true);
        if (hiddenComposerResourcesRef.current.has(resource.id)) {
          // Processing web pages and transcripts may be sent before the
          // provider finishes. Keep the history reference synchronized with
          // the authoritative resource record so status/title/size do not
          // remain frozen at the moment the message was submitted.
          setMessages((current) => current.map((message) => {
            if (!message.attachments?.some((attachment) => attachment.id === resource.id)) return message;
            return {
              ...message,
              attachments: message.attachments.map((attachment) =>
                attachment.id === resource.id ? resource : attachment),
            };
          }));
          return;
        }
        updatePendingAttachments((current) => {
          const existing = current.findIndex((attachment) => attachment.id === resource.id);
          const next: ComposerAttachment = { ...resource, errorMessage };
          if (existing < 0) return [...current, next].slice(-10);
          return current.map((attachment, index) => index === existing ? next : attachment);
        });
      },
      onNotification: (message) => {
        if (resourceControllerRef.current !== controller) return;
        setStatus({ kind: "idle", message });
      },
    });
    resourceControllerRef.current = controller;
    setResourceController(controller);
    return () => {
      if (resourceControllerRef.current === controller) resourceControllerRef.current = undefined;
      controller.dispose();
      setResourceController((current) => current === controller ? undefined : current);
    };
  }, [
    activeConversationId,
    chromeImageInputSupported,
    conversationLlmSettings,
    setMessages,
    settings.capabilities,
    settings.content,
    updatePendingAttachments,
  ]);

  useEffect(() => {
    if (!hydrated) hydrateSecrets();
  }, [hydrateSecrets, hydrated]);

  useEffect(() => {
    if (!conversationsHydrated) void hydrateConversations(conversationSeed(activeProfile, settings.llm));
  }, [activeProfile, conversationsHydrated, hydrateConversations, settings.llm]);

  useEffect(() => {
    if (!activeConversation) return;
    const characterState = useCharacterStore.getState();
    if (activeConversation.characterId === characterState.activeProfileId) return;
    const conversationProfile = characterState.profiles.find((profile) => profile.id === activeConversation.characterId);
    if (conversationProfile) setActiveProfile(conversationProfile.id);
  }, [activeConversation?.characterId, activeConversation?.id, setActiveProfile]);

  useEffect(() => {
    if (settings.voiceRoute !== "classic"
      || !activeConversation
      || (conversationLlmSettings.transport === "local" && running)) return;
    const plan = planConversationCompaction(activeConversation);
    if (!plan || compactionControllersRef.current.has(activeConversation.id)) return;
    const controller = new AbortController();
    compactionControllersRef.current.set(activeConversation.id, controller);
    if (memoryStatusTimerRef.current) clearTimeout(memoryStatusTimerRef.current);
    setMemoryStatus({ kind: "busy", message: `Memory: compressing ${activeConversation.title}` });
    void summarizeConversation(plan, conversationLlmSettings, controller.signal)
      .then(async (summary) => {
        const applied = await applyCompaction(plan, summary);
        if (!applied) return;
        setMemoryStatus({ kind: "idle", message: "Memory compressed" });
        memoryStatusTimerRef.current = setTimeout(() => setMemoryStatus(undefined), 2500);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          setMemoryStatus(undefined);
          return;
        }
        setMemoryStatus({
          kind: "error",
          message: `Memory compression failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      })
      .finally(() => compactionControllersRef.current.delete(activeConversation.id));
  }, [activeConversation, applyCompaction, conversationLlmSettings, running, settings.voiceRoute]);

  useEffect(() => () => {
    for (const controller of compactionControllersRef.current.values()) controller.abort();
    if (memoryStatusTimerRef.current) clearTimeout(memoryStatusTimerRef.current);
  }, []);

  useEffect(() => {
    if (!scene || settings.voiceRoute !== "classic") {
      speechQueueRef.current?.cancel();
      speechQueueRef.current = undefined;
      return;
    }
    speechQueueRef.current?.cancel();
    const provider = createTtsProvider(effectiveTtsSettings);
    speechQueueRef.current = new SpeechQueue(provider, effectiveTtsSettings, scene, (sentence) => {
      setSubtitle(sentence);
      setStatus({ kind: "busy", message: "AI is speaking" });
    }, (error) => {
      if (effectiveTtsSettings.transport === "direct" && isDirectCorsGuidanceError(error)) {
        setSettingsOpen(true);
      }
      setStatus({ kind: "error", message: `Speech synthesis error: ${error.message}` });
    });
    return () => speechQueueRef.current?.cancel();
  }, [effectiveTtsSettings, scene, settings.voiceRoute]);

  // Mirror `messages` into a ref so `sendMessage` can read the latest history
  // snapshot regardless of which version of the callback actually runs.
  // Without this, `useCallback([..., messages, ...])` would recreate
  // sendMessage on every message update, but the recognition callbacks that
  // fire onFinal would still hold the first version and replay the original
  // exchange forever.
  const messagesRef = useRef<ChatMessage[]>(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const visibleMessages = useMemo(() => messages.filter((message) => message.role !== "system"), [messages]);

  const {
    sendText: sendRealtimeText,
    startListening: startRealtimeListening,
    stopListening: stopRealtimeListening,
    stopEverything: stopRealtimeEverything,
    dispose: disposeRealtime,
    testConnection: testRealtimeConnection,
  } = useGoogleRealtime({
    enabled: settings.voiceRoute === "realtime",
    scene,
    profile: activeProfile,
    conversation: activeConversation,
    settings: settings.realtime,
    interaction: settings.voiceInteraction,
    resources: resourceController?.resources,
    workspace: resourceController?.workspace,
    network: resourceController?.network,
    toolCapabilities: { inspectImage: imageInspectionCapability.available },
    callbacks: {
      setListening: (value) => {
        listeningRef.current = value;
        setListening(value);
      },
      setRunning,
      setSubtitle,
      setStatus: (kind, message) => setStatus({ kind, message }),
      openSettings: () => setSettingsOpen(true),
    },
  });

  // Full teardown — used when the user explicitly wants to leave the
  // conversation (escape, close tab, switch provider, etc.). Stops the LLM
  // stream, the TTS queue and the mic.
  const stopEverything = useCallback(() => {
    log.debug("stopEverything invoked", { hadAbort: !!abortRef.current, hadStt: !!sttRef.current });
    abortRef.current?.abort();
    abortRef.current = undefined;
    sttRef.current?.abort();
    sttRef.current = undefined;
    segmenterRef.current.reset();
    speechQueueRef.current?.cancel();
    listeningRef.current = false;
    continuousRef.current = false;
    userTypedRef.current = false;
    setListening(false);
    setRunning(false);
    void disposeRealtime();
  }, [disposeRealtime]);

  useEffect(() => {
    if (settings.voiceRoute !== "realtime") return;
    for (const controller of compactionControllersRef.current.values()) controller.abort();
    setMemoryStatus(undefined);
    abortRef.current?.abort();
    abortRef.current = undefined;
    sttRef.current?.abort();
    sttRef.current = undefined;
    segmenterRef.current.reset();
    speechQueueRef.current?.cancel();
    listeningRef.current = false;
    continuousRef.current = false;
    setListening(false);
    setRunning(false);
  }, [settings.voiceRoute]);

  // Soft interrupt — stops the AI's current LLM stream and any in-flight TTS
  // but leaves the STT session alive so the user can barge in with another
  // utterance without re-clicking the mic. Used by `onFinal` and the mic
  // button's "interrupt" action.
  const interruptPlayback = useCallback(() => {
    log.debug("interruptPlayback invoked", { hadAbort: !!abortRef.current });
    abortRef.current?.abort();
    abortRef.current = undefined;
    segmenterRef.current.reset();
    speechQueueRef.current?.cancel();
    setRunning(false);
  }, []);

  useEffect(() => {
    if (!scene) return;
    let cancelled = false;
    stopEverything();
    setSubtitle(latestVisibleMessage(activeConversation?.messages ?? []));
    setStatus({ kind: "busy", message: `Loading ${activeProfile.name}` });
    scene.setDecorations(activeProfile.live2d.defaultDecorations);
    scene.setStageLayout(activeProfile.live2d.defaultLayout);
    void scene.setState(activeProfile.live2d.defaultState).then(() => {
      if (!cancelled) setStatus(STATUS_READY);
    }).catch((error) => {
      if (!cancelled) setStatus({ kind: "error", message: `Character switch failed: ${error instanceof Error ? error.message : "Unknown error"}` });
    });
    return () => { cancelled = true; };
  }, [activeConversation?.id, activeProfile, scene, stopEverything]);

  const sendClassicMessage = useCallback(async (
    rawText: string,
    attachments: readonly ResourceRef[] = [],
  ) => {
    const text = rawText.trim();
    if ((!text && attachments.length === 0) || !scene) return;
    if (conversationLlmSettings.transport === "local" && activeConversationId) {
      compactionControllersRef.current.get(activeConversationId)?.abort();
    }
    // Only stop the AI's playback; keep STT alive so continuous listeners can
    // barge in without re-clicking the mic.
    interruptPlayback();
    if (!settings.voiceInteraction.allowVoiceInterruption) {
      sttRef.current?.abort();
      sttRef.current = undefined;
      listeningRef.current = false;
      setListening(false);
    }
    const controller = new AbortController();
    abortRef.current = controller;
    // Read the latest history from the ref so this callback works correctly
    // even when called from a stale closure (e.g. the onFinal handler that was
    // registered before subsequent messages were appended).
    const userMessage: ChatMessage = {
      role: "user",
      content: text,
      inputMode: userTypedRef.current ? "text" : "voice",
      ...(attachments.length ? { attachments: [...attachments] } : {}),
    };
    const history: ChatMessage[] = [...messagesRef.current, userMessage];
    const contextHistory = activeConversationRef.current
      ? buildRuntimeConversationMessages(activeConversationRef.current)
      : messagesRef.current;
    // Keep React history pristine for display and future turns. Only the
    // current runtime request sees the changing environment block, placed at
    // the end of the multi-turn prompt to preserve the longest stable prefix.
    const runtimeHistory: ChatMessage[] = [
      ...contextHistory,
      {
        ...userMessage,
        content: prefixAgentStatus(buildAttachmentPrompt(text, attachments), scene.snapshot()),
      },
    ];
    setMessages(() => [...history, { role: "assistant", content: "" }]);
    setInput("");
    setSubtitle(text);
    setStatus({ kind: "busy", message: "AI is thinking" });
    setRunning(true);
    const runtime = createAgentRuntime(conversationLlmSettings);

    const emit = (event: AgentEvent) => {
      if (event.type === "text-delta") {
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + event.delta };
          return next;
        });
        for (const sentence of segmenterRef.current.push(event.delta)) speechQueueRef.current?.enqueue(sentence);
      } else if (event.type === "reasoning-delta") {
        // Append reasoning onto the trailing assistant message so the chat
        // history's "Thinking" section grows in sync with the stream. We
        // don't surface reasoning in the subtitle or send it to TTS — only
        // the visible reply text should be spoken aloud.
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, reasoning: (last.reasoning ?? "") + event.delta };
          }
          return next;
        });
      } else if (event.type === "status") {
        // Forward the structured status as-is so the chip can render the
        // correct colour/animation/progress bar. Drop `progress` when the
        // kind isn't `progress` to avoid a stale bar sticking around.
        const { kind, message, progress } = event;
        setStatus(kind === "progress" && typeof progress === "number"
          ? { kind, message, progress }
          : { kind, message });
      } else if (event.type === "tool-call") {
        // The registry emits this when a tool's execute() actually runs
        // (after the SDK parsed the input). Keep the chip consistent with
        // what we already announced in tool-input-start, and record the
        // call on the trailing assistant message so chat history can show
        // it later.
        setStatus({ kind: "busy", message: `Running tool: ${event.name}` });
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant") {
            const toolCalls = [...(last.toolCalls ?? []), { callId: event.callId, name: event.name, input: event.input }];
            next[next.length - 1] = { ...last, toolCalls };
          }
          return next;
        });
      } else if (event.type === "tool-result") {
        // The tool finished — patch its output onto the matching record so
        // chat history can show the input/output pair. The local runtime
        // runs tools sequentially and emits `tool-result` in execution order;
        // the remote runtime can fire them in parallel but each `tool-result`
        // event carries the provider callId, so duplicate concurrent calls
        // to the same tool cannot steal each other's results.
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant" && last.toolCalls) {
            const toolCalls = last.toolCalls.map((record) =>
              record.callId === event.callId ? { ...record, output: event.output } : record);
            const artifact = artifactRefFromToolOutput(event.output);
            next[next.length - 1] = {
              ...last,
              toolCalls,
              ...(artifact ? { artifacts: [...(last.artifacts ?? []), artifact] } : {}),
            };
          }
          return next;
        });
      } else if (event.type === "tool-error") {
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant" && last.toolCalls) {
            next[next.length - 1] = {
              ...last,
              toolCalls: last.toolCalls.map((record) =>
                record.callId === event.callId ? { ...record, error: event.error } : record),
            };
          }
          return next;
        });
      } else if (event.type === "tool-cancel") {
        setMessages((current) => {
          const next = [...current];
          const last = next.at(-1);
          if (last?.role === "assistant" && last.toolCalls) {
            next[next.length - 1] = {
              ...last,
              toolCalls: last.toolCalls.map((record) =>
                record.callId === event.callId ? { ...record, canceled: true } : record),
            };
          }
          return next;
        });
      } else if (event.type === "error") {
        if (conversationLlmSettings.transport === "direct" && isDirectCorsGuidanceError(event.error)) {
          setSettingsOpen(true);
        }
        setStatus({ kind: "error", message: `Error: ${event.error.message}` });
        setRunning(false);
        void flushActiveConversation();
      } else if (event.type === "done") {
        const remaining = segmenterRef.current.flush();
        if (remaining) speechQueueRef.current?.enqueue(remaining);
        // Model generation completing is not the same as audible output
        // completing. Keep the route busy and the non-interruptible mic gated
        // until the final TTS item has really drained from the playback queue.
        const queue = speechQueueRef.current;
        void (queue?.whenIdle() ?? Promise.resolve()).then(() => {
          if (controller.signal.aborted || abortRef.current !== controller) return;
          abortRef.current = undefined;
          setStatus(STATUS_READY);
          setRunning(false);
          void flushActiveConversation();
          if (continuousRef.current && !userTypedRef.current) {
            log.debug("agent audio idle — auto-restarting listener (fresh session)");
            void restartListeningRef.current?.();
          }
          userTypedRef.current = false;
        });
      }
    };

    await runtime.run({
      messages: runtimeHistory,
      settings: conversationLlmSettings,
      scene,
      resources: resourceController?.resources,
      workspace: resourceController?.workspace,
      network: resourceController?.network,
      toolCapabilities: { inspectImage: imageInspectionCapability.available },
      enabledTools: activeProfile.enabledTools,
      signal: controller.signal,
      emit,
    });
  }, [
    activeConversationId,
    conversationLlmSettings,
    flushActiveConversation,
    interruptPlayback,
    imageInspectionCapability.available,
    activeProfile.enabledTools,
    resourceController,
    scene,
    setMessages,
    settings.voiceInteraction.allowVoiceInterruption,
  ]);

  const sendMessage = useCallback(async (
    text: string,
    attachments: readonly ResourceRef[] = [],
  ) => {
    try {
      if (settings.voiceRoute === "realtime") {
        try {
          await sendRealtimeText(text, attachments, buildAttachmentPrompt(text, attachments));
        } finally {
          // Realtime records the input mode in its own turn state. Do not let
          // this classic-route guard leak into a later voice turn after a
          // route switch, including when setup failed.
          userTypedRef.current = false;
        }
      } else {
        await sendClassicMessage(text, attachments);
      }
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Unable to send the message.",
      });
    }
  }, [sendClassicMessage, sendRealtimeText, settings.voiceRoute]);

  // startListeningRef mirrors `startListening` so async callbacks above can
  // reach the latest version without rebuilding sendMessage every time STT
  // settings change.
  const startListeningRef = useRef<(() => Promise<void>) | undefined>(undefined);
  // sendMessageRef mirrors `sendMessage` so the recognition callbacks
  // registered in startListening() always reach the version built against the
  // latest `messages` snapshot. Without this, the first onFinal wires up
  // callbacks that close over `messages` at that instant; subsequent turns
  // would then build history from the stale array and either repeat the first
  // exchange or send a history missing the LLM's previous reply.
  const sendMessageRef = useRef<((text: string, attachments?: readonly ResourceRef[]) => Promise<void>) | undefined>(undefined);

  const startListening = useCallback(async () => {
    if (running && !settings.voiceInteraction.allowVoiceInterruption) {
      setStatus({ kind: "busy", message: "Voice interruptions are disabled while the AI is speaking" });
      return;
    }
    log.debug("startListening: invoked", { provider: settings.stt.provider, lang: settings.stt.language });
    // Tear down any prior STT instance — this is the only safe path that
    // touches the mic. sendMessage() no longer aborts STT, so this is the
    // sole place that does.
    sttRef.current?.abort();
    sttRef.current = undefined;
    const provider = createSttProvider(settings.stt);
    log.debug("startListening: provider created", { id: provider.id, isSupported: provider.isSupported() });
    sttRef.current = provider;
    try {
      await provider.start({
        onSpeechStart: () => {
          if (settings.voiceInteraction.allowVoiceInterruption) interruptPlayback();
        },
        onInterim: (text) => {
          log.debug("onInterim", { length: text.length, text });
          if (settings.voiceInteraction.allowVoiceInterruption) interruptPlayback();
          setSubtitle(text);
        },
        onFinal: (text) => {
          log.debug("onFinal", { length: text.length, text });
          setSubtitle(text);
          if (!text) return;
          // Barge-in: cut the AI's playback but keep this STT session alive
          // so the next utterance flows through the same recognition stream.
          if (settings.voiceInteraction.allowVoiceInterruption) interruptPlayback();
          // Go through the ref so we always invoke the version of sendMessage
          // built against the latest `messages`, not the one captured when
          // these callbacks were first registered.
          void sendMessageRef.current?.(text);
        },
        onStatus: (next) => {
          log.debug("onStatus", { next });
          setListening(next === "listening");
          listeningRef.current = next === "listening";
          if (next === "processing") {
            setStatus({ kind: "busy", message: "Transcribing speech" });
          } else if (next === "listening") {
            setStatus({ kind: "busy", message: "Listening" });
          } else {
            setStatus(STATUS_READY);
          }
        },
        onError: (error) => {
          log.error("onError", { message: error.message });
          if (settings.stt.transport === "direct" && isDirectCorsGuidanceError(error)) setSettingsOpen(true);
          setStatus({ kind: "error", message: `Speech recognition error: ${error.message}` });
          setListening(false);
          listeningRef.current = false;
        },
        onAutoEnd: () => {
          log.debug("onAutoEnd — recognition session ended on its own");
          setListening(false);
          listeningRef.current = false;
          // In continuous mode, reopen the mic after Chrome's no-speech
          // timeout. Guard against the case where the user toggled continuous
          // off mid-session and the LLM `done` is still pending. Also skip
          // when the user just typed their last message — they're using
          // text input and don't want the mic popping back on.
          if (continuousRef.current && !userTypedRef.current) {
            log.debug("onAutoEnd — continuous mode, restarting mic");
            void restartListeningRef.current?.();
          }
        },
      });
      log.debug("startListening: provider.start() resolved");
    } catch (error) {
      log.error("startListening: provider.start() threw", { error: String(error) });
      if (sttRef.current === provider) {
        sttRef.current?.abort();
        sttRef.current = undefined;
      }
      setStatus({ kind: "error", message: `Speech recognition error: ${error instanceof Error ? error.message : "Unavailable"}` });
      setListening(false);
      listeningRef.current = false;
    }
  }, [interruptPlayback, running, settings.stt, settings.voiceInteraction.allowVoiceInterruption]);

  // Force a clean STT session: abort whatever's running and start fresh. This
  // is what the auto-restart path uses after the LLM finishes speaking,
  // because Chrome's `continuous: true` mode never fires `onend` on its own —
  // it keeps the same recognition object alive across turns and starts
  // returning bogus empty-final results once the AI's TTS bleeds into the
  // mic. A hard restart gives us a clean Chrome session per turn.
  const restartListening = useCallback(async () => {
    log.debug("restartListening: tearing down STT for fresh session");
    sttRef.current?.abort();
    sttRef.current = undefined;
    setListening(false);
    listeningRef.current = false;
    // Small grace period so the user can hear the AI's last sentence fully
    // before the mic reopens — keeps feedback from being interpreted as the
    // user's next utterance.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await startListeningRef.current?.();
  }, []);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  // restartListeningRef mirrors restartListening for the same reason — the
  // recognition callbacks and the LLM's emit() handler both need the latest
  // version without rebuilding sendMessage on every render.
  const restartListeningRef = useRef<(() => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    restartListeningRef.current = restartListening;
  }, [restartListening]);

  const stopListening = useCallback(async () => {
    log.debug("stopListening: invoked");
    continuousRef.current = false;
    await sttRef.current?.stop();
    setListening(false);
    listeningRef.current = false;
    log.debug("stopListening: stopped");
  }, []);

  // Shared entry point for messages the user typed instead of spoke. Marks
  // the turn as typed so the auto-restart logic in the LLM `done` handler
  // (and Chrome's no-speech `onAutoEnd`) leave the mic off until the user
  // clicks it again. Called from both the form submit and the textarea
  // Enter-key path.
  const submitTypedMessage = useCallback((text: string, attachments: readonly ResourceRef[] = []) => {
    userTypedRef.current = true;
    void sendMessage(text, attachments);
  }, [sendMessage]);

  const attachFiles = useCallback(async (files: readonly File[]) => {
    const controller = resourceControllerRef.current;
    if (!controller || files.length === 0) return;
    if (pendingAttachmentsRef.current.length + attachmentSlotsInFlightRef.current + files.length > 10) {
      setStatus({ kind: "error", message: "A message can contain at most 10 attachments" });
      return;
    }
    attachmentSlotsInFlightRef.current += files.length;
    setStatus({ kind: "busy", message: `Processing ${files.length} attachment${files.length === 1 ? "" : "s"}` });
    try {
      const attached = await controller.attachFiles(files);
      if (resourceControllerRef.current !== controller) return;
      const ready = attached.filter((resource) => resource.status === "ready");
      for (const resource of ready) {
        if (resourceControllerRef.current !== controller) return;
        await controller.showResource(resource.id);
      }
      if (resourceControllerRef.current !== controller) return;
      if (ready.some((resource) => resource.kind === "image") && !imageInspectionCapability.available) {
        setStatus({
          kind: "idle",
          message: "Image preview ready; the current model does not support image inspection",
        });
      } else {
        setStatus({ kind: "idle", message: `${ready.length} attachment${ready.length === 1 ? "" : "s"} ready` });
      }
    } catch (error) {
      if (resourceControllerRef.current !== controller) return;
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "The attachments could not be processed.",
      });
    } finally {
      if (resourceControllerRef.current === controller) {
        attachmentSlotsInFlightRef.current = Math.max(0, attachmentSlotsInFlightRef.current - files.length);
      }
    }
  }, [imageInspectionCapability.available]);

  const attachRecognizedUrls = useCallback(async (urls: readonly string[]) => {
    const controller = resourceControllerRef.current;
    if (!controller || urls.length === 0) return;
    const uniqueUrls = urls.filter((url) => !recognizedUrlAttachmentsRef.current.has(url));
    if (uniqueUrls.length === 0) return;
    if (pendingAttachmentsRef.current.length + attachmentSlotsInFlightRef.current + uniqueUrls.length > 10) {
      setStatus({ kind: "error", message: "A message can contain at most 10 attachments" });
      return;
    }
    attachmentSlotsInFlightRef.current += uniqueUrls.length;
    for (const url of uniqueUrls) recognizedUrlAttachmentsRef.current.set(url, { state: "attaching" });
    for (const url of uniqueUrls) {
      try {
        const resource = await controller.attachUrl(url);
        if (resourceControllerRef.current !== controller) return;
        recognizedUrlAttachmentsRef.current.set(url, { state: "attached", resourceId: resource.id });
        if (hiddenComposerResourcesRef.current.has(resource.id)) continue;
        updatePendingAttachments((current) => current.some((attachment) => attachment.id === resource.id)
          ? [...current]
          : [...current, resource].slice(-10));
      } catch (error) {
        if (resourceControllerRef.current !== controller) return;
        recognizedUrlAttachmentsRef.current.delete(url);
        setStatus({
          kind: "error",
          message: error instanceof Error ? error.message : "The link could not be added.",
        });
      } finally {
        if (resourceControllerRef.current === controller) {
          attachmentSlotsInFlightRef.current = Math.max(0, attachmentSlotsInFlightRef.current - 1);
        }
      }
    }
  }, [updatePendingAttachments]);

  const removePendingAttachment = useCallback((resourceId: string) => {
    hiddenComposerResourcesRef.current.add(resourceId);
    for (const [url, attachment] of recognizedUrlAttachmentsRef.current) {
      if (attachment.resourceId === resourceId) recognizedUrlAttachmentsRef.current.delete(url);
    }
    updatePendingAttachments((current) => current.filter((attachment) => attachment.id !== resourceId));
    void resourceControllerRef.current?.removeResource(resourceId).catch(() => undefined);
  }, [updatePendingAttachments]);

  const submitComposerMessage = useCallback(async () => {
    const recognizedUrls = extractComposerUrls(input);
    const missingUrls = recognizedUrls.filter((url) => !recognizedUrlAttachmentsRef.current.has(url));
    if (missingUrls.length > 0) {
      setStatus({ kind: "busy", message: "Adding linked content before sending" });
      await attachRecognizedUrls(missingUrls);
      setStatus({ kind: "idle", message: "Link added; send when its content is ready" });
      return;
    }
    if (recognizedUrls.some((url) => recognizedUrlAttachmentsRef.current.get(url)?.state === "attaching")) {
      setStatus({ kind: "busy", message: "Linked content is still being added" });
      return;
    }
    const currentAttachments = pendingAttachmentsRef.current;
    const urlResourceIds = recognizedUrls.flatMap((url) => {
      const resourceId = recognizedUrlAttachmentsRef.current.get(url)?.resourceId;
      return resourceId ? [resourceId] : [];
    });
    if (urlResourceIds.some((resourceId) => {
      const attachment = currentAttachments.find((candidate) => candidate.id === resourceId);
      return !attachment || attachment.status === "error";
    })) {
      setStatus({ kind: "error", message: "Retry or remove the failed linked content before sending" });
      return;
    }
    const attachments = currentAttachments.filter((attachment) => attachment.status === "ready"
      || ((attachment.status === "pending" || attachment.status === "processing")
        && (attachment.kind === "web" || attachment.kind === "video-transcript")));
    if (!input.trim() && attachments.length === 0) return;
    for (const attachment of currentAttachments) hiddenComposerResourcesRef.current.add(attachment.id);
    recognizedUrlAttachmentsRef.current.clear();
    updatePendingAttachments(() => []);
    submitTypedMessage(input, attachments);
  }, [attachRecognizedUrls, input, submitTypedMessage, updatePendingAttachments]);

  const onMicButtonClick = useCallback(async () => {
    if (settings.voiceRoute === "realtime") {
      if (listeningRef.current) await stopRealtimeListening();
      else await startRealtimeListening();
      return;
    }
    if (running) {
      if (!settings.voiceInteraction.allowVoiceInterruption) {
        setStatus({ kind: "busy", message: "Voice interruptions are disabled; use Stop to cancel the reply" });
        return;
      }
      // Barge-in: stop the AI's playback and reopen the mic without making
      // the user click again. Leave continuous mode alone so the next reply
      // also auto-restarts. Clear the typed flag so this turn counts as a
      // voice interaction — the AI reply that follows should re-open the
      // mic just like a spoken utterance would.
      log.debug("mic click while running — interrupting AI and opening mic");
      userTypedRef.current = false;
      interruptPlayback();
      if (!listeningRef.current) await startListening();
      return;
    }
    if (listeningRef.current) {
      log.debug("mic click while listening — stopping");
      await stopListening();
    } else {
      log.debug("mic click while idle — starting continuous listening");
      continuousRef.current = settings.voiceInteraction.handsFree;
      await startListening();
    }
  }, [
    interruptPlayback,
    running,
    settings.voiceInteraction.allowVoiceInterruption,
    settings.voiceInteraction.handsFree,
    settings.voiceRoute,
    startListening,
    startRealtimeListening,
    stopListening,
    stopRealtimeListening,
  ]);

  // When the user toggles the "Continuous recognition" setting on while idle,
  // we want the next click of the mic (or a fresh click cycle) to behave
  // accordingly. When they toggle it off mid-session, immediately stop so the
  // auto-restart doesn't kick in after the next AI reply.
  useEffect(() => {
    continuousRef.current = settings.voiceInteraction.handsFree;
    if (!settings.voiceInteraction.handsFree && !running && listeningRef.current) {
      void stopListening();
    }
  }, [running, settings.voiceInteraction.handsFree, stopListening]);

  const onStageReady = useCallback((controller: SceneController) => {
    setScene(controller);
    setSubtitle("");
    setStatus(STATUS_READY);
  }, []);

  const onStageError = useCallback((error: Error) => {
    setStatus({ kind: "error", message: `Model failed to load: ${error.message}` });
  }, []);

  const onStageLayoutLease = useCallback((lease: StageLayoutLease) => {
    if (!scene) return;
    if (lease.reason === "artifact-focus") {
      if (automaticStageLayoutRef.current) return;
      const original = scene.snapshot().layout;
      const applied: StageLayoutId = lease.characterSide === "left"
        ? "half-body-left"
        : "half-body-right";
      if (original !== applied) scene.setStageLayout(applied);
      automaticStageLayoutRef.current = {
        original,
        applied,
        appliedRevision: scene.snapshot().layoutRevision,
      };
      return;
    }
    const automatic = automaticStageLayoutRef.current;
    automaticStageLayoutRef.current = undefined;
    const current = scene.snapshot();
    if (automatic
      && automatic.original !== automatic.applied
      && current.layout === automatic.applied
      && current.layoutRevision === automatic.appliedRevision) {
      scene.setStageLayout(automatic.original);
    }
  }, [scene]);

  const onCloseStageArtifact = useCallback((artifactId: string, expectedLayoutRevision: number) => {
    return resourceControllerRef.current?.closeArtifact(artifactId, expectedLayoutRevision) ?? false;
  }, []);

  const onCancelStageArtifact = useCallback((artifactId: string) => {
    void resourceRepository.getArtifact(artifactId).then((artifact) => {
      if (artifact) resourceControllerRef.current?.cancelResource(artifact.resourceId);
    });
  }, []);

  const onRetryStageArtifact = useCallback((artifactId: string) => {
    void resourceRepository.getArtifact(artifactId).then((artifact) => {
      if (!artifact) return;
      return resourceControllerRef.current?.retryResource(artifact.resourceId);
    }).catch((error) => {
      setStatus({ kind: "error", message: error instanceof Error ? error.message : "Retry failed" });
    });
  }, []);

  const onOpenStageSource = useCallback((artifact: StageArtifact) => {
    const source = artifact.source?.url;
    if (!source) return;
    const parsed = new URL(source);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    const opened = window.open(parsed.toString(), "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  }, []);

  const onCreateConversation = useCallback(async () => {
    stopEverything();
    await createConversation(conversationSeed(activeProfile, settings.llm));
  }, [activeProfile, createConversation, settings.llm, stopEverything]);

  const onActivateCharacter = useCallback(async (profile: CharacterProfile) => {
    stopEverything();
    setActiveProfile(profile.id);
    await createConversation(conversationSeed(profile, settings.llm));
  }, [createConversation, setActiveProfile, settings.llm, stopEverything]);

  const onSelectConversation = useCallback(async (id: string) => {
    const conversation = useConversationStore.getState().conversations.find((item) => item.id === id);
    if (!conversation) return;
    const profile = useCharacterStore.getState().profiles.find((item) => item.id === conversation.characterId);
    if (!profile) throw new Error(`Character profile ${conversation.characterId} is not available.`);
    stopEverything();
    setActiveProfile(profile.id);
    await selectConversation(id);
  }, [selectConversation, setActiveProfile, stopEverything]);

  const onDeleteConversation = useCallback(async (id: string) => {
    stopEverything();
    await deleteConversation(id, conversationSeed(activeProfile, settings.llm));
    const next = useConversationStore.getState().conversations.find((item) =>
      item.id === useConversationStore.getState().activeConversationId);
    const profile = next && useCharacterStore.getState().profiles.find((item) => item.id === next.characterId);
    if (profile) setActiveProfile(profile.id);
  }, [activeProfile, deleteConversation, setActiveProfile, settings.llm, stopEverything]);

  const developerToolRegistry = useMemo(() => scene ? createAgentToolRegistry({
    scene,
    resources: resourceController?.resources,
    workspace: resourceController?.workspace,
    network: resourceController?.network,
    capabilities: { inspectImage: imageInspectionCapability.available },
    enabledTools: activeProfile.enabledTools,
    emit: () => undefined,
  }) : undefined, [activeProfile.enabledTools, imageInspectionCapability.available, resourceController, scene]);

  useEffect(() => {
    const flush = () => { void flushActiveConversation(); };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [flushActiveConversation]);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <Live2DStage onReady={onStageReady} onError={onStageError} />
      <StageWorkspaceDesktop
        characterSide="right"
        restingCharacterSide="center"
        onLayoutLease={onStageLayoutLease}
        onCloseArtifact={onCloseStageArtifact}
        onCancelArtifact={onCancelStageArtifact}
        onRetryArtifact={onRetryStageArtifact}
        onOpenArtifactSource={onOpenStageSource}
      />

      <header className="top-bar glass-panel">
        <div className="brand">
          <img className="brand-mark" src="/brand/ice-girl-logo.png" alt="" aria-hidden="true" />
          <div>
            <strong>{activeProfile.name}</strong>
            <div className="status-chips" aria-live="polite">
              <small className={`status-chip status-${status.kind}`}>
                <span className="status-message">{status.message}</span>
                {status.kind === "progress" && typeof status.progress === "number" ? (
                  <span
                    className="status-progress"
                    role="progressbar"
                    aria-valuenow={Math.round(status.progress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
                  </span>
                ) : null}
              </small>
              {realtimeNeedsConfiguration ? (
                <button
                  className="status-chip status-error status-config-button"
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                >
                  <span className="status-message">Realtime needs configuration</span>
                </button>
              ) : null}
              {memoryStatus ? (
                <small className={`status-chip memory-status status-${memoryStatus.kind}`}>
                  <span className="status-message">{memoryStatus.message}</span>
                </small>
              ) : null}
            </div>
          </div>
        </div>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">⚙</button>
      </header>

      {visibleMessages.length === 0 && (
        <section className="conversation glass-panel" aria-live="polite">
          <div className="empty-copy"><p className="eyebrow">READY WHEN YOU ARE</p><h1>Start a conversation</h1><p>Type a message or use the microphone.</p></div>
        </section>
      )}

      {settings.subtitlesEnabled && subtitle && <div className="subtitle">{subtitle}</div>}

      <MessageComposer
        value={input}
        attachments={pendingAttachments}
        listening={listening}
        running={running}
        sceneReady={Boolean(scene && resourceController)}
        onChange={setInput}
        onFiles={(files) => void attachFiles(files)}
        onRecognizedUrls={(urls) => void attachRecognizedUrls(urls)}
        onRemoveAttachment={removePendingAttachment}
        onMic={() => void onMicButtonClick()}
        onStop={() => {
            continuousRef.current = false;
            if (settings.voiceRoute === "realtime") void stopRealtimeEverything();
            else stopEverything();
          }}
        onSubmit={() => void submitComposerMessage()}
      />

      {settingsOpen ? (
        <Suspense fallback={<div className="settings-loading">Loading settings…</div>}>
          <SettingsPanel open onClose={() => setSettingsOpen(false)}
            onActivateCharacter={onActivateCharacter}
            onCreateConversation={onCreateConversation}
            onDeleteConversation={onDeleteConversation}
            onSelectConversation={onSelectConversation}
            onTestRealtime={testRealtimeConnection}
            developerTools={developerToolRegistry?.manualTools ?? []}
            developerToolsDisabled={!developerToolRegistry}
            onInvokeTool={(name, input) => developerToolRegistry
              ? developerToolRegistry.execute(`developer-${crypto.randomUUID()}`, name, input)
              : Promise.reject(new Error("The Live2D scene is not ready yet."))}
            onTestStt={() => void startListening()}
            onTestTts={() => speechQueueRef.current?.enqueue(
              effectiveTtsSettings.language.toLowerCase().startsWith("zh")
                ? "你好，这是一段语音合成测试。"
                : "Hello, this is a speech synthesis test.",
            )} />
        </Suspense>
      ) : null}
    </main>
  );
}
