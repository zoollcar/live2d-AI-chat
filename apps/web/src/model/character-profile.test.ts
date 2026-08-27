import { describe, expect, it } from "vitest";
import { defaultCharacterProfile, parseCharacterProfileJson, serializeCharacterProfile } from "./character-profile";

describe("character profiles", () => {
  it("round-trips the bundled profile", () => {
    expect(parseCharacterProfileJson(serializeCharacterProfile(defaultCharacterProfile))).toEqual(defaultCharacterProfile);
  });

  it("rejects unsupported Live2D models during import", () => {
    const json = JSON.stringify({
      ...defaultCharacterProfile,
      live2d: { ...defaultCharacterProfile.live2d, modelId: "external-model" },
    });
    expect(() => parseCharacterProfileJson(json)).toThrow(/live2d\.modelId/);
  });

  it("rejects conflicting decorations", () => {
    const json = JSON.stringify({
      ...defaultCharacterProfile,
      live2d: { ...defaultCharacterProfile.live2d, defaultDecorations: ["ponytail", "hair-down"] },
    });
    expect(() => parseCharacterProfileJson(json)).toThrow(/hair-down/);
  });
});
