// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Pcm16InputChunker,
  REALTIME_INPUT_SAMPLE_RATE,
  RealtimeAudioEngine,
} from "./realtime-audio-engine";

class FakeAudioBuffer {
  readonly samples: Float32Array;
  readonly duration: number;

  constructor(length: number, sampleRate: number) {
    this.samples = new Float32Array(length);
    this.duration = length / sampleRate;
  }

  getChannelData() {
    return this.samples;
  }
}

class FakeBufferSource {
  buffer?: FakeAudioBuffer;
  onended: (() => void) | null = null;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly stop = vi.fn();
  readonly start = vi.fn((when?: number) => { this.startedAt = when; });
  startedAt?: number;

  finish() {
    this.onended?.();
  }
}

class FakeGainNode {
  readonly gain = { value: 1 };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeAnalyserNode {
  fftSize = 2048;
  minDecibels = -100;
  maxDecibels = -30;
  smoothingTimeConstant = 0.8;
  waveform = new Float32Array(256);
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly getFloatTimeDomainData = vi.fn((samples: Float32Array) => {
    samples.fill(0);
    samples.set(this.waveform.subarray(0, samples.length));
  });
}

class FakeFrameScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  readonly schedule = vi.fn((callback: FrameRequestCallback) => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    return handle;
  });
  readonly cancel = vi.fn((handle: number) => {
    this.callbacks.delete(handle);
  });

  get pendingCount(): number {
    return this.callbacks.size;
  }

  flush(timestamp = 0): void {
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of pending) callback(timestamp);
  }
}

class FakeWorkletNode {
  readonly port = { onmessage: null as ((event: MessageEvent) => void) | null };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeAudioContext {
  state: AudioContextState = "suspended";
  currentTime = 10;
  readonly destination = {};
  readonly sources: FakeBufferSource[] = [];
  readonly gains: FakeGainNode[] = [];
  readonly analyser = new FakeAnalyserNode();
  readonly mediaSource = { connect: vi.fn(), disconnect: vi.fn() };
  readonly audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  readonly resume = vi.fn(async () => { this.state = "running"; });
  readonly close = vi.fn(async () => { this.state = "closed"; });
  readonly createMediaStreamSource = vi.fn(() => this.mediaSource);
  readonly createGain = vi.fn(() => {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  });
  readonly createAnalyser = vi.fn(() => this.analyser);
  readonly createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) =>
    new FakeAudioBuffer(length, sampleRate));
  readonly createBufferSource = vi.fn(() => {
    const source = new FakeBufferSource();
    this.sources.push(source);
    return source;
  });
}

function createStream() {
  const track = { stop: vi.fn() };
  return {
    track,
    stream: { getTracks: () => [track] } as unknown as MediaStream,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Pcm16InputChunker", () => {
  it("resamples 48 kHz mono input into exact 20 ms 16 kHz PCM16 chunks", () => {
    const chunker = new Pcm16InputChunker();
    const input = Float32Array.from({ length: 960 }, (_, index) =>
      Math.sin(2 * Math.PI * 440 * index / 48_000));

    const chunks = chunker.push(input, 48_000);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(REALTIME_INPUT_SAMPLE_RATE * 0.02);
    expect(Math.max(...chunks[0]!)).toBeGreaterThan(30_000);
    expect(Math.min(...chunks[0]!)).toBeLessThan(-30_000);
  });

  it("clamps same-rate microphone samples to signed PCM16", () => {
    const chunker = new Pcm16InputChunker();
    const positive = chunker.push(new Float32Array(320).fill(2), REALTIME_INPUT_SAMPLE_RATE);
    const negative = chunker.push(new Float32Array(320).fill(-2), REALTIME_INPUT_SAMPLE_RATE);

    expect(positive[0]?.[0]).toBe(32_767);
    expect(negative[0]?.[0]).toBe(-32_768);
  });
});

