import type { TtsSettings } from "@live2d-chat/shared";
import type { SpeechSynthesisProvider } from "@/interaction/tts";
import type { SceneController } from "@/model/live2d/scene-controller";

export class SpeechQueue {
  private queue: string[] = [];
  private running = false;
  private controller = new AbortController();
  private generation = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly provider: SpeechSynthesisProvider,
    private readonly settings: TtsSettings,
    private readonly scene: SceneController,
    private readonly onSentence: (sentence: string) => void,
  ) {}

  enqueue(sentence: string) {
    if (!sentence.trim()) return;
    this.queue.push(sentence.trim());
    if (!this.running) void this.pump();
  }

  cancel() {
    this.queue = [];
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    this.provider.cancel();
    this.scene.stopSpeech();
    this.running = false;
    this.resolveIdle();
  }

  /** Resolves once all queued speech has finished playing (or is cancelled). */
  whenIdle() {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleResolvers.push(resolve));
  }

  private async pump() {
    const generation = this.generation;
    this.running = true;
    const signal = this.controller.signal;
    try {
      while (this.queue.length && !signal.aborted) {
        const sentence = this.queue.shift();
        if (!sentence) continue;
        this.onSentence(sentence);
        const output = await this.provider.synthesize(sentence, this.settings, signal);
        if (output.kind === "audio") {
          await this.scene.speakAudio(output.blob, signal);
        } else {
          this.scene.startNativeSpeech();
          let rejectOnAbort: (() => void) | undefined;
          await new Promise<void>((resolve, reject) => {
            rejectOnAbort = () => reject(new DOMException("Speech cancelled.", "AbortError"));
            signal.addEventListener("abort", rejectOnAbort, { once: true });
            output.utterance.onend = () => resolve();
            output.utterance.onerror = () => reject(new Error("Browser speech playback failed."));
            speechSynthesis.speak(output.utterance);
          }).finally(() => {
            if (rejectOnAbort) signal.removeEventListener("abort", rejectOnAbort);
          });
          this.scene.stopSpeech();
        }
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error);
    } finally {
      if (generation === this.generation) {
        this.running = false;
        if (this.queue.length === 0) this.resolveIdle();
      }
    }
  }

  private resolveIdle() {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }
}
