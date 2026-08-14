import { describe, expect, it } from "vitest";
import { SentenceSegmenter } from "./sentence-segmenter";

describe("SentenceSegmenter", () => {
  it("segments Chinese and English streamed text", () => {
    const segmenter = new SentenceSegmenter();
    expect(segmenter.push("你好！How are")).toEqual(["你好！"]);
    expect(segmenter.push(" you? Fine.")).toEqual(["How are you?", "Fine."]);
  });

  it("flushes an unfinished final sentence", () => {
    const segmenter = new SentenceSegmenter();
    segmenter.push("unfinished");
    expect(segmenter.flush()).toBe("unfinished");
  });
});
