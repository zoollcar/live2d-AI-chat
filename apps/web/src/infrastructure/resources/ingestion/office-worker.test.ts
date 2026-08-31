import { afterEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_LIMITS } from "../limits";
import { extractOfficeAst } from "./office-extraction";
import {
  parseOfficeInWorker,
  type OfficeParserWorkerLike,
} from "./office";

function validatedDocx() {
  return {
    file: new File(["PK"], "notes.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    bytes: new Uint8Array([0x50, 0x4b]),
    kind: "docx" as const,
    extension: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

class FakeOfficeWorker implements OfficeParserWorkerLike {
  onmessage: OfficeParserWorkerLike["onmessage"] = null;
  onerror: OfficeParserWorkerLike["onerror"] = null;
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Office parser worker boundary", () => {
  it("transfers a copied document buffer and returns only serializable extraction data", async () => {
    const worker = new FakeOfficeWorker();
    const parsed = parseOfficeInWorker(validatedDocx(), { conversationId: "conversation" }, () => worker);
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "docx", bytes: expect.any(Uint8Array) }),
      [expect.any(ArrayBuffer)],
    );
    worker.onmessage?.({ data: {
      ok: true,
      extraction: { sections: [{ text: "Safe text" }], metadata: { pageCount: 1 } },
    } } as MessageEvent);

    await expect(parsed).resolves.toEqual({
      sections: [{ text: "Safe text" }],
      metadata: { pageCount: 1 },
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates the worker immediately when resource processing is cancelled", async () => {
    const worker = new FakeOfficeWorker();
    const controller = new AbortController();
    const parsed = parseOfficeInWorker(validatedDocx(), {
      conversationId: "conversation",
      signal: controller.signal,
    }, () => worker);
    controller.abort(new DOMException("Cancelled", "AbortError"));

    await expect(parsed).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("enforces a hard worker deadline", async () => {
    vi.useFakeTimers();
    const worker = new FakeOfficeWorker();
    const parsed = parseOfficeInWorker(validatedDocx(), { conversationId: "conversation" }, () => worker);
    const rejection = expect(parsed).rejects.toThrow("processing time limit");
    await vi.advanceTimersByTimeAsync(RESOURCE_LIMITS.officeProcessingTimeoutMs);

    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects an Office AST that exceeds the content-node ceiling without recursive traversal", async () => {
    const children = Array.from({ length: RESOURCE_LIMITS.maxOfficeNodes + 1 }, () => ({ type: "text" }));
    await expect(extractOfficeAst({
      type: "docx",
      content: children,
      to: async () => ({ value: "" }),
    }, "docx")).rejects.toThrow("too many content nodes");
  });
});
