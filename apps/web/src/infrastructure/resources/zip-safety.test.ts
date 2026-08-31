import { Zip, ZipDeflate } from "fflate";
import { describe, expect, it } from "vitest";
import {
  inspectZipArchive,
  verifyZipArchiveContents,
  type ZipValidationWorker,
} from "./zip-safety";

function centralDirectoryOnlyZip(
  path: string,
  compressedSize = 1,
  uncompressedSize = 1,
  compressionMethod = 0,
): Uint8Array {
  const name = new TextEncoder().encode(path);
  const local = new Uint8Array(30 + name.length + compressedSize);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint16(8, compressionMethod, true);
  localView.setUint32(18, compressedSize, true);
  localView.setUint32(22, uncompressedSize, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint16(10, compressionMethod, true);
  centralView.setUint32(20, compressedSize, true);
  centralView.setUint32(24, uncompressedSize, true);
  centralView.setUint16(28, name.length, true);
  central.set(name, 46);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, 1, true);
  eocdView.setUint16(10, 1, true);
  eocdView.setUint32(12, central.byteLength, true);
  eocdView.setUint32(16, local.byteLength, true);
  const archive = new Uint8Array(local.byteLength + central.byteLength + eocd.byteLength);
  archive.set(local);
  archive.set(central, local.byteLength);
  archive.set(eocd, local.byteLength + central.byteLength);
  return archive;
}

function findSignature(bytes: Uint8Array, signature: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error(`ZIP signature ${signature.toString(16)} was not found.`);
}

function streamingDeflateZip(path: string, data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let result: Uint8Array | undefined;
  const archive = new Zip((error, chunk, final) => {
    if (error) throw error;
    chunks.push(chunk);
    if (final) {
      const size = chunks.reduce((total, current) => total + current.byteLength, 0);
      result = new Uint8Array(size);
      let offset = 0;
      for (const current of chunks) {
        result.set(current, offset);
        offset += current.byteLength;
      }
    }
  });
  const entry = new ZipDeflate(path, { level: 9 });
  archive.add(entry);
  entry.push(data, true);
  archive.end();
  if (!result) throw new Error("The streaming ZIP fixture did not finish synchronously.");
  return result;
}

class HangingWorker implements ZipValidationWorker {
  onmessage: ((event: MessageEvent<unknown>) => unknown) | null = null;
  onerror: ((event: ErrorEvent) => unknown) | null = null;
  terminated = false;

  postMessage(): void {}

  terminate(): void {
    this.terminated = true;
  }
}

describe("inspectZipArchive", () => {
  it("reports bounded central-directory metadata", () => {
    expect(inspectZipArchive(centralDirectoryOnlyZip("resources/r/original.txt"))).toMatchObject({
      compressedBytes: 1,
      uncompressedBytes: 1,
      entries: [{ path: "resources/r/original.txt" }],
    });
  });

  it("rejects traversal paths before decompression", () => {
    expect(() => inspectZipArchive(centralDirectoryOnlyZip("../outside.txt"))).toThrow("unsafe path");
  });

  it("rejects suspicious compression ratios", () => {
    expect(() => inspectZipArchive(centralDirectoryOnlyZip("large.txt", 1, 2 * 1024 * 1024, 8))).toThrow(
      "suspicious compression ratio",
    );
  });

  it("rejects central sizes that disagree with a local header", () => {
    const archive = centralDirectoryOnlyZip("mismatch.txt", 4, 4);
    const centralOffset = findSignature(archive, 0x02014b50);
    new DataView(archive.buffer).setUint32(centralOffset + 24, 3, true);
    expect(() => inspectZipArchive(archive)).toThrow("mismatched local and central sizes");
  });

  it("counts actual raw-DEFLATE output even when descriptor and central sizes are forged", async () => {
    const archive = streamingDeflateZip("forged.txt", new Uint8Array(2 * 1024 * 1024).fill(65));
    const view = new DataView(archive.buffer);
    const descriptorOffset = findSignature(archive, 0x08074b50);
    const centralOffset = findSignature(archive, 0x02014b50);
    view.setUint32(descriptorOffset + 12, 1, true);
    view.setUint32(centralOffset + 24, 1, true);

    const inspection = inspectZipArchive(archive);
    await expect(verifyZipArchiveContents(archive, inspection)).rejects.toThrow(
      "expanded beyond its declared size",
    );
  });

  it("validates streaming data descriptors and CRC-32 before a parser sees the ZIP", async () => {
    const payload = new Uint8Array(64 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < payload.byteLength; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      payload[index] = state >>> 24;
    }
    const archive = streamingDeflateZip("valid.bin", payload);
    const inspection = inspectZipArchive(archive);
    await expect(verifyZipArchiveContents(archive, inspection)).resolves.toEqual(archive);

    const tampered = archive.slice();
    const descriptorOffset = findSignature(tampered, 0x08074b50);
    const centralOffset = findSignature(tampered, 0x02014b50);
    const forgedCrc = 0x12345678;
    const tamperedView = new DataView(tampered.buffer);
    tamperedView.setUint32(descriptorOffset + 4, forgedCrc, true);
    tamperedView.setUint32(centralOffset + 16, forgedCrc, true);
    const tamperedInspection = inspectZipArchive(tampered);
    await expect(verifyZipArchiveContents(tampered, tamperedInspection)).rejects.toThrow("CRC-32");
  });

  it("terminates an isolated validator on timeout and cancellation", async () => {
    const archive = centralDirectoryOnlyZip("small.txt");
    const inspection = inspectZipArchive(archive);
    const timeoutWorker = new HangingWorker();
    await expect(verifyZipArchiveContents(archive, inspection, undefined, {
      timeoutMs: 5,
      workerFactory: () => timeoutWorker,
    })).rejects.toThrow("processing time limit");
    expect(timeoutWorker.terminated).toBe(true);

    const cancelWorker = new HangingWorker();
    const controller = new AbortController();
    const pending = verifyZipArchiveContents(archive, inspection, undefined, {
      signal: controller.signal,
      workerFactory: () => cancelWorker,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled" });
    expect(cancelWorker.terminated).toBe(true);
  });
});
