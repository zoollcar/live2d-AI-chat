import type { SttSettings } from "@live2d-chat/shared";
import { normalizeBaseUrl } from "@/infrastructure/config/defaults";
import { createExtensionFetch } from "@/infrastructure/extension/bridge-client";
import { directCorsAwareFetch } from "@/infrastructure/network/direct-fetch";
import { createLogger } from "@/infrastructure/log";
import type { RecognitionCallbacks, SpeechRecognitionProvider } from "./types";

const log = createLogger("stt:openai");

export class OpenAiSpeechRecognitionProvider implements SpeechRecognitionProvider {
  readonly id = "openai-compatible";
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private callbacks?: RecognitionCallbacks;
  private chunks: Blob[] = [];
  private requestController?: AbortController;

  constructor(private readonly settings: SttSettings) {}

  isSupported() {
    const supported = typeof navigator.mediaDevices?.getUserMedia === "function" && "MediaRecorder" in window;
    log.debug("isSupported", { supported });
    return supported;
  }

  async start(callbacks: RecognitionCallbacks) {
    log.debug("start() called", { lang: this.settings.language, model: this.settings.modelId });
    if (!this.isSupported()) throw new Error("This browser cannot record microphone audio.");
    this.abort();
    this.callbacks = callbacks;
    this.chunks = [];
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      log.debug("getUserMedia acquired stream", { tracks: this.stream.getTracks().map((t) => t.kind) });
      this.recorder = new MediaRecorder(this.stream);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
          log.debug("ondataavailable", { bytes: event.data.size, chunks: this.chunks.length });
        }
      };
      this.recorder.onerror = (event) => {
        log.error("MediaRecorder error", { error: String((event as ErrorEvent).error ?? event) });
        callbacks.onError(new Error("Microphone recording failed."));
      };
      this.recorder.onstop = () => {
        log.debug("MediaRecorder stopped, transcribing", { chunks: this.chunks.length });
        // The session ended on its own (recorder reached its cap, ran out of
        // chunks, or stop() fired). Let the host reopen the mic if it's in
        // continuous mode.
        callbacks.onAutoEnd?.();
        void this.transcribe();
      };
      this.recorder.start();
      log.debug("MediaRecorder started", { state: this.recorder.state, mimeType: this.recorder.mimeType });
      callbacks.onStatus("listening");
    } catch (error) {
      log.error("getUserMedia or recorder start failed", { error: String(error) });
      throw error;
    }
  }

  async stop() {
    log.debug("stop() called", { recorderState: this.recorder?.state });
    if (this.recorder?.state === "recording") {
      this.callbacks?.onStatus("processing");
      this.recorder.stop();
    }
  }

  abort() {
    log.debug("abort() called", { recorderState: this.recorder?.state });
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
    log.debug("transcribe() called", { chunks: this.chunks.length });
    if (!callbacks) return;
    const controller = new AbortController();
    this.requestController = controller;
    try {
      const audio = new Blob(this.chunks, { type: this.recorder?.mimeType || "audio/webm" });
      log.debug("sending transcription request", { bytes: audio.size, mime: audio.type });
      const form = new FormData();
      form.append("file", audio, "speech.webm");
      form.append("model", this.settings.modelId);
      form.append("language", this.settings.language.split("-")[0] || "en");
      const upstreamUrl = normalizeBaseUrl(this.settings.baseUrl);
      const extension = this.settings.transport === "extension";
      const fetcher = extension
        ? createExtensionFetch({
            operation: "transcribe",
            provider: "openai-compatible",
            baseUrl: upstreamUrl,
            apiKey: this.settings.apiKey,
          })
        : directCorsAwareFetch;
      const response = await fetcher(`${upstreamUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          ...(!extension && this.settings.apiKey ? { authorization: `Bearer ${this.settings.apiKey}` } : {}),
        },
        body: form,
        signal: controller.signal,
      });
      log.debug("transcription response", { status: response.status, ok: response.ok });
      if (!response.ok) throw new Error(`Transcription failed (${response.status}).`);
      const data = (await response.json()) as { text?: string };
      log.debug("transcription text", { length: data.text?.length, text: data.text });
      if (data.text?.trim()) callbacks.onFinal(data.text.trim());
      callbacks.onStatus("idle");
    } catch (error) {
      if (!controller.signal.aborted) {
        log.error("transcription failed", { error: String(error) });
        callbacks.onError(error instanceof Error ? error : new Error("Transcription failed."));
      } else {
        log.debug("transcription aborted by signal");
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
