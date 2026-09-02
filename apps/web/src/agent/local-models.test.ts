import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadToOpfs: vi.fn(),
  getPartialDownloadProgress: vi.fn(),
  getModels: vi.fn(),
  writeMetadata: vi.fn(),
}));

vi.mock("@wllama/wllama", () => ({
  getHFModelSource: vi.fn(async () => ({ url: "https://example.com/model.gguf" })),
  ModelValidationStatus: { VALID: "valid" },
  ModelManager: class {
    static parseModelUrl(url: string) {
      return [url];
    }

    cacheManager = {
      getNameFromURL: vi.fn(async () => "model.gguf"),
      writeMetadata: mocks.writeMetadata,
    };

    getModels = mocks.getModels;
  },
}));

vi.mock("@/infrastructure/download/resumable", () => ({
  downloadToOpfs: mocks.downloadToOpfs,
  getPartialDownloadProgress: mocks.getPartialDownloadProgress,
}));

import { downloadLocalModel } from "./local-models";

describe("downloadLocalModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getModels.mockResolvedValue([]);
    mocks.getPartialDownloadProgress.mockResolvedValue({ loaded: 0, total: 6 });
  });

  it("preserves the server ETag verbatim in cache metadata", async () => {
    mocks.downloadToOpfs.mockResolvedValue({ total: 6, etag: 'W/"model-v1"' });

    await downloadLocalModel("unsloth/Qwen3.5-0.8B-GGUF", vi.fn());

    expect(mocks.writeMetadata).toHaveBeenCalledWith("model.gguf", {
      originalURL: "https://example.com/model.gguf",
      originalSize: 6,
      etag: 'W/"model-v1"',
    });
  });
});
