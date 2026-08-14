import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface MotionCurve {
  Segments: number[];
}

interface MotionFile {
  Meta: {
    Duration: number;
    Loop: boolean;
    CurveCount: number;
    TotalSegmentCount: number;
    TotalPointCount: number;
  };
  Curves: MotionCurve[];
}

const modelRoot = fileURLToPath(new URL("../../../public/models/ice-girl/", import.meta.url));
const manifest = readJson("model.model3.json") as {
  FileReferences: {
    Moc: string;
    Textures: string[];
    Physics: string;
    DisplayInfo: string;
    Expressions: { File: string }[];
    Motions: Record<string, { File: string }[]>;
  };
  Groups: { Name: string; Ids: string[] }[];
};

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, `file:///${modelRoot.replaceAll("\\", "/")}/`), "utf8"));
}

function countSegments(curve: MotionCurve) {
  let cursor = 2;
  let segments = 0;
  let points = 1;
  while (cursor < curve.Segments.length) {
    const type = curve.Segments[cursor];
    const pointCount = type === 1 ? 3 : 1;
    cursor += type === 1 ? 7 : 3;
    segments += 1;
    points += pointCount;
  }
  expect(cursor).toBe(curve.Segments.length);
  return { segments, points };
}

describe("IceGirl model assets", () => {
  it("references only files that exist", () => {
    const references = [
      manifest.FileReferences.Moc,
      ...manifest.FileReferences.Textures,
      manifest.FileReferences.Physics,
      manifest.FileReferences.DisplayInfo,
      ...manifest.FileReferences.Expressions.map(({ File }) => File),
      ...Object.values(manifest.FileReferences.Motions).flatMap((motions) => motions.map(({ File }) => File)),
    ];
    for (const reference of references) expect(existsSync(`${modelRoot}/${reference}`), reference).toBe(true);
  });

  it("has one subtle idle, one speaking loop, and three one-shot actions", () => {
    const { Idle, Speak, Action } = manifest.FileReferences.Motions;
    expect(Idle).toHaveLength(1);
    expect(Speak).toHaveLength(1);
    expect(Action).toHaveLength(3);
    expect((readJson(Idle![0]!.File) as MotionFile).Meta).toMatchObject({ Duration: 12, Loop: true });
    expect((readJson(Speak![0]!.File) as MotionFile).Meta.Loop).toBe(true);
    for (const action of Action!) {
      const motion = readJson(action.File) as MotionFile;
      expect(motion.Meta.Loop, action.File).toBe(false);
      for (const curve of motion.Curves) {
        expect(curve.Segments.at(-1), action.File).toBe(curve.Segments[1]);
      }
    }
  });

  it("keeps motion metadata consistent with curve data", () => {
    for (const motion of Object.values(manifest.FileReferences.Motions).flat()) {
      const data = readJson(motion.File) as MotionFile;
      const counts = data.Curves.map(countSegments);
      expect(data.Meta.CurveCount, motion.File).toBe(data.Curves.length);
      expect(data.Meta.TotalSegmentCount, motion.File).toBe(counts.reduce((sum, item) => sum + item.segments, 0));
      expect(data.Meta.TotalPointCount, motion.File).toBe(counts.reduce((sum, item) => sum + item.points, 0));
    }
  });

  it("declares the model's lip-sync and blink parameters", () => {
    expect(manifest.Groups).toContainEqual({ Target: "Parameter", Name: "LipSync", Ids: ["ParamMouthOpenY"] });
    expect(manifest.Groups).toContainEqual({ Target: "Parameter", Name: "EyeBlink", Ids: ["ParamEyeLOpen", "ParamEyeROpen"] });
  });
});
