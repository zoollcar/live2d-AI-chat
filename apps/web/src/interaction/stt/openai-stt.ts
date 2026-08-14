import type { SttSettings } from "@live2d-chat/shared";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import type { RecognitionCallbacks, SpeechRecognitionProvider } from "./types";

export class OpenAiSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly id = "openai-compatible";
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private callbacks?: RecognitionCallbacks;
  private chunks: Blob[] = [];
  private requestController?: AbortController;

  constructor(private readonly settings: SttSettings) {}

  isSupported() {
    return typeof navigator.mediaDevices?.getUserMedia === "function" && "MediaRecorder" in window;
  }

  async start(callbacks: RecognitionCallbacks) {
    if (!this.isSupported()) throw new Error("This browser cannot record microphone audio.");
    this.abort();
    this.callbacks = callbacks;
    this.chunks = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.recorder = new MediaRecorder(this.stream);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.onerror = () => callbacks.onError(new Error("Microphone recording failed."));
    this.recorder.onstop = () => void this.transcribe();
    this.recorder.start();
    callbacks.onStatus("listening");
  }

  async stop() {
    if (this.recorder?.state === "recording") {
      this.callbacks?.onStatus("processing");
      this.recorder.stop();
    }
  }

  abort() {
    this.requestController?.abort();
    this.requestController = undefined;
    if (this.recorder) this.recorder.onstop = null;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.recorder = undefined;
    this.stream = undefined;
    this.callbacks = undefined;
    this.chunks = [];
  }

  private async transcribe() {
    const callbacks = this.callbacks;
    if (!callbacks) return;
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const audio = new Blob(this.chunks, { type: this.recorder?.mimeType || "audio/webm" });
      const form = new FormData();
      form.append("file", audio, "speech.webm");
      form.append("model", this.settings.modelId);
      form.append("language", this.settings.language.split("-")[0] || "en");
      const response = await fetch(`${normalizeBaseUrl(this.settings.baseUrl)}/audio/transcriptions`, {
        method: "POST",
        headers: this.settings.apiKey ? { authorization: `Bearer ${this.settings.apiKey}` } : undefined,
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Transcription failed (${response.status}).`);
      const data = (await response.json()) as { text?: string };
      if (data.text?.trim()) callbacks.onFinal(data.text.trim());
      callbacks.onStatus("idle");
    } catch (error) {
      if (!controller.signal.aborted) {
        callbacks.onError(error instanceof Error ? error : new Error("Transcription failed."));
      }
    } finally {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.recorder = undefined;
      this.stream = undefined;
      this.requestController = undefined;
      this.chunks = [];
    }
  }
}
