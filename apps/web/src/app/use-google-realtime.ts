import { useCallback, useEffect, useRef } from "react";
import type { ChatMessage, ToolCallRecord } from "@/agent";
import type {
  AgentNetworkAccess,
  AgentResourceAccess,
  AgentToolCapabilities,
  AgentWorkspaceAccess,
} from "@/agent/tool-context";
import { buildAgentStatus, prefixAgentStatus } from "@/agent/status-context";
import { createSystemMessage } from "@/agent/system-prompt";
import { useConversationStore } from "@/infrastructure/conversation/store";
import type { ConversationSession } from "@/interaction/conversation-session";
import {
  appendGoogleLiveTranscript,
  createGoogleLiveTurnState,
  createGoogleLiveSceneToolAdapter,
  GoogleLiveSession,
  reduceGoogleLiveTurn,
  type GoogleLiveSessionEvent,
  type GoogleLiveTurnState,
} from "@/interaction/realtime";
import { RealtimeAudioEngine } from "@/interaction/realtime/realtime-audio-engine";
import type { CharacterProfile } from "@/model/character-profile";
import type { Conversation } from "@/model/conversation";
import { buildRealtimeInitialHistory } from "@/model/conversation-compaction";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { ArtifactRef, RealtimeSettings, ResourceRef, VoiceInteractionSettings } from "@live2d-chat/shared";

type UiStatusKind = "idle" | "busy" | "error";

interface GoogleRealtimeUiCallbacks {
  setListening(value: boolean): void;
  setRunning(value: boolean): void;
  setSubtitle(value: string): void;
  setStatus(kind: UiStatusKind, message: string): void;
  openSettings(): void;
}

interface UseGoogleRealtimeOptions {
  enabled: boolean;
  scene?: SceneController;
  profile: CharacterProfile;
  conversation?: Conversation;
  settings: RealtimeSettings;
  interaction: VoiceInteractionSettings;
  resources?: AgentResourceAccess;
  workspace?: AgentWorkspaceAccess;
  network?: AgentNetworkAccess;
  toolCapabilities?: Partial<AgentToolCapabilities>;
  callbacks: GoogleRealtimeUiCallbacks;
}

interface ActiveTurn {
  conversationId: string;
  userIndex: number;
  assistantIndex: number;
  inputMode: "text" | "voice";
  userText: string;
  assistantText: string;
  fallbackText: string;
  responseStarted: boolean;
  interrupted: boolean;
}

interface PendingVoiceInput {
  finalText: string;
  interimText: string;
  /** Spoken activity captured while a typed assistant turn is still open. */
  bargeIn: boolean;
}

function artifactRefFromToolOutput(output: unknown): ArtifactRef | undefined {
  if (!output || typeof output !== "object") return undefined;
  const value = output as Partial<ArtifactRef>;
  if (typeof value.id !== "string" || typeof value.resourceId !== "string") return undefined;
  if (value.kind !== "resource-view" && value.kind !== "svg-drawing" && value.kind !== "sticker") return undefined;
  return { id: value.id, resourceId: value.resourceId, kind: value.kind };
}

export interface GoogleRealtimeControls extends ConversationSession {
  readonly route: "realtime";
  sendText(text: string, attachments?: readonly ResourceRef[], runtimeText?: string): Promise<void>;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  stopEverything(): Promise<void>;
  testConnection(): Promise<void>;
}

/**
 * Owns the persistent Gemini Live session while leaving durable conversation
 * storage in the existing Zustand/IndexedDB path. All callbacks are guarded by
 * a generation id so a disposed session cannot mutate a newly selected chat.
 */
