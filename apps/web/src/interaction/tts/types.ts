import type { TtsSettings } from "@live2d-chat/shared";

export interface AudioSpeechOutput {
  kind: "audio";
  blob: Blob;
}

export interface NativeSpeechOutput {
  kind: "native";
  utterance: SpeechSynthesisUtterance;
}

export type SpeechOutput = AudioSpeechOutput | NativeSpeechOutput;

export interface SpeechSynthesisProvider {
  readonly id: string;
  readonly supportsLipSync: boolean;
  isSupported(): boolean;
  listVoices(): Promise<string[]>;
  synthesize(text: string, settings: TtsSettings, signal: AbortSignal): Promise<SpeechOutput>;
  cancel(): void;
}
