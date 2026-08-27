import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@/model/live2d/catalog";
import { prefixAgentStatus } from "./status-context";

describe("dynamic agent status", () => {
  it("adds time and the current Live2D snapshot only to the supplied newest message", () => {
    const snapshot: SceneSnapshot = {
      modelId: "ice-girl",
      state: "happy",
      decorations: ["crown"],
      layout: "half-body-left",
      viewport: { width: 1280, height: 720 },
    };
    const result = prefixAgentStatus("What time is it?", snapshot, new Date(2026, 7, 27, 17, 45, 0));

    expect(result).toContain("current_time: 2026-08-27 17:45:00");
    expect(result).toContain("character_state: happy");
    expect(result).toContain('decorations: ["crown"]');
    expect(result).toContain("<user_message>\nWhat time is it?\n</user_message>");
  });
});