export function useGoogleRealtime(options: UseGoogleRealtimeOptions): GoogleRealtimeControls {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef<GoogleLiveSession | undefined>(undefined);
  const audioRef = useRef<RealtimeAudioEngine | undefined>(undefined);
  const generationRef = useRef(0);
  const resumeHandleRef = useRef<string | undefined>(undefined);
  const turnRef = useRef<ActiveTurn | undefined>(undefined);
  const toolTurnRefs = useRef(new Map<string, ActiveTurn>());
  const pendingVoiceRef = useRef<PendingVoiceInput>({ finalText: "", interimText: "", bargeIn: false });
  const reducedTurnRef = useRef<GoogleLiveTurnState>(createGoogleLiveTurnState());
  const actualListeningRef = useRef(false);
  const inputStartingRef = useRef(false);
  const inputCaptureRequestRef = useRef(0);
  const microphoneRequestRef = useRef(0);
  const microphoneWantedRef = useRef(false);
  const inputGatedRef = useRef(false);
  const runningRef = useRef(false);
  const turnCompleteRef = useRef(false);
  const lastConnectionErrorRef = useRef<Error | undefined>(undefined);

  const patchTurnMessages = useCallback((turn: ActiveTurn, updater: (
    user: ChatMessage,
    assistant: ChatMessage,
  ) => { user?: ChatMessage; assistant?: ChatMessage }) => {
    if (useConversationStore.getState().activeConversationId !== turn.conversationId) return;
    useConversationStore.getState().updateMessages((messages) => {
      const user = messages[turn.userIndex];
      const assistant = messages[turn.assistantIndex];
      if (user?.role !== "user" || assistant?.role !== "assistant") return messages;
      const patch = updater(user, assistant);
      if (!patch.user && !patch.assistant) return messages;
      const next = [...messages];
      if (patch.user) next[turn.userIndex] = patch.user;
      if (patch.assistant) next[turn.assistantIndex] = patch.assistant;
      return next;
    });
  }, []);

  const startTurn = useCallback((
    inputMode: "text" | "voice",
    text: string,
    attachments?: readonly ResourceRef[],
  ): ActiveTurn | undefined => {
    const state = useConversationStore.getState();
    const conversationId = state.activeConversationId;
    if (!conversationId) return undefined;
    let userIndex = -1;
    let assistantIndex = -1;
    state.updateMessages((messages) => {
      userIndex = messages.length;
      assistantIndex = messages.length + 1;
      return [
        ...messages,
        {
          role: "user",
          content: text,
          inputMode,
          ...(attachments?.length ? { attachments: [...attachments] } : {}),
          ...(inputMode === "voice" && !text ? { transcriptUnavailable: true } : {}),
        },
        { role: "assistant", content: "" },
      ];
    });
    const turn: ActiveTurn = {
      conversationId,
      userIndex,
      assistantIndex,
      inputMode,
      userText: text,
      assistantText: "",
      fallbackText: "",
      responseStarted: false,
      interrupted: false,
    };
    turnRef.current = turn;
    turnCompleteRef.current = false;
    return turn;
  }, []);

  const updateTurnUserText = useCallback((turn: ActiveTurn, text: string) => {
    turn.userText = text;
    patchTurnMessages(turn, (user) => ({
      user: {
        ...user,
        content: text,
        transcriptUnavailable: !text || undefined,
      },
    }));
  }, [patchTurnMessages]);

  const ensureTurnForResponse = useCallback((): ActiveTurn | undefined => {
    if (turnRef.current) return turnRef.current;
    const pending = pendingVoiceRef.current.finalText
      || reducedTurnRef.current.inputTranscript
      || pendingVoiceRef.current.interimText
      || reducedTurnRef.current.interimInputTranscript;
    pendingVoiceRef.current = { finalText: "", interimText: "", bargeIn: false };
    return startTurn("voice", pending);
  }, [startTurn]);

  const finishTurn = useCallback((interrupted = false) => {
    const turn = turnRef.current;
    if (!turn) return;
    turn.interrupted ||= interrupted;
    patchTurnMessages(turn, (user, assistant) => ({
      user: {
        ...user,
        content: turn.userText,
        transcriptUnavailable: turn.inputMode === "voice" && !turn.userText || undefined,
      },
      assistant: {
        ...assistant,
        content: turn.assistantText || turn.fallbackText,
        interrupted: turn.interrupted || undefined,
      },
    }));
    turnRef.current = undefined;
    void useConversationStore.getState().flushActive();
  }, [patchTurnMessages]);

  const setActualListening = useCallback((value: boolean) => {
    actualListeningRef.current = value;
    optionsRef.current.callbacks.setListening(value);
  }, []);

  const setRunning = useCallback((value: boolean) => {
    runningRef.current = value;
    optionsRef.current.callbacks.setRunning(value);
  }, []);

  const startInputCapture = useCallback(async (generation: number) => {
    const audio = audioRef.current;
    const session = sessionRef.current;
    if (!audio || !session || generation !== generationRef.current) return;
    const request = ++inputCaptureRequestRef.current;
    inputStartingRef.current = true;
    try {
      await audio.startInput((pcm16) => {
        if (generation !== generationRef.current || sessionRef.current !== session) return;
        if (runningRef.current && !optionsRef.current.interaction.allowVoiceInterruption) return;
        try {
          session.sendAudio(pcm16);
        } catch (error) {
          optionsRef.current.callbacks.setStatus(
            "error",
            `Realtime audio send failed: ${error instanceof Error ? error.message : "Unknown error"}`,
          );
        }
      });
    } catch (error) {
      if (request === inputCaptureRequestRef.current) inputStartingRef.current = false;
      if (
        request !== inputCaptureRequestRef.current
        || generation !== generationRef.current
        || !microphoneWantedRef.current
      ) return;
      throw error;
    }
    if (request === inputCaptureRequestRef.current) inputStartingRef.current = false;
    if (
      request === inputCaptureRequestRef.current
      && generation === generationRef.current
      && microphoneWantedRef.current
      && !inputGatedRef.current
    ) {
      setActualListening(true);
      optionsRef.current.callbacks.setStatus("busy", "Listening");
    }
  }, [setActualListening]);

  const maybeResumeInput = useCallback(async (generation: number) => {
    if (generation !== generationRef.current || !inputGatedRef.current || !microphoneWantedRef.current) return;
    inputGatedRef.current = false;
    try {
      await startInputCapture(generation);
    } catch (error) {
      microphoneWantedRef.current = false;
      inputGatedRef.current = false;
      setActualListening(false);
      optionsRef.current.callbacks.setStatus(
        "error",
        `Microphone error: ${error instanceof Error ? error.message : "Unavailable"}`,
      );
    }
  }, [setActualListening, startInputCapture]);

  const maybeFinishAudibleTurn = useCallback((generation: number) => {
    if (generation !== generationRef.current || !turnCompleteRef.current || !audioRef.current?.isOutputIdle()) return;
    turnCompleteRef.current = false;
    if (!optionsRef.current.interaction.handsFree && (
      microphoneWantedRef.current
      || inputStartingRef.current
      || actualListeningRef.current
    )) {
      inputCaptureRequestRef.current += 1;
      inputStartingRef.current = false;
      microphoneRequestRef.current += 1;
      microphoneWantedRef.current = false;
      inputGatedRef.current = false;
      audioRef.current.stopInput();
      try { sessionRef.current?.endAudio(); } catch { /* The stream already ended. */ }
      setActualListening(false);
    }
    setRunning(false);
    optionsRef.current.scene?.endStreamingSpeech();
    optionsRef.current.callbacks.setStatus("idle", "Ready");
    void maybeResumeInput(generation);
  }, [maybeResumeInput, setActualListening, setRunning]);

  const gateInputForOutput = useCallback((generation: number) => {
    const { interaction } = optionsRef.current;
    if (
      (!actualListeningRef.current && !inputStartingRef.current)
      || interaction.allowVoiceInterruption
    ) return;
    inputCaptureRequestRef.current += 1;
    inputStartingRef.current = false;
    audioRef.current?.stopInput();
    try { sessionRef.current?.endAudio(); } catch { /* A reconnect will re-open the stream. */ }
    setActualListening(false);
    if (interaction.handsFree) inputGatedRef.current = true;
    else {
      microphoneRequestRef.current += 1;
      microphoneWantedRef.current = false;
    }
    if (generation !== generationRef.current) inputGatedRef.current = false;
  }, [setActualListening]);

  const handleSessionEvent = useCallback((generation: number, event: GoogleLiveSessionEvent) => {
    if (generation !== generationRef.current) return;
    const current = optionsRef.current;
    if (event.type === "status") {
      if (event.status === "connecting") current.callbacks.setStatus("busy", "Connecting to Realtime provider");
      else if (event.status === "reconnecting") {
        current.callbacks.setStatus("busy", `Realtime reconnecting in ${event.retryInMs ?? 0} ms`);
      } else if (event.status === "ready") {
        lastConnectionErrorRef.current = undefined;
        if (!runningRef.current && !actualListeningRef.current) current.callbacks.setStatus("idle", "Realtime ready");
      } else {
        const terminalError = lastConnectionErrorRef.current;
        inputCaptureRequestRef.current += 1;
        inputStartingRef.current = false;
        microphoneRequestRef.current += 1;
        microphoneWantedRef.current = false;
        inputGatedRef.current = false;
        turnCompleteRef.current = false;
        pendingVoiceRef.current = { finalText: "", interimText: "", bargeIn: false };
        reducedTurnRef.current = createGoogleLiveTurnState();
        audioRef.current?.stopInput();
        finishTurn(true);
        audioRef.current?.clearOutput();
        current.scene?.endStreamingSpeech();
        setRunning(false);
        setActualListening(false);
        current.callbacks.setStatus(
          "error",
          terminalError?.message ?? "Realtime connection closed.",
        );
      }
      return;
    }
    if (event.type === "session-resumption") {
      if (event.resumable && event.handle) resumeHandleRef.current = event.handle;
      else if (!event.resumable) resumeHandleRef.current = undefined;
      return;
    }
    if (event.type === "setup-complete") {
      // A fresh retry has no server-side continuation for the in-flight turn.
      // Dynamic history already seeds the latest durable local snapshot, so
      // close the partial turn locally instead of replaying its input and
      // risking a duplicate model reply or repeated scene side effect.
      if (!event.resumed && turnRef.current) {
        turnRef.current.interrupted = true;
        finishTurn(true);
        reducedTurnRef.current = createGoogleLiveTurnState();
        turnCompleteRef.current = true;
        audioRef.current?.clearOutput();
        current.scene?.endStreamingSpeech();
        maybeFinishAudibleTurn(generation);
      }
      return;
    }
    if (event.type === "input-transcript") {
      const turn = turnRef.current;
      // A typed turn cannot own microphone transcription; it is an explicit
      // spoken barge-in for the next turn. Voice turns, however, must accept
      // late input transcription even after output starts because Gemini does
      // not order input transcription relative to model output.
      const belongsToNextTurn = turn?.inputMode === "text";
      if (event.interim) {
        if (belongsToNextTurn) {
          pendingVoiceRef.current.interimText = event.text;
          pendingVoiceRef.current.bargeIn = true;
        } else if (!turn) {
          // A new interim signal is stronger evidence of fresh activity than a
          // final transcript delivered late after the previous turnComplete.
          pendingVoiceRef.current = { finalText: "", interimText: event.text, bargeIn: false };
          reducedTurnRef.current = createGoogleLiveTurnState();
          current.callbacks.setSubtitle(event.text);
        } else {
          reducedTurnRef.current = reduceGoogleLiveTurn(reducedTurnRef.current, event).state;
          if (!turn?.responseStarted) current.callbacks.setSubtitle(event.text);
        }
        return;
      }
      if (belongsToNextTurn) {
        pendingVoiceRef.current.finalText = appendGoogleLiveTranscript(
          pendingVoiceRef.current.finalText,
          event.text,
        );
        pendingVoiceRef.current.interimText = "";
        pendingVoiceRef.current.bargeIn = true;
        current.callbacks.setSubtitle(pendingVoiceRef.current.finalText);
        return;
      }
      reducedTurnRef.current = reduceGoogleLiveTurn(reducedTurnRef.current, event).state;
      if (!turn) {
        // Input transcription has no ordering guarantee relative to
        // turnComplete. Hold it until output/tool/audio proves a new model
        // turn exists, avoiding a durable ghost turn from a late transcript.
        pendingVoiceRef.current.finalText = reducedTurnRef.current.inputTranscript;
        pendingVoiceRef.current.interimText = "";
        pendingVoiceRef.current.bargeIn = false;
        current.callbacks.setSubtitle(pendingVoiceRef.current.finalText);
        return;
      }
      const active = turn;
      if (!active) return;
      updateTurnUserText(active, reducedTurnRef.current.inputTranscript);
      if (!active.responseStarted) {
        current.callbacks.setSubtitle(active.userText);
        setRunning(true);
        current.callbacks.setStatus("busy", "AI is thinking");
      }
      return;
    }
    if (event.type === "output-transcript") {
      reducedTurnRef.current = reduceGoogleLiveTurn(reducedTurnRef.current, event).state;
      const turn = ensureTurnForResponse();
      if (!turn) return;
      turn.responseStarted = true;
      turn.assistantText = reducedTurnRef.current.outputTranscript;
      patchTurnMessages(turn, (_user, assistant) => ({
        assistant: { ...assistant, content: turn.assistantText },
      }));
      current.callbacks.setSubtitle(turn.assistantText);
      setRunning(true);
      current.callbacks.setStatus("busy", "AI is speaking");
      gateInputForOutput(generation);
      return;
    }
    if (event.type === "text") {
      if (event.thought) return;
      const turn = ensureTurnForResponse();
      if (!turn) return;
      turn.responseStarted = true;
      turn.fallbackText = appendGoogleLiveTranscript(turn.fallbackText, event.text);
      return;
    }
    if (event.type === "audio") {
      const turn = ensureTurnForResponse();
      if (turn) turn.responseStarted = true;
      setRunning(true);
      current.callbacks.setStatus("busy", "AI is speaking");
      current.scene?.beginStreamingSpeech();
      audioRef.current?.enqueueOutput(event.pcm16);
      gateInputForOutput(generation);
      return;
    }
    if (event.type === "tool-call") {
      const turn = ensureTurnForResponse();
      if (!turn) return;
      turn.responseStarted = true;
      toolTurnRefs.current.set(event.id, turn);
      current.callbacks.setStatus("busy", `Running tool: ${event.name}`);
      patchTurnMessages(turn, (_user, assistant) => ({
        assistant: {
          ...assistant,
          toolCalls: [...(assistant.toolCalls ?? []), {
            callId: event.id,
            name: event.name,
            input: event.args,
          }],
        },
      }));
      return;
    }
    if (event.type === "tool-result") {
      const turn = toolTurnRefs.current.get(event.id) ?? turnRef.current;
      if (!turn) return;
      const artifact = artifactRefFromToolOutput(event.output);
      patchTurnMessages(turn, (_user, assistant) => ({
        assistant: {
          ...assistant,
          toolCalls: assistant.toolCalls?.map((call) =>
            call.callId === event.id ? { ...call, output: event.output } : call),
          ...(artifact ? { artifacts: [...(assistant.artifacts ?? []), artifact] } : {}),
        },
      }));
      toolTurnRefs.current.delete(event.id);
      return;
    }
    if (event.type === "tool-cancelled") {
      for (const id of event.ids) {
        const turn = toolTurnRefs.current.get(id) ?? turnRef.current;
        if (!turn) continue;
        patchTurnMessages(turn, (_user, assistant) => ({
          assistant: {
            ...assistant,
            toolCalls: assistant.toolCalls?.map((call): ToolCallRecord =>
              call.callId === id ? { ...call, canceled: true } : call),
          },
        }));
        toolTurnRefs.current.delete(id);
      }
      return;
    }
    if (event.type === "interrupted") {
      reducedTurnRef.current = reduceGoogleLiveTurn(reducedTurnRef.current, event).state;
      const turn = turnRef.current;
      if (turn) {
        turn.interrupted = true;
        patchTurnMessages(turn, (_user, assistant) => ({
          assistant: { ...assistant, interrupted: true },
        }));
      }
      audioRef.current?.clearOutput();
      current.scene?.endStreamingSpeech();
      current.callbacks.setStatus("busy", "Reply interrupted");
      return;
    }
    if (event.type === "generation-complete") {
      reducedTurnRef.current = reduceGoogleLiveTurn(reducedTurnRef.current, event).state;
      return;
    }
    if (event.type === "turn-complete") {
      const reduction = reduceGoogleLiveTurn(reducedTurnRef.current, event);
      reducedTurnRef.current = reduction.state;
      const turn = turnRef.current;
      if (turn && reduction.completed) {
        if (turn.inputMode === "voice" && reduction.completed.inputTranscript) {
          updateTurnUserText(turn, reduction.completed.inputTranscript);
        }
        if (reduction.completed.outputTranscript) {
          turn.assistantText = reduction.completed.outputTranscript;
        }
        turn.interrupted ||= reduction.completed.interrupted;
      }
      finishTurn(Boolean(turn?.interrupted));
      const pending = pendingVoiceRef.current;
      const pendingText = pending.finalText || pending.interimText;
      pendingVoiceRef.current = { finalText: "", interimText: "", bargeIn: false };
      if (pendingText && pending.bargeIn) {
        startTurn("voice", pendingText);
        setRunning(true);
        current.callbacks.setStatus("busy", "AI is thinking");
        return;
      }
      turnCompleteRef.current = true;
      maybeFinishAudibleTurn(generation);
      return;
    }
    if (event.type === "error") {
      lastConnectionErrorRef.current = event.error;
      if (event.error.retryable) current.callbacks.setStatus("busy", "Realtime connection interrupted; reconnecting");
      else current.callbacks.setStatus("error", event.error.message);
    }
  }, [
    ensureTurnForResponse,
    finishTurn,
    gateInputForOutput,
    maybeFinishAudibleTurn,
    patchTurnMessages,
    setActualListening,
    setRunning,
    startTurn,
    updateTurnUserText,
  ]);

  const ensureSession = useCallback(async (): Promise<{ session: GoogleLiveSession; generation: number }> => {
    const current = optionsRef.current;
    if (!current.enabled) throw new Error("Realtime voice is not selected.");
    if (!current.scene || !current.conversation) throw new Error("The Live2D scene and conversation are not ready.");
    if (!current.settings.google.apiKey.trim()) {
      current.callbacks.setStatus("error", "Add the provider API key in Realtime settings");
      current.callbacks.openSettings();
      throw new Error("A provider API key is required for Realtime voice.");
    }
    if (sessionRef.current) {
      await sessionRef.current.connect();
      return { session: sessionRef.current, generation: generationRef.current };
    }

    // Store writes are synchronous, while the conversation prop updates on the
    // next React render. A typed interruption can dispose and recreate the
    // session in one callback, so seed from the current Zustand snapshot to
    // retain the just-persisted partial/interrupted turn.
    const conversation = useConversationStore.getState().conversations.find(
      (item) => item.id === current.conversation!.id,
    ) ?? current.conversation;
    const generation = ++generationRef.current;
    const summary = conversation.summary?.content
      ? `\n\n<conversation_summary>\n${conversation.summary.content}\n</conversation_summary>`
      : "";
    const systemInstruction = `${createSystemMessage(current.profile).content}${summary}\n\n${buildAgentStatus(current.scene.snapshot())}`;
    const toolAdapter = createGoogleLiveSceneToolAdapter(current.scene, () => undefined, {
      resources: current.resources,
      workspace: current.workspace,
      network: current.network,
      capabilities: current.toolCapabilities,
      enabledTools: current.profile.enabledTools,
    });
    const conversationId = conversation.id;
    const session = new GoogleLiveSession({
      apiKey: current.settings.google.apiKey,
      modelId: current.settings.google.modelId,
      voiceName: current.settings.google.voiceName,
      activityHandling: current.interaction.allowVoiceInterruption
        ? "START_OF_ACTIVITY_INTERRUPTS"
        : "NO_INTERRUPTION",
      systemInstruction,
      historyProvider: () => {
        const latest = useConversationStore.getState().conversations.find(
          (item) => item.id === conversationId,
        ) ?? conversation;
        return buildRealtimeInitialHistory(latest);
      },
      resumeHandle: resumeHandleRef.current,
      toolAdapter,
      autoReconnect: true,
      emit: (event) => handleSessionEvent(generation, event),
    });
    const audio = new RealtimeAudioEngine({
      onOutputLevel: (level) => {
        if (generation === generationRef.current) current.scene?.setStreamingSpeechLevel(level);
      },
      onOutputIdle: () => {
        if (generation !== generationRef.current) return;
        current.scene?.endStreamingSpeech();
        maybeFinishAudibleTurn(generation);
      },
    });
    sessionRef.current = session;
    audioRef.current = audio;
    try {
      await session.connect();
      return { session, generation };
    } catch (error) {
      session.dispose();
      sessionRef.current = undefined;
      await audio.dispose();
      audioRef.current = undefined;
      throw error;
    }
  }, [handleSessionEvent, maybeFinishAudibleTurn]);

  const disposeCurrent = useCallback(async (markInterrupted: boolean) => {
    const generation = ++generationRef.current;
    const session = sessionRef.current;
    const audio = audioRef.current;
    sessionRef.current = undefined;
    audioRef.current = undefined;
    if (markInterrupted) finishTurn(true);
    else turnRef.current = undefined;
    pendingVoiceRef.current = { finalText: "", interimText: "", bargeIn: false };
    toolTurnRefs.current.clear();
    reducedTurnRef.current = createGoogleLiveTurnState();
    resumeHandleRef.current = undefined;
    inputCaptureRequestRef.current += 1;
    inputStartingRef.current = false;
    microphoneRequestRef.current += 1;
    microphoneWantedRef.current = false;
    inputGatedRef.current = false;
    turnCompleteRef.current = false;
    lastConnectionErrorRef.current = undefined;
    setActualListening(false);
    setRunning(false);
    optionsRef.current.scene?.endStreamingSpeech();
    session?.dispose();
    if (audio) await audio.dispose();
    if (generation === generationRef.current) void useConversationStore.getState().flushActive();
  }, [finishTurn, setActualListening, setRunning]);

  const sendText = useCallback(async (
    rawText: string,
    attachments: readonly ResourceRef[] = [],
    runtimeText?: string,
  ) => {
    const text = rawText.trim();
    if (!text && attachments.length === 0) return;
    if (runningRef.current || turnRef.current) await disposeCurrent(true);
    reducedTurnRef.current = createGoogleLiveTurnState();
    // ensureSession constructs the audio engine synchronously before awaiting
    // WebSocket setup. Resume it immediately while the submit click still
    // carries browser user activation, then wait for setupComplete.
    const connection = ensureSession();
    await audioRef.current?.resume();
    const { session, generation } = await connection;
    const turn = startTurn("text", text, attachments);
    if (!turn || generation !== generationRef.current) return;
    setRunning(true);
    optionsRef.current.callbacks.setSubtitle(text);
    optionsRef.current.callbacks.setStatus("busy", "AI is thinking");
    try {
      session.sendText(prefixAgentStatus(runtimeText?.trim() || text, optionsRef.current.scene!.snapshot()));
    } catch (error) {
      finishTurn(true);
      setRunning(false);
      optionsRef.current.callbacks.setStatus(
        "error",
        `Realtime send failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }, [disposeCurrent, ensureSession, finishTurn, setRunning, startTurn]);

  const startListening = useCallback(async () => {
    if (runningRef.current && !optionsRef.current.interaction.allowVoiceInterruption) {
      optionsRef.current.callbacks.setStatus("busy", "Voice interruptions are disabled; use Stop to cancel the reply");
      return;
    }
    const request = ++microphoneRequestRef.current;
    inputGatedRef.current = false;
    microphoneWantedRef.current = true;
    try {
      const connection = ensureSession();
      await audioRef.current?.resume();
      const { generation } = await connection;
      if (
        request !== microphoneRequestRef.current
        || !microphoneWantedRef.current
        || inputGatedRef.current
      ) return;
      await startInputCapture(generation);
    } catch (error) {
      if (request !== microphoneRequestRef.current || !microphoneWantedRef.current) return;
      microphoneWantedRef.current = false;
      setActualListening(false);
      optionsRef.current.callbacks.setStatus(
        "error",
        `Microphone error: ${error instanceof Error ? error.message : "Unavailable"}`,
      );
      throw error;
    }
  }, [ensureSession, setActualListening, startInputCapture]);

  const stopListening = useCallback(async () => {
    inputCaptureRequestRef.current += 1;
    inputStartingRef.current = false;
    microphoneRequestRef.current += 1;
    microphoneWantedRef.current = false;
    inputGatedRef.current = false;
    audioRef.current?.stopInput();
    try { sessionRef.current?.endAudio(); } catch { /* The session may already be reconnecting. */ }
    setActualListening(false);
    if (!runningRef.current) optionsRef.current.callbacks.setStatus("idle", "Realtime ready");
  }, [setActualListening]);

  const stopEverything = useCallback(async () => {
    await disposeCurrent(true);
    optionsRef.current.callbacks.setStatus("idle", "Ready");
  }, [disposeCurrent]);

  const dispose = useCallback(async () => {
    await disposeCurrent(true);
  }, [disposeCurrent]);

  const testConnection = useCallback(async () => {
    const current = optionsRef.current;
    if (!current.settings.google.apiKey.trim()) throw new Error("A Google Gemini API key is required.");
    const session = new GoogleLiveSession({
      apiKey: current.settings.google.apiKey,
      modelId: current.settings.google.modelId,
      voiceName: current.settings.google.voiceName,
      activityHandling: current.interaction.allowVoiceInterruption
        ? "START_OF_ACTIVITY_INTERRUPTS"
        : "NO_INTERRUPTION",
      autoReconnect: false,
      emit: () => undefined,
    });
    try {
      await session.connect();
    } finally {
      session.dispose();
    }
  }, []);

  const connect = useCallback(async () => {
    await ensureSession();
  }, [ensureSession]);

  useEffect(() => () => {
    void disposeCurrent(true);
  }, [
    disposeCurrent,
    options.enabled,
    options.scene,
    options.profile.id,
    options.conversation?.id,
    options.settings.google.apiKey,
    options.settings.google.modelId,
    options.settings.google.voiceName,
    options.interaction.allowVoiceInterruption,
  ]);

  return {
    route: "realtime",
    connect,
    sendText,
    startMicrophone: startListening,
    stopMicrophone: stopListening,
    cancel: stopEverything,
    dispose,
    startListening,
    stopListening,
    stopEverything,
    testConnection,
  };
}
