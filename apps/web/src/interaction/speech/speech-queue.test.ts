import { describe, expect, it, vi } from "vitest";
import type { TtsSettings } from "@live2d-chat/shared";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { SpeechSynthesisProvider } from "@/interaction/tts";
import { SpeechQueue } from "./speech-queue";

const settings: TtsSettings = {
  provider: "vits-local",
  transport: "direct",
  baseUrl: "",
  apiKey: "",
  rememberApiKey: false,
  modelId: "test",
  voice: "test",
  language: "en-US",
  rate: 1,
  pitch: 1,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("SpeechQueue output lifecycle", () => {
  it("becomes idle only after synthesized audio really finishes playing", async () => {
    const playback = deferred();
    const provider: SpeechSynthesisProvider = {
      id: "test",
      supportsLipSync: true,
      isSupported: () => true,
      listVoices: async () => [],
      synthesize: async () => ({ kind: "audio", blob: new Blob(["audio"]) }),
      cancel: vi.fn(),
    };
    const scene = {
      speakAudio: vi.fn(() => playback.promise),
      stopSpeech: vi.fn(),
    } as unknown as SceneController;
    const queue = new SpeechQueue(provider, settings, scene, vi.fn());

    queue.enqueue("Hello");
    await Promise.resolve();
    expect(queue.isIdle()).toBe(false);
    let idle = false;
    const idlePromise = queue.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);

    playback.resolve();
    await idlePromise;
    expect(queue.isIdle()).toBe(true);
  });

  it("resolves idle waiters when playback is cancelled", async () => {
    const provider = {
      id: "test",
      supportsLipSync: true,
      isSupported: () => true,
      listVoices: async () => [],
      synthesize: async () => ({ kind: "audio" as const, blob: new Blob(["audio"]) }),
      cancel: vi.fn(),
    };
    const scene = {
      speakAudio: vi.fn(() => new Promise<void>(() => undefined)),
      stopSpeech: vi.fn(),
    } as unknown as SceneController;
    const queue = new SpeechQueue(provider, settings, scene, vi.fn());

    queue.enqueue("Hello");
    await Promise.resolve();
    const idle = queue.whenIdle();
    queue.cancel();

    await idle;
    expect(provider.cancel).toHaveBeenCalledOnce();
    expect(scene.stopSpeech).toHaveBeenCalledOnce();
  });
});
