export interface RecognitionCallbacks {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onStatus(status: "idle" | "listening" | "processing"): void;
  onError(error: Error): void;
  // Fired when the recognition session ended on its own (no-speech timeout,
  // empty-final noise, etc.) — as opposed to the user explicitly stopping it.
  // The host can use this to reopen the session in continuous mode without
  // having to guess whether Chrome is still alive.
  onAutoEnd?(): void;
}

export interface SpeechRecognitionProvider {
  readonly id: string;
  isSupported(): boolean;
  start(callbacks: RecognitionCallbacks): Promise<void>;
  stop(): Promise<void>;
  abort(): void;
}
