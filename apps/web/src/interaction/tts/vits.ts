import type { TtsSettings } from "@live2d-chat/shared";
import type { SpeechOutput, SpeechSynthesisProvider } from "./types";

interface WorkerResponse {
  id: string;
  blob?: Blob;
  error?: string;
}

export class VitsSpeechSynthesisProvider implements SpeechSynthesisProvider {
  readonly id = "vits-local";
  readonly supportsLipSync = true;
  private worker?: Worker;

  isSupported() {
    return typeof Worker !== "undefined" && typeof AudioContext !== "undefined";
  }

  async listVoices() {
    return ["en_US-hfc_female-medium"];
  }

  async synthesize(text: string, settings: TtsSettings, signal: AbortSignal): Promise<SpeechOutput> {
    if (!this.isSupported()) throw new Error("Local VITS is not supported in this browser.");
    this.worker ||= new Worker(new URL("./vits-worker.ts", import.meta.url), { type: "module" });
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Speech was cancelled", "AbortError"));
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.id !== id) return;
        signal.removeEventListener("abort", onAbort);
        this.worker?.removeEventListener("message", onMessage);
        if (event.data.error || !event.data.blob) reject(new Error(event.data.error || "VITS returned no audio."));
        else resolve({ kind: "audio", blob: event.data.blob });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.worker?.addEventListener("message", onMessage);
      this.worker?.postMessage({ id, text, voice: settings.voice || "en_US-hfc_female-medium" });
    });
  }

  cancel() {
    this.worker?.terminate();
    this.worker = undefined;
  }
}
