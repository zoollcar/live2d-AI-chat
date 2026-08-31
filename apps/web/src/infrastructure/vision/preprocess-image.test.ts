import { describe, expect, it, vi } from "vitest";
import {
  preprocessImageForVision,
  VISION_MAX_IMAGE_SIDE,
  type VisionImageRasterizer,
} from "./preprocess-image";

function rasterizerFixture(input: {
  width?: number;
  height?: number;
  encodedType?: string;
  encodedText?: string;
} = {}) {
  const close = vi.fn();
  const source = {} as CanvasImageSource;
  const decode = vi.fn(async () => ({
    source,
    width: input.width ?? 4_096,
    height: input.height ?? 2_048,
    close,
  }));
  const encode = vi.fn(async () => new Blob(
    [input.encodedText ?? "sanitized-pixels"],
    { type: input.encodedType ?? "image/webp" },
  ));
  return {
    close,
    decode,
    encode,
    rasterizer: { decode, encode } satisfies VisionImageRasterizer,
  };
}

describe("preprocessImageForVision", () => {
  it("downscales the longest side and re-encodes PNG pixels without original metadata", async () => {
    const fixture = rasterizerFixture();
    const original = new Blob(["pixel-data\0EXIF-private-metadata"], { type: "image/png" });

    const prepared = await preprocessImageForVision(original, "image/png", undefined, fixture.rasterizer);

    expect(fixture.decode).toHaveBeenCalledWith(original, undefined);
    expect(fixture.encode).toHaveBeenCalledWith(
      expect.anything(),
      VISION_MAX_IMAGE_SIDE,
      1_024,
      "image/webp",
      0.86,
      undefined,
    );
    expect(prepared).toMatchObject({
      mediaType: "image/webp",
      width: 2_048,
      height: 1_024,
      originalWidth: 4_096,
      originalHeight: 2_048,
    });
    expect(new TextDecoder().decode(prepared.bytes)).toBe("sanitized-pixels");
    expect(new TextDecoder().decode(prepared.bytes)).not.toContain("EXIF-private-metadata");
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("keeps JPEG as the metadata-free output format without upscaling", async () => {
    const fixture = rasterizerFixture({
      width: 800,
      height: 600,
      encodedType: "image/jpeg",
      encodedText: "jpeg-pixels",
    });

    const prepared = await preprocessImageForVision(
      new Blob(["jpeg-original"], { type: "image/jpeg" }),
      "image/jpeg",
      undefined,
      fixture.rasterizer,
    );

    expect(fixture.encode).toHaveBeenCalledWith(expect.anything(), 800, 600, "image/jpeg", 0.86, undefined);
    expect(prepared).toMatchObject({ mediaType: "image/jpeg", width: 800, height: 600 });
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("rejects unsupported input types before decoding", async () => {
    const fixture = rasterizerFixture();
    await expect(preprocessImageForVision(
      new Blob(["gif"], { type: "image/gif" }),
      "image/gif",
      undefined,
      fixture.rasterizer,
    )).rejects.toMatchObject({ code: "unsupported-image" });
    expect(fixture.decode).not.toHaveBeenCalled();
  });

  it("rejects unsafe decoded dimensions and always releases decoded pixels", async () => {
    const fixture = rasterizerFixture({ width: 12_001, height: 1 });
    await expect(preprocessImageForVision(
      new Blob(["image"], { type: "image/png" }),
      "image/png",
      undefined,
      fixture.rasterizer,
    )).rejects.toMatchObject({ code: "decode-failed" });
    expect(fixture.encode).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
  });

  it("stops before decoding when already aborted", async () => {
    const fixture = rasterizerFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(preprocessImageForVision(
      new Blob(["image"], { type: "image/png" }),
      "image/png",
      controller.signal,
      fixture.rasterizer,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.decode).not.toHaveBeenCalled();
  });
});
