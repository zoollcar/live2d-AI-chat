import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadToOpfs } from "./resumable";

describe("downloadToOpfs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("continues an interrupted file with a byte range request", async () => {
    let bytes = new Uint8Array([1, 2, 3]);
    let position = 0;
    const fileHandle = {
      async getFile() { return new File([bytes], "model.gguf"); },
      async createWritable({ keepExistingData }: { keepExistingData: boolean }) {
        if (!keepExistingData) bytes = new Uint8Array();
        return {
          async seek(next: number) { position = next; },
          async truncate(size: number) { bytes = bytes.slice(0, size); position = size; },
          async write(chunk: Uint8Array) {
            const output = new Uint8Array(Math.max(bytes.length, position + chunk.length));
            output.set(bytes);
            output.set(chunk, position);
            bytes = output;
            position += chunk.length;
          },
          async close() { return undefined; },
        };
      },
    };
    const directoryHandle = {
      async getFileHandle() { return fileHandle; },
    };
    vi.stubGlobal("navigator", {
      storage: {
        async getDirectory() {
          return { async getDirectoryHandle() { return directoryHandle; } };
        },
      },
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "content-length": "6", etag: "model-v1" } });
      }
      expect(new Headers(init?.headers).get("Range")).toBe("bytes=3-");
      return new Response(new Uint8Array([4, 5, 6]), {
        status: 206,
        headers: { "content-range": "bytes 3-5/6", etag: "model-v1" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const progress: number[] = [];
    await downloadToOpfs("cache", "model.gguf", "https://example.com/model.gguf", ({ loaded }) => progress.push(loaded));

    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.at(-1)).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
