import {
  asGoogleLiveSessionError,
  GoogleLiveProtocolError,
  GoogleLiveSessionError,
  redactGoogleLiveCredentials,
} from "./errors";
import {
  buildGoogleLiveAudioInput,
  buildGoogleLiveAudioStreamEnd,
  buildGoogleLiveHistorySeed,
  buildGoogleLiveSetupMessage,
  buildGoogleLiveTextInput,
  buildGoogleLiveToolResponse,
  buildGoogleLiveWebSocketUrl,
  decodePcm16Base64,
  parseGoogleLiveServerMessage,
  type GoogleLiveFunctionCall,
  type GoogleLiveServerMessage,
} from "./protocol";
import {
  GOOGLE_LIVE_OUTPUT_SAMPLE_RATE,
  type GoogleLiveHistoryMessage,
  type GoogleLiveSessionDependencies,
  type GoogleLiveSessionOptions,
  type GoogleLiveWebSocket,
} from "./types";

const RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

interface ActiveConnection {
  id: number;
  socket: GoogleLiveWebSocket;
  resumed: boolean;
  history: readonly GoogleLiveHistoryMessage[];
  setupSent: boolean;
  ready: boolean;
  receiveTail: Promise<void>;
}

interface PendingMessage {
  serialized: string;
  toolCallId?: string;
  onSent?: (connectionId: number) => void;
}

interface ToolCallState {
  id: string;
  name: string;
  fingerprint: string;
  cancelled: boolean;
  responseReady: boolean;
  response?: unknown;
  responseQueued: boolean;
  lastSentConnectionId?: number;
}

export class GoogleLiveSession {
  private readonly options: GoogleLiveSessionOptions;
  private readonly webSocketFactory: NonNullable<GoogleLiveSessionDependencies["webSocketFactory"]>;
  private readonly schedule: NonNullable<GoogleLiveSessionDependencies["schedule"]>;
  private readonly cancelScheduled: NonNullable<GoogleLiveSessionDependencies["cancelScheduled"]>;

  private active?: ActiveConnection;
  private retryTimer?: unknown;
  private retryIndex = 0;
  private nextConnectionId = 0;
  private desiredOpen = false;
  private disposed = false;
  private latestResumeHandle?: string;
  private pendingMessages: PendingMessage[] = [];
  private readonly toolCalls = new Map<string, ToolCallState>();
  private readonly cancelledToolCallIds = new Set<string>();

  private readyPromise?: Promise<void>;
  private resolveReady?: () => void;
  private rejectReady?: (error: GoogleLiveSessionError) => void;

