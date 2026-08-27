// Lightweight tagged logger that prefixes every line with a timestamp and the
// subsystem name. Everything is rendered as a single-line plain string so the
// output copies cleanly out of DevTools — Chrome's default console.log expands
// objects inline as `Object { … }` which is unreadable when pasted back into
// chat. The formatter covers primitives, arrays, plain objects, Errors and
// SpeechRecognitionEvent-shaped events.
export function createLogger(tag: string) {
  const prefix = `[${tag}]`;
  return {
    debug(message: string, ...details: unknown[]) {
      console.log(`${stamp()} ${prefix} ${message} ${formatDetails(details)}`.trimEnd());
    },
    info(message: string, ...details: unknown[]) {
      console.info(`${stamp()} ${prefix} ${message} ${formatDetails(details)}`.trimEnd());
    },
    warn(message: string, ...details: unknown[]) {
      console.warn(`${stamp()} ${prefix} ${message} ${formatDetails(details)}`.trimEnd());
    },
    error(message: string, ...details: unknown[]) {
      console.error(`${stamp()} ${prefix} ${message} ${formatDetails(details)}`.trimEnd());
    },
  };
}

function stamp() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatDetails(details: unknown[]): string {
  if (details.length === 0) return "";
  return details.map(formatValue).join(" | ");
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
  if (Array.isArray(value)) {
    // Truncate very long arrays (e.g. Recognition result lists) so logs stay
    // copyable but still convey the length and a sample.
    const sample = value.slice(0, 6).map(formatValue).join(", ");
    const overflow = value.length > 6 ? `, …+${value.length - 6} more` : "";
    return `[${sample}${overflow}]`;
  }
  if (typeof value === "object") {
    // Plain-ish objects: surface the keys the reader cares about. Speech
    // recognition events expose resultIndex/results; handle the common cases
    // explicitly so the output reads as a sentence rather than a dump.
    const record = value as Record<string, unknown>;
    if ("resultIndex" in record && "results" in record) {
      const results = record.results as { length: number };
      const first = (record.results as ArrayLike<unknown>)[record.resultIndex as number] as Record<string, unknown> | undefined;
      return `SpeechRecognitionEvent(resultIndex=${record.resultIndex}, resultCount=${results.length}, firstIsFinal=${first?.isFinal}, firstTranscript=${formatTranscript(first?.[0])})`;
    }
    if ("error" in record || "message" in record) {
      return `SpeechRecognitionError(error=${formatValue(record.error)}, message=${formatValue(record.message)})`;
    }
    const entries = Object.entries(record).map(([key, val]) => `${key}=${formatValue(val)}`);
    if (entries.length === 0) return "{}";
    return `{ ${entries.join(", ")} }`;
  }
  return String(value);
}

function formatTranscript(entry: unknown): string {
  if (!entry || typeof entry !== "object") return String(entry ?? "");
  const alt = entry as Record<string, unknown>;
  const transcript = typeof alt.transcript === "string" ? alt.transcript : "";
  const confidence = typeof alt.confidence === "number" ? alt.confidence.toFixed(2) : "?";
  // Keep the transcript itself on one line; escape newlines so log stays
  // single-line.
  return `"${transcript.replace(/\s+/g, " ").slice(0, 80)}" (conf=${confidence})`;
}
