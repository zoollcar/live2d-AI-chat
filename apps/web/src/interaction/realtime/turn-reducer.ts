import type { GoogleLiveSessionEvent } from "./types";

export interface GoogleLiveTurnState {
  inputTranscript: string;
  interimInputTranscript: string;
  outputTranscript: string;
  generationComplete: boolean;
  interrupted: boolean;
}

export interface GoogleLiveCompletedTurn {
  inputTranscript: string;
  outputTranscript: string;
  generationComplete: boolean;
  interrupted: boolean;
}

export interface GoogleLiveTurnReduction {
  state: GoogleLiveTurnState;
  completed?: GoogleLiveCompletedTurn;
}

export function createGoogleLiveTurnState(): GoogleLiveTurnState {
  return {
    inputTranscript: "",
    interimInputTranscript: "",
    outputTranscript: "",
    generationComplete: false,
    interrupted: false,
  };
}

/**
 * Reduces independently ordered transcript and lifecycle events into a turn
 * that is safe to persist only after `turn-complete`.
 */
export function reduceGoogleLiveTurn(
  state: GoogleLiveTurnState,
  event: GoogleLiveSessionEvent,
): GoogleLiveTurnReduction {
  switch (event.type) {
    case "input-transcript":
      if (event.interim) {
        return { state: { ...state, interimInputTranscript: event.text } };
      }
      return {
        state: {
          ...state,
          inputTranscript: appendGoogleLiveTranscript(state.inputTranscript, event.text),
          interimInputTranscript: "",
        },
      };
    case "output-transcript":
      return {
        state: {
          ...state,
          outputTranscript: appendGoogleLiveTranscript(state.outputTranscript, event.text),
        },
      };
    case "generation-complete":
      return { state: { ...state, generationComplete: true } };
    case "interrupted":
      return { state: { ...state, interrupted: true, generationComplete: false } };
    case "turn-complete": {
      const completed: GoogleLiveCompletedTurn = {
        inputTranscript: state.inputTranscript || state.interimInputTranscript,
        outputTranscript: state.outputTranscript,
        generationComplete: state.generationComplete,
        interrupted: state.interrupted,
      };
      return { state: createGoogleLiveTurnState(), completed };
    }
    default:
      return { state };
  }
}

/**
 * Gemini may emit either deltas or a cumulative revision. Preserve deltas but
 * avoid duplicating the overlapping text from cumulative transcript updates.
 */
export function appendGoogleLiveTranscript(current: string, update: string): string {
  if (!update) return current;
  if (!current) return update;
  if (update.startsWith(current)) return update;
  if (current.endsWith(update)) return current;

  const maxOverlap = Math.min(current.length, update.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(update.slice(0, overlap))) {
      return current + update.slice(overlap);
    }
  }
  return current + update;
}
