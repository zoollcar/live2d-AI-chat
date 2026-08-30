import type { GoogleLiveSessionError } from "./errors";

export const GOOGLE_LIVE_MODEL_ID = "gemini-3.1-flash-live-preview";
export const GOOGLE_LIVE_DEFAULT_VOICE = "Kore";
export const GOOGLE_LIVE_INPUT_SAMPLE_RATE = 16_000;
export const GOOGLE_LIVE_OUTPUT_SAMPLE_RATE = 24_000;

export type GoogleLiveActivityHandling =
  | "START_OF_ACTIVITY_INTERRUPTS"
  | "NO_INTERRUPTION";

export interface GoogleLiveHistoryMessage {
  role: "user" | "model" | "assistant";
  text: string;
}

export interface GoogleLiveFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GoogleLiveToolAdapter {
  declarations: GoogleLiveFunctionDeclaration[];
  execute(callId: string, name: string, args: unknown): Promise<unknown>;
  cancel?(callId: string): void;
  resetBatch?(): void;
}

export type GoogleLiveConnectionStatus =
  | "connecting"
  | "reconnecting"
  | "ready"
  | "closed";

export type GoogleLiveSessionEvent =
  | {
      type: "status";
      status: GoogleLiveConnectionStatus;
      attempt?: number;
      retryInMs?: number;
    }
  | { type: "setup-complete"; resumed: boolean }
  | {
      type: "input-transcript";
      text: string;
      interim: boolean;
      languageCode?: string;
    }
  | { type: "output-transcript"; text: string; languageCode?: string }
  | {
      type: "audio";
      pcm16: Int16Array;
      sampleRate: typeof GOOGLE_LIVE_OUTPUT_SAMPLE_RATE;
    }
  | { type: "text"; text: string; thought?: boolean }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; output: unknown }
  | { type: "tool-cancelled"; ids: string[] }
  | { type: "generation-complete" }
  | { type: "turn-complete" }
  | { type: "interrupted" }
  | { type: "go-away"; timeLeft?: unknown }
  | { type: "session-resumption"; resumable: boolean; handle?: string }
  | { type: "usage"; metadata: Record<string, unknown> }
  | { type: "error"; error: GoogleLiveSessionError };

export interface GoogleLiveSessionOptions {
  apiKey: string;
  modelId?: string;
  systemInstruction?: string;
  voiceName?: string;
  activityHandling: GoogleLiveActivityHandling;
  history?: GoogleLiveHistoryMessage[];
  historyProvider?: () => readonly GoogleLiveHistoryMessage[];
  resumeHandle?: string;
  toolAdapter?: GoogleLiveToolAdapter;
  autoReconnect?: boolean;
  emit(event: GoogleLiveSessionEvent): void;
}

export interface GoogleLiveWebSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: {
    code: number;
    reason: string;
    wasClean: boolean;
  }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type GoogleLiveWebSocketFactory = (url: string) => GoogleLiveWebSocket;

export interface GoogleLiveSessionDependencies {
  webSocketFactory?: GoogleLiveWebSocketFactory;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}
