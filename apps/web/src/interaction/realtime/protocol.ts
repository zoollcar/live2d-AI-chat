import { GoogleLiveProtocolError, GoogleLiveSessionError } from "./errors";
import {
  GOOGLE_LIVE_DEFAULT_VOICE,
  GOOGLE_LIVE_INPUT_SAMPLE_RATE,
  GOOGLE_LIVE_MODEL_ID,
  type GoogleLiveActivityHandling,
  type GoogleLiveFunctionDeclaration,
  type GoogleLiveHistoryMessage,
} from "./types";

const GOOGLE_LIVE_WEBSOCKET_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/" +
  "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface GoogleLiveSetupOptions {
  apiKey: string;
  modelId?: string;
  systemInstruction?: string;
  voiceName?: string;
  activityHandling: GoogleLiveActivityHandling;
  functionDeclarations?: GoogleLiveFunctionDeclaration[];
  resumeHandle?: string;
  initialHistory?: boolean;
}

export interface GoogleLiveTranscription {
  text: string;
  languageCode?: string;
}

export interface GoogleLiveModelPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    data: string;
    mimeType?: string;
  };
}

export interface GoogleLiveFunctionCall {
  id: string;
  name: string;
  args: unknown;
}

export interface GoogleLiveServerMessage {
  setupComplete?: true;
  serverContent?: {
    modelTurnParts: GoogleLiveModelPart[];
    inputTranscription?: GoogleLiveTranscription;
    interimInputTranscription?: GoogleLiveTranscription;
    outputTranscription?: GoogleLiveTranscription;
    generationComplete: boolean;
    turnComplete: boolean;
    interrupted: boolean;
  };
  toolCalls?: GoogleLiveFunctionCall[];
  toolCallCancellation?: string[];
  goAway?: { timeLeft?: unknown };
  sessionResumptionUpdate?: {
    resumable: boolean;
    newHandle?: string;
  };
  usageMetadata?: Record<string, unknown>;
}

export function buildGoogleLiveWebSocketUrl(apiKey: string): string {
  if (!apiKey.trim()) {
    throw new GoogleLiveSessionError(
      "INVALID_CONFIG",
      "A Google Gemini API key is required for Live API.",
    );
  }
  return `${GOOGLE_LIVE_WEBSOCKET_ENDPOINT}?key=${encodeURIComponent(apiKey.trim())}`;
}

