export const REALTIME_INPUT_SAMPLE_RATE = 16_000;
export const REALTIME_OUTPUT_SAMPLE_RATE = 24_000;
export const REALTIME_CHUNK_DURATION_MS = 20;

const INPUT_CHUNK_SAMPLES = REALTIME_INPUT_SAMPLE_RATE * REALTIME_CHUNK_DURATION_MS / 1_000;
const OUTPUT_SCHEDULE_LEAD_SECONDS = 0.02;
const CAPTURE_PROCESSOR_NAME = "live2d-realtime-pcm-capture";
const DEFAULT_WORKLET_MODULE_URL = "/audio/realtime-pcm-capture-worklet.js";

interface CaptureWorkletMessage {
  type: "samples";
  sampleRate: number;
  samples: ArrayBuffer;
}

export interface RealtimeAudioEngineOptions {
  onOutputLevel?(level: number): void;
  onOutputIdle?(): void;
  workletModuleUrl?: string;
}

export interface RealtimeAudioEngineDependencies {
  createAudioContext?(): AudioContext;
  getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioWorkletNode?(
    context: AudioContext,
    processorName: string,
    options: AudioWorkletNodeOptions,
  ): AudioWorkletNode;
  scheduleFrame?(callback: FrameRequestCallback): number;
  cancelFrame?(handle: number): void;
}

/**
 * Resamples mono floating-point microphone frames and emits exact 20 ms
 * PCM16 chunks at the Gemini Live input rate. Keeping this conversion outside
 * the AudioWorklet makes the protocol boundary deterministic and unit-testable.
 */
export class Pcm16InputChunker {
  private inputSampleRate?: number;
  private sourceRemainder = new Float32Array(0);
  private sourcePosition = 0;
  private targetChunk = new Int16Array(INPUT_CHUNK_SAMPLES);
  private targetOffset = 0;

  push(samples: Float32Array, inputSampleRate: number): Int16Array[] {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
      throw new Error("The microphone sample rate must be a positive number.");
    }
    if (samples.length === 0) return [];
    if (this.inputSampleRate !== undefined && this.inputSampleRate !== inputSampleRate) this.reset();
    this.inputSampleRate = inputSampleRate;

    if (inputSampleRate === REALTIME_INPUT_SAMPLE_RATE) {
      return this.appendResampled(samples);
    }

    const source = new Float32Array(this.sourceRemainder.length + samples.length);
    source.set(this.sourceRemainder);
    source.set(samples, this.sourceRemainder.length);
    const ratio = inputSampleRate / REALTIME_INPUT_SAMPLE_RATE;
    const resampled: number[] = [];

    while (this.sourcePosition + 1 < source.length) {
      const leftIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - leftIndex;
      const left = source[leftIndex] ?? 0;
      const right = source[leftIndex + 1] ?? left;
      resampled.push(left + (right - left) * fraction);
      this.sourcePosition += ratio;
    }

    const consumed = Math.min(Math.floor(this.sourcePosition), source.length);
    this.sourceRemainder = source.slice(consumed);
    this.sourcePosition -= consumed;
    return this.appendResampled(resampled);
  }

  reset(): void {
    this.inputSampleRate = undefined;
    this.sourceRemainder = new Float32Array(0);
    this.sourcePosition = 0;
    this.targetChunk = new Int16Array(INPUT_CHUNK_SAMPLES);
    this.targetOffset = 0;
  }

  private appendResampled(samples: ArrayLike<number>): Int16Array[] {
    const chunks: Int16Array[] = [];
    for (let index = 0; index < samples.length; index += 1) {
      this.targetChunk[this.targetOffset] = floatToPcm16(samples[index] ?? 0);
      this.targetOffset += 1;
      if (this.targetOffset !== INPUT_CHUNK_SAMPLES) continue;
      chunks.push(this.targetChunk);
      this.targetChunk = new Int16Array(INPUT_CHUNK_SAMPLES);
      this.targetOffset = 0;
    }
    return chunks;
  }
}

/** Browser microphone capture and gapless PCM playback for realtime sessions. */
export class RealtimeAudioEngine {
  private readonly onOutputLevel: (level: number) => void;
  private readonly onOutputIdle: () => void;
  private readonly workletModuleUrl: string;
  private readonly createAudioContext: () => AudioContext;
  private readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  private readonly createAudioWorkletNode: RealtimeAudioEngineDependencies["createAudioWorkletNode"];
  private readonly scheduleFrame: NonNullable<RealtimeAudioEngineDependencies["scheduleFrame"]>;
  private readonly cancelFrame: NonNullable<RealtimeAudioEngineDependencies["cancelFrame"]>;
  private readonly inputChunker = new Pcm16InputChunker();
  private readonly outputSources = new Set<AudioBufferSourceNode>();
  private readonly idleWaiters = new Set<() => void>();

