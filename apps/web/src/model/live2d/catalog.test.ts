import { describe, expect, it } from "vitest";
import manifest from "../../../public/models/ice-girl/model.model3.json";
import { live2dCatalog } from "./catalog";

describe("Live2D catalog", () => {
  it("maps a stable app identity to a valid model manifest", () => {
    expect(live2dCatalog).toMatchObject({ id: "ice-girl", name: "Default Model" });
    expect(manifest.FileReferences.Moc).toBe("IceGirl.moc3");
    expect(manifest.FileReferences.Motions.Idle).toHaveLength(1);
    expect(manifest.FileReferences.Motions.Speak).toHaveLength(1);
    expect(manifest.FileReferences.Motions.Action).toHaveLength(3);
    expect(live2dCatalog.actions).toEqual({
      wink: { group: "Action", index: 0 },
      wave: { group: "Action", index: 1 },
      think: { group: "Action", index: 2 },
    });
  });

  it("declares persistent behavioral states that map to existing motion groups", () => {
    expect(live2dCatalog.states.neutral.motionGroup).toBe("StateNeutral");
    expect(manifest.FileReferences.Motions.StateNeutral).toBeDefined();

    const sleepingParams = live2dCatalog.states.sleeping.parameters;
    expect(sleepingParams).toContainEqual({ id: "ParamEyeLOpen", value: 0 });
    expect(sleepingParams).toContainEqual({ id: "ParamEyeROpen", value: 0 });
    expect(live2dCatalog.states.sleeping.blinkInterval).toEqual([0, 0]);
  });
});