export function buildGoogleLiveSetupMessage(options: GoogleLiveSetupOptions): Record<string, unknown> {
  const modelId = options.modelId?.trim() || GOOGLE_LIVE_MODEL_ID;
  const setup: Record<string, unknown> = {
    model: modelId.startsWith("models/") ? modelId : `models/${modelId}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: options.voiceName?.trim() || GOOGLE_LIVE_DEFAULT_VOICE,
          },
        },
      },
    },
    realtimeInputConfig: {
      activityHandling: options.activityHandling,
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: options.resumeHandle ? { handle: options.resumeHandle } : {},
  };

  if (options.systemInstruction?.trim()) {
    setup.systemInstruction = {
      parts: [{ text: options.systemInstruction.trim() }],
    };
  }
  if (options.functionDeclarations?.length) {
    setup.tools = [{ functionDeclarations: options.functionDeclarations }];
  }
  // Initial client content is only legal when creating a fresh Gemini 3.1
  // session. A resumed connection already owns its conversation context.
  if (!options.resumeHandle && options.initialHistory) {
    setup.historyConfig = { initialHistoryInClientContent: true };
  }

  return { setup };
}

export function buildGoogleLiveHistorySeed(
  history: readonly GoogleLiveHistoryMessage[],
): Record<string, unknown> {
  return {
    clientContent: {
      turns: history.map((message) => ({
        role: message.role === "assistant" ? "model" : message.role,
        parts: [{ text: message.text }],
      })),
      turnComplete: true,
    },
  };
}

export function buildGoogleLiveTextInput(text: string): Record<string, unknown> {
  if (!text.trim()) {
    throw new GoogleLiveSessionError(
      "INVALID_CONFIG",
      "Realtime text input must not be empty.",
    );
  }
  return { realtimeInput: { text } };
}

export function buildGoogleLiveAudioInput(pcm16: Int16Array): Record<string, unknown> {
  if (pcm16.length === 0) {
    throw new GoogleLiveSessionError(
      "INVALID_CONFIG",
      "Realtime audio input must contain at least one PCM16 sample.",
    );
  }
  return {
    realtimeInput: {
      audio: {
        data: encodePcm16Base64(pcm16),
        mimeType: `audio/pcm;rate=${GOOGLE_LIVE_INPUT_SAMPLE_RATE}`,
      },
    },
  };
}

export function buildGoogleLiveAudioStreamEnd(): Record<string, unknown> {
  return { realtimeInput: { audioStreamEnd: true } };
}

export function buildGoogleLiveToolResponse(
  id: string,
  name: string,
  output: unknown,
): Record<string, unknown> {
  return {
    toolResponse: {
      functionResponses: [{ id, name, response: toJsonValue(output) }],
    },
  };
}

export function encodePcm16Base64(pcm16: Int16Array): string {
  const bytes = new Uint8Array(pcm16.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < pcm16.length; index += 1) {
    view.setInt16(index * 2, pcm16[index]!, true);
  }
  return bytesToBase64(bytes);
}

export function decodePcm16Base64(data: string): Int16Array {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(data);
  } catch (error) {
    throw new GoogleLiveProtocolError("Gemini returned invalid base64 audio data.", { cause: error });
  }
  if (bytes.byteLength % 2 !== 0) {
    throw new GoogleLiveProtocolError("Gemini returned an odd-length PCM16 audio chunk.");
  }
  const pcm16 = new Int16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < pcm16.length; index += 1) {
    pcm16[index] = view.getInt16(index * 2, true);
  }
  return pcm16;
}

export async function parseGoogleLiveServerMessage(data: unknown): Promise<GoogleLiveServerMessage> {
  const text = await websocketDataToText(data);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new GoogleLiveProtocolError("Gemini returned a non-JSON WebSocket message.", {
      cause: error,
    });
  }
  const message = requireRecord(value, "Gemini WebSocket message");
  const parsed: GoogleLiveServerMessage = {};
  let recognized = false;

  if ("setupComplete" in message) {
    requireRecord(message.setupComplete, "setupComplete");
    parsed.setupComplete = true;
    recognized = true;
  }
  if ("serverContent" in message) {
    parsed.serverContent = parseServerContent(message.serverContent);
    recognized = true;
  }
  if ("toolCall" in message) {
    parsed.toolCalls = parseToolCalls(message.toolCall);
    recognized = true;
  }
  if ("toolCallCancellation" in message) {
    const cancellation = requireRecord(message.toolCallCancellation, "toolCallCancellation");
    parsed.toolCallCancellation = requireStringArray(cancellation.ids, "toolCallCancellation.ids");
    recognized = true;
  }
  if ("goAway" in message) {
    const goAway = requireRecord(message.goAway, "goAway");
    parsed.goAway = { timeLeft: goAway.timeLeft };
    recognized = true;
  }
  if ("sessionResumptionUpdate" in message) {
    const update = requireRecord(message.sessionResumptionUpdate, "sessionResumptionUpdate");
    if (typeof update.resumable !== "boolean") {
      throw new GoogleLiveProtocolError("sessionResumptionUpdate.resumable must be a boolean.");
    }
    if (update.newHandle !== undefined && typeof update.newHandle !== "string") {
      throw new GoogleLiveProtocolError("sessionResumptionUpdate.newHandle must be a string.");
    }
    parsed.sessionResumptionUpdate = {
      resumable: update.resumable,
      newHandle: update.newHandle as string | undefined,
    };
    recognized = true;
  }
  if ("usageMetadata" in message) {
    parsed.usageMetadata = requireRecord(message.usageMetadata, "usageMetadata");
    recognized = true;
  }
  if (!recognized) {
    throw new GoogleLiveProtocolError("Gemini returned an unknown WebSocket message type.");
  }
  return parsed;
}

function parseServerContent(value: unknown): NonNullable<GoogleLiveServerMessage["serverContent"]> {
  const content = requireRecord(value, "serverContent");
  const modelTurnParts: GoogleLiveModelPart[] = [];
  if (content.modelTurn !== undefined) {
    const modelTurn = requireRecord(content.modelTurn, "serverContent.modelTurn");
    if (modelTurn.parts !== undefined) {
      if (!Array.isArray(modelTurn.parts)) {
        throw new GoogleLiveProtocolError("serverContent.modelTurn.parts must be an array.");
      }
      for (const [index, partValue] of modelTurn.parts.entries()) {
        const part = requireRecord(partValue, `serverContent.modelTurn.parts[${index}]`);
        const parsedPart: GoogleLiveModelPart = {};
        if (part.text !== undefined) {
          if (typeof part.text !== "string") {
            throw new GoogleLiveProtocolError(`serverContent.modelTurn.parts[${index}].text must be a string.`);
          }
          parsedPart.text = part.text;
        }
        if (part.thought !== undefined) {
          if (typeof part.thought !== "boolean") {
            throw new GoogleLiveProtocolError(`serverContent.modelTurn.parts[${index}].thought must be a boolean.`);
          }
          parsedPart.thought = part.thought;
        }
        if (part.inlineData !== undefined) {
          const inlineData = requireRecord(
            part.inlineData,
            `serverContent.modelTurn.parts[${index}].inlineData`,
          );
          if (typeof inlineData.data !== "string") {
            throw new GoogleLiveProtocolError(
              `serverContent.modelTurn.parts[${index}].inlineData.data must be a string.`,
            );
          }
          if (inlineData.mimeType !== undefined && typeof inlineData.mimeType !== "string") {
            throw new GoogleLiveProtocolError(
              `serverContent.modelTurn.parts[${index}].inlineData.mimeType must be a string.`,
            );
          }
          parsedPart.inlineData = {
            data: inlineData.data,
            mimeType: inlineData.mimeType as string | undefined,
          };
        }
        modelTurnParts.push(parsedPart);
      }
    }
  }
  return {
    modelTurnParts,
    inputTranscription: parseOptionalTranscription(content.inputTranscription, "inputTranscription"),
    interimInputTranscription: parseOptionalTranscription(
      content.interimInputTranscription,
      "interimInputTranscription",
    ),
    outputTranscription: parseOptionalTranscription(content.outputTranscription, "outputTranscription"),
    generationComplete: optionalBoolean(content.generationComplete, "generationComplete"),
    turnComplete: optionalBoolean(content.turnComplete, "turnComplete"),
    interrupted: optionalBoolean(content.interrupted, "interrupted"),
  };
}

function parseToolCalls(value: unknown): GoogleLiveFunctionCall[] {
  const toolCall = requireRecord(value, "toolCall");
  if (!Array.isArray(toolCall.functionCalls)) {
    throw new GoogleLiveProtocolError("toolCall.functionCalls must be an array.");
  }
  return toolCall.functionCalls.map((callValue, index) => {
    const call = requireRecord(callValue, `toolCall.functionCalls[${index}]`);
    if (typeof call.id !== "string" || !call.id) {
      throw new GoogleLiveProtocolError(`toolCall.functionCalls[${index}].id must be a non-empty string.`);
    }
    if (typeof call.name !== "string" || !call.name) {
      throw new GoogleLiveProtocolError(`toolCall.functionCalls[${index}].name must be a non-empty string.`);
    }
    return { id: call.id, name: call.name, args: call.args ?? {} };
  });
}

function parseOptionalTranscription(
  value: unknown,
  field: string,
): GoogleLiveTranscription | undefined {
  if (value === undefined) return undefined;
  const transcription = requireRecord(value, `serverContent.${field}`);
  if (typeof transcription.text !== "string") {
    throw new GoogleLiveProtocolError(`serverContent.${field}.text must be a string.`);
  }
  if (transcription.languageCode !== undefined && typeof transcription.languageCode !== "string") {
    throw new GoogleLiveProtocolError(`serverContent.${field}.languageCode must be a string.`);
  }
  return {
    text: transcription.text,
    languageCode: transcription.languageCode as string | undefined,
  };
}

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new GoogleLiveProtocolError(`serverContent.${field} must be a boolean.`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoogleLiveProtocolError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new GoogleLiveProtocolError(`${field} must be an array of strings.`);
  }
  return value as string[];
}

async function websocketDataToText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }
  throw new GoogleLiveProtocolError("Gemini returned an unsupported WebSocket frame type.");
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch (error) {
    throw new GoogleLiveProtocolError("Tool output must be JSON serializable.", { cause: error });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