  private context?: AudioContext;
  private workletModulePromise?: Promise<void>;
  private inputStream?: MediaStream;
  private inputSource?: MediaStreamAudioSourceNode;
  private inputWorklet?: AudioWorkletNode;
  private inputMute?: GainNode;
  private outputBus?: GainNode;
  private outputAnalyser?: AnalyserNode;
  private outputLevelSamples?: Float32Array<ArrayBuffer>;
  private outputLevelFrame?: number;
  private outputLevelGeneration = 0;
  private inputGeneration = 0;
  private outputGeneration = 0;
  private outputCursorSeconds = 0;
  private outputIdle = true;
  private disposed = false;

  constructor(
    options: RealtimeAudioEngineOptions = {},
    dependencies: RealtimeAudioEngineDependencies = {},
  ) {
    this.onOutputLevel = options.onOutputLevel ?? (() => undefined);
    this.onOutputIdle = options.onOutputIdle ?? (() => undefined);
    this.workletModuleUrl = options.workletModuleUrl ?? DEFAULT_WORKLET_MODULE_URL;
    this.createAudioContext = dependencies.createAudioContext ?? createBrowserAudioContext;
    this.getUserMedia = dependencies.getUserMedia ?? ((constraints) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        return Promise.reject(new Error("Microphone capture is unavailable in this browser."));
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    });
    this.createAudioWorkletNode = dependencies.createAudioWorkletNode
      ?? ((context, name, workletOptions) => new AudioWorkletNode(context, name, workletOptions));
    this.scheduleFrame = dependencies.scheduleFrame
      ?? ((callback) => globalThis.requestAnimationFrame(callback));
    this.cancelFrame = dependencies.cancelFrame
      ?? ((handle) => globalThis.cancelAnimationFrame(handle));
  }

  static isSupported(): boolean {
    return typeof AudioContext !== "undefined"
      && typeof AudioWorkletNode !== "undefined"
      && typeof navigator !== "undefined"
      && typeof navigator.mediaDevices?.getUserMedia === "function";
  }

  /** Call from a click/tap handler so browser autoplay policy permits output. */
  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume();
    if (context.state === "closed") throw new Error("The realtime audio context is closed.");
  }

  async startInput(onChunk: (pcm16: Int16Array) => void): Promise<void> {
    this.assertUsable();
    this.stopInput();
    const generation = this.inputGeneration;
    await this.resume();
    const context = this.ensureContext();
    this.workletModulePromise ??= context.audioWorklet.addModule(this.workletModuleUrl)
      .catch((error) => {
        this.workletModulePromise = undefined;
        throw error;
      });
    await this.workletModulePromise;
    if (this.disposed || generation !== this.inputGeneration) return;

    const stream = await this.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (this.disposed || generation !== this.inputGeneration) {
      stopMediaStream(stream);
      return;
    }

    try {
      const source = context.createMediaStreamSource(stream);
      const worklet = this.createAudioWorkletNode!(context, CAPTURE_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      const mute = context.createGain();
      mute.gain.value = 0;
      worklet.port.onmessage = (event: MessageEvent<CaptureWorkletMessage>) => {
        if (this.disposed || generation !== this.inputGeneration || event.data.type !== "samples") return;
        const samples = new Float32Array(event.data.samples);
        for (const chunk of this.inputChunker.push(samples, event.data.sampleRate)) onChunk(chunk);
      };
      source.connect(worklet);
      worklet.connect(mute);
      mute.connect(context.destination);
      this.inputStream = stream;
      this.inputSource = source;
      this.inputWorklet = worklet;
      this.inputMute = mute;
    } catch (error) {
      stopMediaStream(stream);
      throw error;
    }
  }

  stopInput(): void {
    this.inputGeneration += 1;
    this.inputChunker.reset();
    if (this.inputWorklet) this.inputWorklet.port.onmessage = null;
    disconnectNode(this.inputSource);
    disconnectNode(this.inputWorklet);
    disconnectNode(this.inputMute);
    stopMediaStream(this.inputStream);
    this.inputStream = undefined;
    this.inputSource = undefined;
    this.inputWorklet = undefined;
    this.inputMute = undefined;
  }

  /** Queue mono signed PCM16 returned by the realtime model at 24 kHz. */
  enqueueOutput(pcm16: Int16Array): void {
    this.assertUsable();
    if (pcm16.length === 0) return;
    const context = this.ensureContext();
    const buffer = context.createBuffer(1, pcm16.length, REALTIME_OUTPUT_SAMPLE_RATE);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < pcm16.length; index += 1) samples[index] = pcm16[index]! / 32_768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ensureOutputGraph(context));
    const generation = this.outputGeneration;
    const startAt = Math.max(
      this.outputCursorSeconds,
      context.currentTime + (this.outputIdle ? OUTPUT_SCHEDULE_LEAD_SECONDS : 0),
    );
    this.outputCursorSeconds = startAt + buffer.duration;
    this.outputIdle = false;
    this.outputSources.add(source);
    this.startOutputLevelSampling();

    source.onended = () => {
      source.onended = null;
      disconnectNode(source);
      this.outputSources.delete(source);
      if (generation === this.outputGeneration && this.outputSources.size === 0) this.markOutputIdle();
    };
    try {
      source.start(startAt);
    } catch (error) {
      source.onended = null;
      disconnectNode(source);
      this.outputSources.delete(source);
      if (this.outputSources.size === 0) this.markOutputIdle();
      throw error;
    }
  }

  clearOutput(): void {
    const wasActive = !this.outputIdle || this.outputSources.size > 0;
    this.outputGeneration += 1;
    for (const source of this.outputSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source can already have ended between the interruption and stop().
      }
      disconnectNode(source);
    }
    this.outputSources.clear();
    this.outputCursorSeconds = this.context?.currentTime ?? 0;
    this.outputIdle = true;
    this.stopOutputLevelSampling();
    this.resolveIdleWaiters();
    if (wasActive) this.onOutputIdle();
  }

  isOutputIdle(): boolean {
    return this.outputIdle && this.outputSources.size === 0;
  }

  whenOutputIdle(): Promise<void> {
    if (this.isOutputIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.stopInput();
    this.clearOutput();
    this.disposed = true;
    const context = this.context;
    this.context = undefined;
    this.workletModulePromise = undefined;
    disconnectNode(this.outputBus);
    disconnectNode(this.outputAnalyser);
    this.outputBus = undefined;
    this.outputAnalyser = undefined;
    this.outputLevelSamples = undefined;
    if (context && context.state !== "closed") await context.close();
  }

  private ensureContext(): AudioContext {
    this.assertUsable();
    this.context ??= this.createAudioContext();
    return this.context;
  }

  private ensureOutputGraph(context: AudioContext): GainNode {
    if (this.outputBus) return this.outputBus;

    const bus = context.createGain();
    const analyser = context.createAnalyser();
    bus.gain.value = 1;
    analyser.fftSize = 256;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0.65;
    bus.connect(analyser);
    analyser.connect(context.destination);
    this.outputBus = bus;
    this.outputAnalyser = analyser;
    this.outputLevelSamples = new Float32Array(analyser.fftSize);
    return bus;
  }

  private startOutputLevelSampling(): void {
    if (this.outputIdle || this.disposed || this.outputLevelFrame !== undefined) return;
    const generation = this.outputLevelGeneration;
    this.outputLevelFrame = this.scheduleFrame(() => this.sampleOutputLevel(generation));
  }

  private sampleOutputLevel(generation: number): void {
    // A cancelled callback may already be queued by the browser. It must not
    // clear or replace a newer session's animation frame.
    if (generation !== this.outputLevelGeneration) return;
    this.outputLevelFrame = undefined;
    if (this.outputIdle || this.disposed || !this.outputAnalyser || !this.outputLevelSamples) {
      this.onOutputLevel(0);
      return;
    }

    this.outputAnalyser.getFloatTimeDomainData(this.outputLevelSamples);
    this.onOutputLevel(rmsLevel(this.outputLevelSamples));
    this.startOutputLevelSampling();
  }

  private stopOutputLevelSampling(): void {
    this.outputLevelGeneration += 1;
    if (this.outputLevelFrame !== undefined) this.cancelFrame(this.outputLevelFrame);
    this.outputLevelFrame = undefined;
    this.onOutputLevel(0);
  }

  private markOutputIdle(): void {
    if (this.outputIdle) return;
    this.outputIdle = true;
    this.outputCursorSeconds = this.context?.currentTime ?? 0;
    this.stopOutputLevelSampling();
    this.resolveIdleWaiters();
    this.onOutputIdle();
  }

  private resolveIdleWaiters(): void {
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("The realtime audio engine has been disposed.");
  }
}

function createBrowserAudioContext(): AudioContext {
  try {
    return new AudioContext({ latencyHint: "interactive", sampleRate: REALTIME_OUTPUT_SAMPLE_RATE });
  } catch {
    return new AudioContext({ latencyHint: "interactive" });
  }
}

function floatToPcm16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767);
}

function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  // Match the gain used by the installed Live2D lipsync patch so ordinary
  // speech amplitudes produce a visible, normalized mouth movement.
  return Math.max(0, Math.min(1, Math.sqrt(sum / samples.length * 20)));
}

function stopMediaStream(stream: MediaStream | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function disconnectNode(node: AudioNode | undefined): void {
  if (!node) return;
  try {
    node.disconnect();
  } catch {
    // Disconnect is intentionally idempotent during stop/interrupt races.
  }
}
