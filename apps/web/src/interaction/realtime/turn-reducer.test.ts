import { describe, expect, it } from "vitest";
import {
  appendGoogleLiveTranscript,
  createGoogleLiveTurnState,
  reduceGoogleLiveTurn,
} from "./turn-reducer";

describe("Google Live turn reducer", () => {
  it("merges cumulative revisions and overlapping transcript deltas", () => {
    expect(appendGoogleLiveTranscript("", "Hello")).toBe("Hello");
    expect(appendGoogleLiveTranscript("Hel", "Hello")).toBe("Hello");
    expect(appendGoogleLiveTranscript("Hello wor", "world")).toBe("Hello world");
    expect(appendGoogleLiveTranscript("Hello", " there")).toBe("Hello there");
    expect(appendGoogleLiveTranscript("Hello", "Hello")).toBe("Hello");
  });

  it("waits for turn-complete before yielding an interrupted partial turn", () => {
    let state = createGoogleLiveTurnState();
    state = reduceGoogleLiveTurn(state, {
      type: "output-transcript",
      text: "Partial reply",
    }).state;
    state = reduceGoogleLiveTurn(state, {
      type: "input-transcript",
      text: "interim question",
      interim: true,
    }).state;
    state = reduceGoogleLiveTurn(state, { type: "interrupted" }).state;
    const reduction = reduceGoogleLiveTurn(state, { type: "turn-complete" });
    expect(reduction.completed).toEqual({
      inputTranscript: "interim question",
      outputTranscript: "Partial reply",
      generationComplete: false,
      interrupted: true,
    });
    expect(reduction.state).toEqual(createGoogleLiveTurnState());
  });

  it("prefers finalized input and records generation completion", () => {
    let state = createGoogleLiveTurnState();
    state = reduceGoogleLiveTurn(state, {
      type: "input-transcript",
      text: "draft",
      interim: true,
    }).state;
    state = reduceGoogleLiveTurn(state, {
      type: "input-transcript",
      text: "final",
      interim: false,
    }).state;
    state = reduceGoogleLiveTurn(state, { type: "generation-complete" }).state;
    const reduction = reduceGoogleLiveTurn(state, { type: "turn-complete" });
    expect(reduction.completed).toEqual({
      inputTranscript: "final",
      outputTranscript: "",
      generationComplete: true,
      interrupted: false,
    });
  });
});