describe("RealtimeAudioEngine", () => {
  it("captures an echo-controlled mono stream and emits resampled PCM chunks", async () => {
    const context = new FakeAudioContext();
    const worklet = new FakeWorkletNode();
    const { stream, track } = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const onChunk = vi.fn();
    const engine = new RealtimeAudioEngine({}, {
      createAudioContext: () => context as unknown as AudioContext,
      getUserMedia,
      createAudioWorkletNode: () => worklet as unknown as AudioWorkletNode,
    });

    await engine.startInput(onChunk);

    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith("/audio/realtime-pcm-capture-worklet.js");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const samples = Float32Array.from({ length: 960 }, (_, index) => index / 960);
    worklet.port.onmessage?.({
      data: { type: "samples", sampleRate: 48_000, samples: samples.buffer },
    } as MessageEvent);
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0]?.[0]).toBeInstanceOf(Int16Array);
    expect(onChunk.mock.calls[0]?.[0]).toHaveLength(320);

    engine.stopInput();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(worklet.port.onmessage).toBeNull();
  });

  it("schedules 24 kHz output without gaps and resolves idle only after playback drains", async () => {
    const context = new FakeAudioContext();
    const frames = new FakeFrameScheduler();
    const levels: number[] = [];
    const onIdle = vi.fn();
    const engine = new RealtimeAudioEngine({
      onOutputLevel: (level) => levels.push(level),
      onOutputIdle: onIdle,
    }, {
      createAudioContext: () => context as unknown as AudioContext,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
    });
    await engine.resume();

    engine.enqueueOutput(Int16Array.from([32_767, -32_768, ...new Int16Array(478)]));
    engine.enqueueOutput(new Int16Array(480).fill(16_384));
    expect(context.sources.map((source) => source.startedAt)).toEqual([10.02, 10.04]);
    expect(context.sources[0]?.buffer?.samples[0]).toBeCloseTo(32_767 / 32_768);
    expect(context.sources[0]?.buffer?.samples[1]).toBe(-1);
    const outputBus = context.gains[0];
    expect(context.sources[0]?.connect).toHaveBeenCalledWith(outputBus);
    expect(context.sources[1]?.connect).toHaveBeenCalledWith(outputBus);
    expect(outputBus?.connect).toHaveBeenCalledWith(context.analyser);
    expect(context.analyser.connect).toHaveBeenCalledWith(context.destination);
    expect(context.createGain).toHaveBeenCalledOnce();
    expect(context.createAnalyser).toHaveBeenCalledOnce();

    let idleResolved = false;
    const idle = engine.whenOutputIdle().then(() => { idleResolved = true; });
    await Promise.resolve();
    expect(idleResolved).toBe(false);
    expect(levels).toEqual([]);

    context.analyser.waveform.fill(0.1);
    frames.flush();
    const loudLevel = levels.at(-1) ?? 0;
    expect(loudLevel).toBeCloseTo(Math.sqrt(0.1 ** 2 * 20));
    expect(frames.pendingCount).toBe(1);

    context.analyser.waveform.fill(0.02);
    frames.flush();
    expect(levels.at(-1)).toBeCloseTo(Math.sqrt(0.02 ** 2 * 20));
    expect(levels.at(-1)).toBeLessThan(loudLevel);
    expect(context.analyser.getFloatTimeDomainData).toHaveBeenCalledTimes(2);

    context.sources[0]?.finish();
    await Promise.resolve();
    expect(idleResolved).toBe(false);
    expect(frames.pendingCount).toBe(1);
    context.sources[1]?.finish();
    await idle;
    expect(engine.isOutputIdle()).toBe(true);
    expect(levels.at(-1)).toBe(0);
    expect(frames.pendingCount).toBe(0);
    expect(frames.cancel).toHaveBeenCalledOnce();
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("clears queued output immediately and fully disposes capture and audio context", async () => {
    const context = new FakeAudioContext();
    const frames = new FakeFrameScheduler();
    const worklet = new FakeWorkletNode();
    const { stream, track } = createStream();
    const onLevel = vi.fn();
    const onIdle = vi.fn();
    const engine = new RealtimeAudioEngine({ onOutputLevel: onLevel, onOutputIdle: onIdle }, {
      createAudioContext: () => context as unknown as AudioContext,
      getUserMedia: vi.fn().mockResolvedValue(stream),
      createAudioWorkletNode: () => worklet as unknown as AudioWorkletNode,
      scheduleFrame: frames.schedule,
      cancelFrame: frames.cancel,
    });
    await engine.startInput(vi.fn());
    engine.enqueueOutput(new Int16Array(480).fill(1_000));
    const idle = engine.whenOutputIdle();
    context.analyser.waveform.fill(0.08);
    frames.flush();
    expect(onLevel).toHaveBeenLastCalledWith(expect.any(Number));
    expect(onLevel.mock.calls.at(-1)?.[0]).toBeGreaterThan(0);

    engine.clearOutput();
    await idle;
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();
    expect(engine.isOutputIdle()).toBe(true);
    expect(onLevel).toHaveBeenLastCalledWith(0);
    expect(frames.pendingCount).toBe(0);
    expect(onIdle).toHaveBeenCalledOnce();

    await engine.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.gains[1]?.disconnect).toHaveBeenCalledOnce();
    expect(context.analyser.disconnect).toHaveBeenCalledOnce();
    await expect(engine.whenOutputIdle()).resolves.toBeUndefined();
  });
});