  constructor(
    options: GoogleLiveSessionOptions,
    dependencies: GoogleLiveSessionDependencies = {},
  ) {
    this.options = options;
    this.latestResumeHandle = options.resumeHandle;
    this.webSocketFactory = dependencies.webSocketFactory ?? defaultWebSocketFactory;
    this.schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = dependencies.cancelScheduled ?? ((handle) => clearTimeout(
      handle as ReturnType<typeof setTimeout>,
    ));
  }

  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new GoogleLiveSessionError("DISPOSED", "Google Live session is disposed."));
    }
    if (this.active?.ready) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;

    // Validate synchronously before a retry loop is armed.
    try {
      buildGoogleLiveWebSocketUrl(this.options.apiKey);
    } catch (error) {
      return Promise.reject(asGoogleLiveSessionError(
        error,
        "INVALID_CONFIG",
        "Google Live configuration is invalid",
        this.options.apiKey,
      ));
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    if (!this.desiredOpen) {
      this.desiredOpen = true;
      this.retryIndex = 0;
      this.options.emit({ type: "status", status: "connecting" });
      this.startAttempt();
    }
    return this.readyPromise;
  }

  sendText(text: string): void {
    this.sendProtocolMessage(buildGoogleLiveTextInput(text));
  }

  sendAudio(pcm16: Int16Array): void {
    this.sendProtocolMessage(buildGoogleLiveAudioInput(pcm16));
  }

  endAudio(): void {
    this.sendProtocolMessage(buildGoogleLiveAudioStreamEnd());
  }

  cancel(): void {
    if (this.disposed && !this.desiredOpen && !this.active && !this.retryTimer) return;
    const wasActive = this.desiredOpen || Boolean(this.active) || Boolean(this.retryTimer);
    this.desiredOpen = false;
    this.clearRetryTimer();
    this.pendingMessages = [];
    const active = this.detachActive();
    if (active) {
      try {
        active.socket.close(1000, "cancelled");
      } catch {
        // The connection is already being torn down.
      }
    }
    if (this.rejectReady) {
      this.rejectReady(new GoogleLiveSessionError(
        "CONNECTION_CLOSED",
        "Google Live connection was cancelled.",
      ));
      this.clearReadyPromise();
    }
    if (wasActive) this.options.emit({ type: "status", status: "closed" });
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.toolCalls.clear();
    this.cancelledToolCallIds.clear();
  }

  private startAttempt(): void {
    if (!this.desiredOpen || this.disposed || this.active) return;
    const id = ++this.nextConnectionId;
    const resumed = Boolean(this.latestResumeHandle);
    let history: readonly GoogleLiveHistoryMessage[] = [];
    if (!resumed) {
      try {
        history = (this.options.historyProvider?.() ?? this.options.history ?? [])
          .map((message) => ({ ...message }));
      } catch (error) {
        this.scheduleRetry(asGoogleLiveSessionError(
          error,
          "INVALID_CONFIG",
          "Unable to read Google Live conversation history",
          this.options.apiKey,
          true,
        ));
        return;
      }
    }
    let socket: GoogleLiveWebSocket;
    try {
      socket = this.webSocketFactory(buildGoogleLiveWebSocketUrl(this.options.apiKey));
    } catch (error) {
      this.scheduleRetry(asGoogleLiveSessionError(
        error,
        "CONNECTION_FAILED",
        "Unable to create the Google Live WebSocket",
        this.options.apiKey,
        true,
      ));
      return;
    }

    const active: ActiveConnection = {
      id,
      socket,
      resumed,
      history,
      setupSent: false,
      ready: false,
      receiveTail: Promise.resolve(),
    };
    this.active = active;
    socket.onopen = () => this.handleOpen(active);
    socket.onmessage = (event) => {
      active.receiveTail = active.receiveTail
        .then(() => this.handleFrame(active, event.data))
        .catch((error: unknown) => this.handleFrameError(active, error));
    };
    socket.onerror = (event) => {
      this.failActive(active, asGoogleLiveSessionError(
        event,
        "CONNECTION_FAILED",
        "Google Live WebSocket reported a connection error",
        this.options.apiKey,
        true,
      ));
    };
    socket.onclose = (event) => this.handleClose(active, event);
  }

  private handleOpen(active: ActiveConnection): void {
    if (!this.isCurrent(active)) return;
    try {
      const setup = buildGoogleLiveSetupMessage({
        apiKey: this.options.apiKey,
        modelId: this.options.modelId,
        systemInstruction: this.options.systemInstruction,
        voiceName: this.options.voiceName,
        activityHandling: this.options.activityHandling,
        functionDeclarations: this.options.toolAdapter?.declarations,
        resumeHandle: active.resumed ? this.latestResumeHandle : undefined,
        initialHistory: !active.resumed && active.history.length > 0,
      });
      active.setupSent = true;
      this.sendOnActive(active, {
        serialized: JSON.stringify(setup),
      });
    } catch (error) {
      this.failActive(active, asGoogleLiveSessionError(
        error,
        "SEND_FAILED",
        "Unable to configure the Google Live session",
        this.options.apiKey,
        true,
      ));
    }
  }

  private async handleFrame(active: ActiveConnection, data: unknown): Promise<void> {
    if (!this.isCurrent(active)) return;
    const message = await parseGoogleLiveServerMessage(data);
    if (!active.ready) {
      if (!active.setupSent || !message.setupComplete) {
        throw new GoogleLiveProtocolError(
          "Gemini sent data before acknowledging the Live session setup.",
        );
      }
      if (!active.resumed && active.history.length > 0) {
        this.sendOnActive(active, {
          serialized: JSON.stringify(buildGoogleLiveHistorySeed(active.history)),
        });
      }
      active.ready = true;
      this.retryIndex = 0;
      this.options.emit({ type: "setup-complete", resumed: active.resumed });
      this.options.emit({ type: "status", status: "ready" });
      this.resolveReady?.();
      this.clearReadyPromise();
      this.flushPending(active);
    } else if (message.setupComplete) {
      throw new GoogleLiveProtocolError("Gemini sent setupComplete more than once.");
    }

    this.dispatchServerMessage(active, message);
  }

  private dispatchServerMessage(active: ActiveConnection, message: GoogleLiveServerMessage): void {
    if (message.usageMetadata) {
      this.options.emit({ type: "usage", metadata: message.usageMetadata });
    }
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable && update.newHandle) this.latestResumeHandle = update.newHandle;
      else if (!update.resumable) this.latestResumeHandle = undefined;
      this.options.emit({
        type: "session-resumption",
        resumable: update.resumable,
        handle: update.newHandle,
      });
    }
    if (message.serverContent) this.dispatchServerContent(message.serverContent);
    if (message.toolCalls) {
      for (const call of message.toolCalls) this.handleToolCall(call);
    }
    if (message.toolCallCancellation) {
      this.handleToolCancellation(message.toolCallCancellation);
    }
    if (message.goAway) {
      this.options.emit({ type: "go-away", timeLeft: message.goAway.timeLeft });
      this.reconnectForGoAway(active);
    }
  }

  private dispatchServerContent(
    content: NonNullable<GoogleLiveServerMessage["serverContent"]>,
  ): void {
    for (const part of content.modelTurnParts) {
      if (part.inlineData) {
        const mimeType = part.inlineData.mimeType;
        if (mimeType && !mimeType.toLowerCase().startsWith("audio/pcm")) {
          throw new GoogleLiveProtocolError(`Gemini returned unsupported inline data: ${mimeType}.`);
        }
        this.options.emit({
          type: "audio",
          pcm16: decodePcm16Base64(part.inlineData.data),
          sampleRate: GOOGLE_LIVE_OUTPUT_SAMPLE_RATE,
        });
      }
      if (part.text !== undefined) {
        this.options.emit({ type: "text", text: part.text, thought: part.thought });
      }
    }
    if (content.interimInputTranscription) {
      this.options.emit({
        type: "input-transcript",
        text: content.interimInputTranscription.text,
        interim: true,
        languageCode: content.interimInputTranscription.languageCode,
      });
    }
    if (content.inputTranscription) {
      this.options.emit({
        type: "input-transcript",
        text: content.inputTranscription.text,
        interim: false,
        languageCode: content.inputTranscription.languageCode,
      });
    }
    if (content.outputTranscription) {
      this.options.emit({
        type: "output-transcript",
        text: content.outputTranscription.text,
        languageCode: content.outputTranscription.languageCode,
      });
    }
    if (content.interrupted) this.options.emit({ type: "interrupted" });
    if (content.generationComplete) this.options.emit({ type: "generation-complete" });
    if (content.turnComplete) {
      this.options.toolAdapter?.resetBatch?.();
      this.options.emit({ type: "turn-complete" });
    }
  }

  private handleToolCall(call: GoogleLiveFunctionCall): void {
    if (this.cancelledToolCallIds.has(call.id)) return;
    const fingerprint = `${call.name}:${JSON.stringify(call.args)}`;
    const previous = this.toolCalls.get(call.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        this.emitProtocolError(
          `Gemini reused tool call ID ${call.id} with different arguments.`,
        );
        return;
      }
      this.deliverToolResponse(previous);
      return;
    }

    const state: ToolCallState = {
      id: call.id,
      name: call.name,
      fingerprint,
      cancelled: false,
      responseReady: false,
      responseQueued: false,
    };
    this.toolCalls.set(call.id, state);
    this.options.emit({ type: "tool-call", id: call.id, name: call.name, args: call.args });

    const execution = this.options.toolAdapter
      ? this.options.toolAdapter.execute(call.id, call.name, call.args)
      : Promise.reject(new Error(`No tool adapter is registered for ${call.name}.`));
    void execution
      .then((output) => this.completeToolCall(state, output))
      .catch((error: unknown) => {
        const message = redactGoogleLiveCredentials(
          error instanceof Error ? error.message : "Tool execution failed.",
          this.options.apiKey,
        );
        this.completeToolCall(state, { error: message });
      });
  }

  private completeToolCall(state: ToolCallState, output: unknown): void {
    // Cancellation can race an active or queued executor. The adapter prevents
    // queued scene mutations, while this guard prevents a late active result
    // from being surfaced or returned to Gemini as a completed tool call.
    if (state.cancelled) return;
    state.responseReady = true;
    state.response = output;
    this.options.emit({
      type: "tool-result",
      id: state.id,
      name: state.name,
      output,
    });
    this.deliverToolResponse(state);
  }

  private deliverToolResponse(state: ToolCallState): void {
    if (
      state.cancelled ||
      !state.responseReady ||
      state.responseQueued ||
      !this.desiredOpen ||
      (this.active?.ready && state.lastSentConnectionId === this.active.id)
    ) {
      return;
    }
    state.responseQueued = true;
    try {
      this.sendProtocolMessage(
        buildGoogleLiveToolResponse(state.id, state.name, state.response),
        {
          toolCallId: state.id,
          onSent: (connectionId) => {
            state.responseQueued = false;
            state.lastSentConnectionId = connectionId;
          },
        },
      );
    } catch (error) {
      state.responseQueued = false;
      if (this.desiredOpen) {
        this.options.emit({
          type: "error",
          error: asGoogleLiveSessionError(
            error,
            "SEND_FAILED",
            `Unable to return tool result for ${state.name}`,
            this.options.apiKey,
          ),
        });
      }
    }
  }

  private handleToolCancellation(ids: string[]): void {
    for (const id of ids) {
      this.cancelledToolCallIds.add(id);
      const state = this.toolCalls.get(id);
      if (state) {
        state.cancelled = true;
        state.responseQueued = false;
      }
      this.options.toolAdapter?.cancel?.(id);
    }
    const cancelled = new Set(ids);
    this.pendingMessages = this.pendingMessages.filter(
      (message) => !message.toolCallId || !cancelled.has(message.toolCallId),
    );
    this.options.emit({ type: "tool-cancelled", ids });
  }

  private sendProtocolMessage(
    message: Record<string, unknown>,
    metadata: Omit<PendingMessage, "serialized"> = {},
  ): void {
    if (this.disposed) {
      throw new GoogleLiveSessionError("DISPOSED", "Google Live session is disposed.");
    }
    if (!this.desiredOpen) {
      throw new GoogleLiveSessionError(
        "NOT_CONNECTED",
        "Google Live session must be connected before sending input.",
      );
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(message);
    } catch (error) {
      throw new GoogleLiveProtocolError("Google Live message must be JSON serializable.", {
        cause: error,
      });
    }
    const pending: PendingMessage = { serialized, ...metadata };
    const active = this.active;
    if (!active?.ready) {
      this.pendingMessages.push(pending);
      return;
    }
    try {
      this.sendOnActive(active, pending);
    } catch (error) {
      this.pendingMessages.unshift(pending);
      this.failActive(active, asGoogleLiveSessionError(
        error,
        "SEND_FAILED",
        "Unable to send data to Google Live",
        this.options.apiKey,
        true,
      ));
    }
  }

  private flushPending(active: ActiveConnection): void {
    while (this.isCurrent(active) && active.ready && this.pendingMessages.length > 0) {
      const pending = this.pendingMessages.shift()!;
      try {
        this.sendOnActive(active, pending);
      } catch (error) {
        this.pendingMessages.unshift(pending);
        this.failActive(active, asGoogleLiveSessionError(
          error,
          "SEND_FAILED",
          "Unable to flush queued Google Live data",
          this.options.apiKey,
          true,
        ));
        return;
      }
    }
  }

  private sendOnActive(active: ActiveConnection, message: PendingMessage): void {
    if (!this.isCurrent(active)) {
      throw new GoogleLiveSessionError(
        "NOT_CONNECTED",
        "Google Live WebSocket is no longer active.",
        { retryable: true },
      );
    }
    active.socket.send(message.serialized);
    message.onSent?.(active.id);
  }

  private handleFrameError(active: ActiveConnection, error: unknown): void {
    const protocolError = asGoogleLiveSessionError(
      error,
      "PROTOCOL_ERROR",
      "Unable to process a Google Live message",
      this.options.apiKey,
    );
    if (!active.ready) {
      this.failActive(active, protocolError);
    } else {
      this.options.emit({ type: "error", error: protocolError });
    }
  }

  private handleClose(
    active: ActiveConnection,
    event: { code: number; reason: string; wasClean: boolean },
  ): void {
    if (!this.isCurrent(active)) return;
    this.failActive(active, classifyGoogleLiveClose(event, this.options.apiKey), false);
  }

  private failActive(
    active: ActiveConnection,
    error: GoogleLiveSessionError,
    closeSocket = true,
  ): void {
    if (!this.isCurrent(active)) return;
    this.detachActive();
    if (closeSocket) {
      try {
        active.socket.close(1011, "reconnecting");
      } catch {
        // Ignore errors from a socket that is already closing.
      }
    }
    if (this.desiredOpen && error.retryable) this.scheduleRetry(error);
    else if (this.desiredOpen) {
      this.options.emit({ type: "error", error });
      this.terminateAfterRetries(error);
    }
    else this.options.emit({ type: "status", status: "closed" });
  }

  private reconnectForGoAway(active: ActiveConnection): void {
    if (!this.isCurrent(active) || !this.desiredOpen) return;
    this.detachActive();
    try {
      active.socket.close(1000, "go-away");
    } catch {
      // The server may already be closing the socket.
    }
    this.scheduleRetry();
  }

  private scheduleRetry(cause?: GoogleLiveSessionError): void {
    if (!this.desiredOpen || this.disposed || this.retryTimer) return;
    if (cause) this.options.emit({ type: "error", error: cause });
    if (this.options.autoReconnect === false || this.retryIndex >= RETRY_DELAYS_MS.length) {
      this.terminateAfterRetries(cause);
      return;
    }
    const delayMs = RETRY_DELAYS_MS[this.retryIndex]!;
    const attempt = this.retryIndex + 1;
    this.retryIndex += 1;
    this.options.emit({
      type: "status",
      status: "reconnecting",
      attempt,
      retryInMs: delayMs,
    });
    this.retryTimer = this.schedule(() => {
      this.retryTimer = undefined;
      this.startAttempt();
    }, delayMs);
  }

  private terminateAfterRetries(cause?: GoogleLiveSessionError): void {
    this.desiredOpen = false;
    const error = new GoogleLiveSessionError(
      cause && !cause.retryable
        ? cause.code
        : cause?.code === "PROTOCOL_ERROR" ? "PROTOCOL_ERROR" : "CONNECTION_FAILED",
      cause?.message ?? "Google Live connection failed after three retries.",
      { retryable: false },
    );
    if (!cause) this.options.emit({ type: "error", error });
    this.rejectReady?.(error);
    this.clearReadyPromise();
    this.options.emit({ type: "status", status: "closed" });
  }

  private emitProtocolError(message: string): void {
    this.options.emit({ type: "error", error: new GoogleLiveProtocolError(message) });
  }

  private detachActive(): ActiveConnection | undefined {
    const active = this.active;
    if (!active) return undefined;
    active.socket.onopen = null;
    active.socket.onmessage = null;
    active.socket.onerror = null;
    active.socket.onclose = null;
    this.active = undefined;
    return active;
  }

  private isCurrent(active: ActiveConnection): boolean {
    return this.active === active;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    this.cancelScheduled(this.retryTimer);
    this.retryTimer = undefined;
  }

  private clearReadyPromise(): void {
    this.readyPromise = undefined;
    this.resolveReady = undefined;
    this.rejectReady = undefined;
  }
}

