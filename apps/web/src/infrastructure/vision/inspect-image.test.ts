// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import type { LlmSettings, ModelCapabilitySettings } from "@live2d-chat/shared";
import type { ResourceBlobRecord, ResourceKind, ResourceRecord } from "@/model/resource";
import {
  IMAGE_ANALYSIS_MAX_CHARS,
  inspectImageWithCurrentModel,
  type ImageInspectionRepository,
} from "./inspect-image";
import type { PreparedVisionImage } from "./preprocess-image";

interface CapturedGenerateTextOptions {
  model: unknown;
  instructions: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature: number;
  maxRetries: number;
  abortSignal?: AbortSignal;
}

const mocks = vi.hoisted(() => ({
  createRemoteLanguageModel: vi.fn((
    _settings: LlmSettings,
    _options?: { operation?: "chat" | "vision" },
  ) => "test-model"),
  generateText: vi.fn(async (_options: CapturedGenerateTextOptions) => ({ text: "" })),
  preprocessImageForVision: vi.fn(async (
    _blob: Blob,
    _declaredMediaType: string,
    _signal?: AbortSignal,
  ): Promise<PreparedVisionImage> => {
    throw new Error("Vision preprocessing mock was not configured.");
  }),
}));

vi.mock("ai", () => ({ generateText: mocks.generateText }));
vi.mock("@/agent/language-model", () => ({
  createRemoteLanguageModel: mocks.createRemoteLanguageModel,
}));
vi.mock("./preprocess-image", () => ({
  preprocessImageForVision: mocks.preprocessImageForVision,
}));

function settings(transport: LlmSettings["transport"] = "direct"): LlmSettings {
  return {
    transport,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "top-secret-key",
    rememberApiKey: false,
    modelId: transport === "chrome" ? "gemini-nano" : "gpt-4.1-mini",
  };
}

function capabilities(vision: ModelCapabilitySettings["vision"] = "enabled"): ModelCapabilitySettings {
  return { vision };
}

