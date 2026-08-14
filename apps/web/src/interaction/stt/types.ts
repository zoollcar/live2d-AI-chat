export interface RecognitionCallbacks {
  onInterim(text: string): void;
  onFinal(text: string): void;
  onStatus(status: "idle" | "listening" | "processing"): void;
  onError(error: Error): void;
}

export interface SpeechRecognitionProvider {
  readonly id: string;
  isSupported(): boolean;
  start(callbacks: RecognitionCallbacks): Promise<void>;
  stop(): Promise<void>;
  abort(): void;
}