function defaultWebSocketFactory(url: string): GoogleLiveWebSocket {
  return new WebSocket(url) as unknown as GoogleLiveWebSocket;
}

function classifyGoogleLiveClose(
  event: { code: number; reason: string; wasClean: boolean },
  apiKey: string,
): GoogleLiveSessionError {
  const rawReason = event.reason;
  const safeReason = redactGoogleLiveCredentials(rawReason, apiKey);
  if (/api.?key|unauthenticated|permission.?denied|\b(?:401|403)\b/i.test(rawReason)) {
    return new GoogleLiveSessionError(
      "AUTHENTICATION_FAILED",
      "Google rejected the Gemini API key or its permissions.",
    );
  }
  if (/quota|resource.?exhausted|rate.?limit|\b429\b/i.test(rawReason)) {
    return new GoogleLiveSessionError(
      "QUOTA_EXCEEDED",
      "Google Gemini Live quota or rate limit was exceeded.",
    );
  }
  if (/model.*(?:not.?found|unsupported|unavailable)|(?:not.?found|unsupported).*model|\b404\b/i.test(rawReason)) {
    return new GoogleLiveSessionError(
      "MODEL_UNAVAILABLE",
      "The configured Google Gemini Live model is unavailable.",
    );
  }
  const detail = safeReason ? ` (${safeReason})` : "";
  return new GoogleLiveSessionError(
    event.code === 1006 ? "NETWORK_ERROR" : "CONNECTION_CLOSED",
    `Google Live WebSocket closed with code ${event.code}${detail}.`,
    { retryable: true },
  );
}