function resource(kind: ResourceKind = "image", overrides: Partial<ResourceRecord> = {}): ResourceRecord {
  return {
    id: "image-1",
    conversationId: "conversation-1",
    kind,
    origin: "upload",
    name: kind === "image" ? "photo.png" : "document.pdf",
    mimeType: kind === "image" ? "image/png" : "application/pdf",
    extension: kind === "image" ? "png" : "pdf",
    status: "ready",
    byteSize: 22,
    originalByteSize: 22,
    sha256: `sha256:${"a".repeat(64)}`,
    textLength: 0,
    chunkCount: 0,
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function repositoryFixture(input: {
  record?: ResourceRecord;
  missing?: boolean;
  blob?: ResourceBlobRecord;
} = {}) {
  const record = input.record ?? resource();
  const originalBlob = input.blob?.blob ?? new Blob(
    ["ORIGINAL-BINARY-AND-METADATA"],
    { type: record.mimeType },
  );
  const blobRecord: ResourceBlobRecord = input.blob ?? {
    resourceId: record.id,
    blob: originalBlob,
    byteSize: originalBlob.size,
    mimeType: record.mimeType,
  };
  const getResource = vi.fn(async (_id: string): Promise<ResourceRecord | undefined> => (
    input.missing ? undefined : record
  ));
  const getResourceBlob = vi.fn(async (_id: string): Promise<ResourceBlobRecord | undefined> => blobRecord);
  return {
    originalBlob,
    getResource,
    getResourceBlob,
    repository: { getResource, getResourceBlob } satisfies ImageInspectionRepository,
  };
}

function preparedImage(): PreparedVisionImage {
  return {
    bytes: new TextEncoder().encode("SANITIZED-PIXELS"),
    mediaType: "image/webp",
    width: 1_000,
    height: 500,
    originalWidth: 4_000,
    originalHeight: 2_000,
  };
}

function dependencyFixture(resultText = "The image contains a cat.") {
  const prepared = preparedImage();
  mocks.preprocessImageForVision.mockResolvedValue(prepared);
  mocks.createRemoteLanguageModel.mockReturnValue("test-model");
  mocks.generateText.mockResolvedValue({ text: resultText });
  return { prepared };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inspectImageWithCurrentModel", () => {
  it.each(["direct", "extension"] as const)(
    "sends only a locally prepared image through the selected %s remote transport",
    async (transport) => {
      const repository = repositoryFixture();
      dependencyFixture(`Visible\0 analysis ${"x".repeat(IMAGE_ANALYSIS_MAX_CHARS)}`);
      const controller = new AbortController();
      const currentSettings = settings(transport);

      const analysis = await inspectImageWithCurrentModel({
        repository: repository.repository,
        resourceId: "image-1",
        question: "What is visible?",
        signal: controller.signal,
        settings: currentSettings,
        capabilities: capabilities(),
      });

      expect(mocks.preprocessImageForVision).toHaveBeenCalledWith(
        repository.originalBlob,
        "image/png",
        controller.signal,
      );
      expect(mocks.createRemoteLanguageModel).toHaveBeenCalledWith(currentSettings, { operation: "vision" });
      expect(mocks.generateText).toHaveBeenCalledOnce();
      const request = mocks.generateText.mock.calls[0]?.[0];
      if (!request) throw new Error("Expected a remote vision request.");
      expect(request).toMatchObject({
        maxRetries: 0,
        abortSignal: controller.signal,
        temperature: 0.1,
      });
      const message = request.messages[0];
      expect(message).toMatchObject({ role: "user" });
      if (message.role !== "user" || typeof message.content === "string") throw new Error("Expected multimodal input.");
      const file = message.content.find((part) => part.type === "file");
      expect(file).toMatchObject({ mediaType: "image/webp", filename: "inspection.webp" });
      if (!file || file.type !== "file" || !ArrayBuffer.isView(file.data)) throw new Error("Expected image bytes.");
      const fileBytes = new Uint8Array(file.data.buffer, file.data.byteOffset, file.data.byteLength);
      expect(new TextDecoder().decode(fileBytes)).toBe("SANITIZED-PIXELS");
      expect(new TextDecoder().decode(fileBytes)).not.toContain("ORIGINAL-BINARY");
      expect(analysis).toHaveLength(IMAGE_ANALYSIS_MAX_CHARS);
      expect(analysis).not.toContain("\0");
    },
  );

  it.each([
    { transport: "local" as const, vision: "enabled" as const },
    { transport: "direct" as const, vision: "disabled" as const },
  ])("gates $transport/$vision before reading image data", async ({ transport, vision }) => {
    const repository = repositoryFixture();
    dependencyFixture();

    await expect(inspectImageWithCurrentModel({
      repository: repository.repository,
      resourceId: "image-1",
      question: "What is visible?",
      settings: settings(transport),
      capabilities: capabilities(vision),
    })).rejects.toMatchObject({ code: "capability-unavailable" });

    expect(repository.getResource).not.toHaveBeenCalled();
    expect(repository.getResourceBlob).not.toHaveBeenCalled();
    expect(mocks.preprocessImageForVision).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("distinguishes missing and non-image resources without loading their blobs", async () => {
    const missing = repositoryFixture({ missing: true });
    dependencyFixture();
    await expect(inspectImageWithCurrentModel({
      repository: missing.repository,
      resourceId: "missing",
      settings: settings(),
      capabilities: capabilities(),
    })).rejects.toMatchObject({ code: "resource-not-found" });
    expect(missing.getResourceBlob).not.toHaveBeenCalled();

    const nonImage = repositoryFixture({ record: resource("pdf") });
    await expect(inspectImageWithCurrentModel({
      repository: nonImage.repository,
      resourceId: "image-1",
      settings: settings(),
      capabilities: capabilities(),
    })).rejects.toMatchObject({ code: "not-image" });
    expect(nonImage.getResourceBlob).not.toHaveBeenCalled();
  });

  it("rejects a missing image blob before preprocessing", async () => {
    const repository = repositoryFixture();
    repository.getResourceBlob.mockResolvedValueOnce(undefined);
    dependencyFixture();
    await expect(inspectImageWithCurrentModel({
      repository: repository.repository,
      resourceId: "image-1",
      settings: settings(),
      capabilities: capabilities(),
    })).rejects.toMatchObject({ code: "image-data-missing" });
    expect(mocks.preprocessImageForVision).not.toHaveBeenCalled();
  });

  it("returns a stable provider error without echoing credentials", async () => {
    const repository = repositoryFixture();
    dependencyFixture();
    const currentSettings = settings();
    mocks.generateText.mockRejectedValueOnce(new Error(`Authorization failed for ${currentSettings.apiKey}`));

    const inspection = inspectImageWithCurrentModel({
      repository: repository.repository,
      resourceId: "image-1",
      settings: currentSettings,
      capabilities: capabilities(),
    });

    const error: unknown = await inspection.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "inspection-failed",
      message: "The selected model could not inspect this image.",
    });
    expect(error instanceof Error ? error.message : String(error)).not.toContain(currentSettings.apiKey);
  });

  it("uses an image-capable Chrome session with the required schema and always destroys it", async () => {
    const repository = repositoryFixture();
    const { prepared } = dependencyFixture();
    const destroy = vi.fn();
    const prompt = vi.fn(async (
      _input: LanguageModelPrompt,
      _options?: LanguageModelPromptOptions,
    ) => "A clear Chrome analysis.");
    const create = vi.fn(async (_options?: LanguageModelCreateOptions) => ({ prompt, destroy }));
    vi.stubGlobal("LanguageModel", { create });

    await expect(inspectImageWithCurrentModel({
      repository: repository.repository,
      resourceId: "image-1",
      question: "Inspect this image.",
      settings: settings("chrome"),
      capabilities: capabilities("auto"),
      chromeImageInputSupported: true,
    })).resolves.toBe("A clear Chrome analysis.");

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      expectedInputs: [{ type: "image" }, { type: "text" }],
      initialPrompts: [expect.objectContaining({ role: "system" })],
    }));
    expect(prompt).toHaveBeenCalledOnce();
    const chromePrompt = prompt.mock.calls[0]?.[0];
    if (!Array.isArray(chromePrompt)) throw new Error("Expected a multimodal Chrome prompt.");
    expect(chromePrompt).toHaveLength(1);
    expect(chromePrompt[0]).toMatchObject({ role: "user" });
    const chromeContent = chromePrompt[0]?.content;
    if (!Array.isArray(chromeContent)) throw new Error("Expected multimodal Chrome content.");
    const imagePart = chromeContent[0];
    if (!imagePart || typeof imagePart === "string") throw new Error("Expected a Chrome image part.");
    expect(imagePart.type).toBe("image");
    if (!(imagePart.value instanceof ArrayBuffer)) throw new Error("Expected a Chrome image buffer.");
    expect(Array.from(new Uint8Array(imagePart.value))).toEqual(Array.from(prepared.bytes));
    expect(chromeContent[1]).toEqual({ type: "text", value: "Inspect this image." });
    expect(destroy).toHaveBeenCalledOnce();
    expect(mocks.createRemoteLanguageModel).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("destroys the Chrome session when an in-flight inspection is aborted", async () => {
    const repository = repositoryFixture();
    dependencyFixture();
    const controller = new AbortController();
    const destroy = vi.fn();
    const prompt = vi.fn((_input: LanguageModelPrompt, options?: LanguageModelPromptOptions) => new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    }));
    const create = vi.fn(async (_options?: LanguageModelCreateOptions) => ({ prompt, destroy }));
    vi.stubGlobal("LanguageModel", { create });

    const inspection = inspectImageWithCurrentModel({
      repository: repository.repository,
      resourceId: "image-1",
      signal: controller.signal,
      settings: settings("chrome"),
      capabilities: capabilities("auto"),
      chromeImageInputSupported: true,
    });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    controller.abort();

    await expect(inspection).rejects.toMatchObject({ name: "AbortError" });
    expect(destroy).toHaveBeenCalledOnce();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });

  it("does not fall back to a cloud model when Chrome image input is unavailable", async () => {
    vi.stubGlobal("LanguageModel", undefined);
    const repository = repositoryFixture();
    dependencyFixture();
    await expect(inspectImageWithCurrentModel({
      repository: repository.repository,
      resourceId: "image-1",
      settings: settings("chrome"),
      capabilities: capabilities("auto"),
    })).rejects.toMatchObject({ code: "capability-unavailable" });
    expect(mocks.createRemoteLanguageModel).not.toHaveBeenCalled();
    expect(mocks.generateText).not.toHaveBeenCalled();
  });
});
