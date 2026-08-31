import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneController } from "@/model/live2d/scene-controller";
import { ChromeAgentRuntime } from "./chrome-agent";
import type { AgentEvent } from "./types";

describe("ChromeAgentRuntime", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams text through Chrome and exposes every scene tool", async () => {
    const destroy = vi.fn();
    const promptStreaming = vi.fn(() => new ReadableStream<string>({
      start(controller) {
        controller.enqueue("Hello");
        controller.enqueue(" there");
        controller.close();
      },
    }));
    const create = vi.fn().mockResolvedValue({ promptStreaming, destroy });
    vi.stubGlobal("LanguageModel", { create });
    const events: AgentEvent[] = [];

    await new ChromeAgentRuntime().run({
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hello" },
      ],
      settings: {
        transport: "chrome",
        baseUrl: "chrome://built-in-ai",
        apiKey: "",
        rememberApiKey: false,
        modelId: "gemini-nano",
      },
      scene: {} as SceneController,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      toolCapabilities: { inspectImage: true },
    });

    const createOptions = create.mock.calls[0][0] as LanguageModelCreateOptions;
    expect(createOptions.initialPrompts).toEqual([{ role: "system", content: "Be helpful." }]);
    expect(createOptions.tools?.map((tool) => tool.name)).toEqual([
      "setState",
      "setDecorations",
      "performAction",
      "setStageLayout",
      "listResources",
      "readResource",
      "readWebPage",
      "readVideoTranscript",
      "showResourceOnStage",
      "closeStageContent",
      "drawSvgOnStage",
      "sendSticker",
      "inspectImage",
    ]);
    expect(createOptions.expectedInputs).toEqual([{ type: "image" }, { type: "text" }]);
    expect(promptStreaming).toHaveBeenCalledWith("Hello", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", delta: "Hello" },
      { type: "text-delta", delta: " there" },
    ]);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("surfaces a clear error outside supported Chrome", async () => {
    vi.stubGlobal("LanguageModel", undefined);
    const events: AgentEvent[] = [];
    await new ChromeAgentRuntime().run({
      messages: [{ role: "user", content: "Hello" }],
      settings: {
        transport: "chrome",
        baseUrl: "chrome://built-in-ai",
        apiKey: "",
        rememberApiKey: false,
        modelId: "gemini-nano",
      },
      scene: {} as SceneController,
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: expect.objectContaining({ message: expect.stringContaining("not available") }),
    });
  });
});
