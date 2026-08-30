export type ConversationRoute = "classic" | "realtime";

/**
 * Route-neutral controls owned by the application shell. Provider-specific
 * events stay behind the implementation while typing, microphone lifecycle,
 * explicit cancellation and teardown keep identical semantics.
 */
export interface ConversationSession {
  readonly route: ConversationRoute;
  connect(): Promise<void>;
  sendText(text: string): Promise<void>;
  startMicrophone(): Promise<void>;
  stopMicrophone(): Promise<void>;
  cancel(): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface ClassicConversationSessionCallbacks {
  sendText(text: string): Promise<void>;
  startMicrophone(): Promise<void>;
  stopMicrophone(): Promise<void>;
  cancel(): void;
  dispose(): void;
}

/** Thin adapter around the existing STT -> LLM -> TTS route. */
export class ClassicConversationSession implements ConversationSession {
  readonly route = "classic" as const;

  constructor(private readonly callbacks: ClassicConversationSessionCallbacks) {}

  connect(): Promise<void> {
    return Promise.resolve();
  }

  sendText(text: string): Promise<void> {
    return this.callbacks.sendText(text);
  }

  startMicrophone(): Promise<void> {
    return this.callbacks.startMicrophone();
  }

  stopMicrophone(): Promise<void> {
    return this.callbacks.stopMicrophone();
  }

  cancel(): void {
    this.callbacks.cancel();
  }

  dispose(): void {
    this.callbacks.dispose();
  }
}
