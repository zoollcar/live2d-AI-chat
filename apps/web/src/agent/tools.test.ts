import { describe, expect, it, vi, type Mocked } from "vitest";
import type { SceneController } from "@/model/live2d/scene-controller";
import type { AgentEvent } from "./types";
import { createAgentToolRegistry, createSceneToolRegistry } from "./tools";

function fakeScene(): Mocked<SceneController> {
  return {
    setDecorations: vi.fn((decorations: string[]) => decorations),
    performAction: vi.fn(),
    enqueueAction: vi.fn(),
    preemptAndEnqueueAction: vi.fn(),
    setState: vi.fn().mockResolvedValue(undefined),
    setStageLayout: vi.fn(),
  } as unknown as Mocked<SceneController>;
}

describe("scene tools", () => {
  it("derives Remote, wllama, Chrome, and Google-compatible declarations from one schema", () => {
    const registry = createAgentToolRegistry({
      scene: fakeScene(),
      emit: vi.fn(),
      capabilities: { inspectImage: true },
    });
    const remoteNames = Object.keys(registry.aiTools);
    const wllamaNames = registry.wllamaTools.map((entry) => entry.function.name);
    const chromeNames = registry.chromeTools.map((entry) => entry.name);

    expect(remoteNames).toEqual(wllamaNames);
    expect(chromeNames).toEqual(wllamaNames);
    expect(remoteNames).toContain("inspectImage");
    expect(createAgentToolRegistry({ scene: fakeScene(), emit: vi.fn() }).wllamaTools
      .map((entry) => entry.function.name)).not.toContain("inspectImage");
  });

  it("only registers tools enabled by the active character profile", async () => {
    const registry = createAgentToolRegistry({
      scene: fakeScene(),
      emit: vi.fn(),
      enabledTools: ["setState", "performAction"],
    });

    expect(Object.keys(registry.aiTools)).toEqual(["setState", "performAction"]);
    await expect(registry.execute("disabled", "setDecorations", { decorations: [] }))
      .rejects.toThrow("Unknown agent tool");
  });

  it("runs independent reads in parallel while serializing scene mutations by callId", async () => {
    let releaseScene!: () => void;
    let releaseFirstRead!: () => void;
    let releaseSecondRead!: () => void;
    const scene = fakeScene();
    scene.setState.mockImplementation(() => new Promise<void>((resolve) => { releaseScene = resolve; }));
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirstRead = () => resolve({ text: "one" }); }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecondRead = () => resolve({ text: "two" }); }));
    const events: AgentEvent[] = [];
    const registry = createAgentToolRegistry({
      scene,
      resources: { list: vi.fn(), read },
      emit: (event) => events.push(event),
    });

    const sceneCall = registry.execute("scene-1", "setState", { state: "thinking" });
    const firstRead = registry.execute("read-1", "readResource", { contentId: "one", maxChars: 100 });
    const secondRead = registry.execute("read-2", "readResource", { contentId: "two", maxChars: 100 });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    releaseFirstRead();
    releaseSecondRead();
    await expect(Promise.all([firstRead, secondRead])).resolves.toEqual([{ text: "one" }, { text: "two" }]);
    expect(scene.setState).toHaveBeenCalledOnce();
    releaseScene();
    await expect(sceneCall).resolves.toEqual({ ok: true, state: "thinking" });
    expect(events.filter((event) => event.type === "tool-result").map((event) => event.callId).sort())
      .toEqual(["read-1", "read-2", "scene-1"]);
  });

  it("emits an explicit cancel state for an aborted call instead of a result", async () => {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const registry = createAgentToolRegistry({
      scene: fakeScene(),
      resources: {
        list: vi.fn(),
        read: vi.fn((_input, signal) => new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
        })),
      },
      emit: (event) => events.push(event),
    });
    const call = registry.execute("read-cancel", "readResource", { contentId: "one", maxChars: 100 }, controller.signal);
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "tool-call",
      callId: "read-cancel",
    })));
    controller.abort();

    await expect(call).rejects.toThrow();
    expect(events).toContainEqual({ type: "tool-cancel", callId: "read-cancel", name: "readResource" });
    expect(events).not.toContainEqual(expect.objectContaining({ type: "tool-result", callId: "read-cancel" }));
  });

  it("executes fixed stage layouts", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("call-layout", "setStageLayout", { layout: "half-body-left" }))
      .resolves.toEqual({ ok: true, layout: "half-body-left" });
    expect(scene.setStageLayout).toHaveBeenCalledWith("half-body-left");
  });

  it("sets state and a complete decoration set", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("call-state", "setState", { state: "happy" }))
      .resolves.toEqual({ ok: true, state: "happy" });
    await expect(registry.execute("call-decorations", "setDecorations", { decorations: ["crown", "cat-ears"] }))
      .resolves.toEqual({ ok: true, decorations: ["crown", "cat-ears"] });
    expect(scene.setState).toHaveBeenCalledWith("happy");
    expect(scene.setDecorations).toHaveBeenCalledWith(["crown", "cat-ears"]);
  });

  it("first performAction in a batch preempts, subsequent ones just enqueue", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await registry.execute("call-wink", "performAction", { action: "wink" });
    await registry.execute("call-wave", "performAction", { action: "wave" });
    expect(scene.preemptAndEnqueueAction).toHaveBeenCalledTimes(1);
    expect(scene.preemptAndEnqueueAction).toHaveBeenCalledWith("wink");
    expect(scene.enqueueAction).toHaveBeenCalledTimes(1);
    expect(scene.enqueueAction).toHaveBeenCalledWith("wave");
  });

  it("resetBatch() arms the next performAction to preempt again", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await registry.execute("call-wink", "performAction", { action: "wink" });
    await registry.execute("call-wave", "performAction", { action: "wave" });
    registry.resetBatch();
    await registry.execute("call-think", "performAction", { action: "think" });
    expect(scene.preemptAndEnqueueAction).toHaveBeenCalledTimes(2);
    expect(scene.preemptAndEnqueueAction.mock.calls[0]![0]).toBe("wink");
    expect(scene.preemptAndEnqueueAction.mock.calls[1]![0]).toBe("think");
  });

  it("only curated actions and states are accepted", async () => {
    const registry = createSceneToolRegistry(fakeScene(), vi.fn());
    await expect(registry.execute("call-flirt", "performAction", { action: "flirt" })).rejects.toThrow();
    await expect(registry.execute("call-running", "setState", { state: "running" })).rejects.toThrow();
  });

  it("setState forwards to the scene controller", async () => {
    const scene = fakeScene();
    const registry = createSceneToolRegistry(scene, vi.fn());
    await expect(registry.execute("call-thinking", "setState", { state: "thinking" }))
      .resolves.toEqual({ ok: true, state: "thinking" });
    expect(scene.setState).toHaveBeenCalledWith("thinking");
  });

  it("rejects arbitrary layouts and unknown visual states", async () => {
    const registry = createSceneToolRegistry(fakeScene(), vi.fn());
    await expect(registry.execute("call-layout", "setStageLayout", { layout: { x: 10, scale: 99 } }))
      .rejects.toThrow();
    await expect(registry.execute("call-state", "setState", { state: "custom-file" }))
      .rejects.toThrow();
    await expect(registry.execute("call-decorations", "setDecorations", { decorations: ["custom-file"] }))
      .rejects.toThrow();
  });
});
