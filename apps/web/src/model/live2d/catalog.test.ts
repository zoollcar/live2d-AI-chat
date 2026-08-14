import { describe, expect, it } from "vitest";
import manifest from "../../../public/models/ice-girl/model.model3.json";
import { live2dCatalog } from "./catalog";

describe("Live2D catalog", () => {
  it("maps a stable app identity to a valid model manifest", () => {
    expect(live2dCatalog).toMatchObject({ id: "ice-girl", name: "Default Model" });
    expect(manifest.FileReferences.Moc).toBe("IceGirl.moc3");
    expect(manifest.FileReferences.Motions.Action).toHaveLength(2);
  });
});
