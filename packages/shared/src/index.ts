import { z } from "zod";

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.unknown(),
}).passthrough();

export const chatCompletionRequestSchema = z.object({
  model: z.string().trim().min(1),
  messages: z.array(chatMessageSchema).min(1),
  stream: z.boolean().optional(),
}).passthrough();

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export type RemoteTransport = "direct" | "extension";
export type LlmTransport = RemoteTransport | "local" | "chrome";

export interface LlmSettings {
  transport: LlmTransport;
  baseUrl: string;
  apiKey: string;
  rememberApiKey: boolean;
  modelId: string;
}

export type SttProviderId = "web-speech" | "openai-compatible";
export type SpeechServiceTransport = RemoteTransport;
export interface SttSettings {
  provider: SttProviderId;
  transport: SpeechServiceTransport;
  baseUrl: string;
  apiKey: string;
  rememberApiKey: boolean;
  modelId: string;
  language: string;
  /**
   * Compatibility mirror for providers that still configure their native
   * recognition session from STT settings. User-facing control lives in
   * `AppSettings.voiceInteraction.handsFree`.
   */
  continuous: boolean;
}

export type TtsProviderId = "vits-local" | "browser-speech" | "openai-compatible" | "google-cloud";
export interface TtsSettings {
  provider: TtsProviderId;
  transport: SpeechServiceTransport;
  baseUrl: string;
  apiKey: string;
  rememberApiKey: boolean;
  modelId: string;
  voice: string;
  language: string;
  rate: number;
  pitch: number;
}

export type VoiceRoute = "classic" | "realtime";

export type RealtimeProviderId = "google";

export interface GoogleRealtimeSettings {
  modelId: string;
  voiceName: string;
  apiKey: string;
  rememberApiKey: boolean;
}

export interface RealtimeSettings {
  provider: RealtimeProviderId;
  google: GoogleRealtimeSettings;
}

export interface VoiceInteractionSettings {
  handsFree: boolean;
  allowVoiceInterruption: boolean;
}

export type WebContentProvider = "exa" | "extension-reader";
export type VideoTranscriptProvider = "supadata";
export type VisionCapability = "auto" | "enabled" | "disabled";

export interface ProviderSecretSettings {
  apiKey: string;
  rememberApiKey: boolean;
}

export interface ContentProviderSettings {
  webProvider: WebContentProvider;
  webTransport: RemoteTransport;
  videoTranscriptProvider: VideoTranscriptProvider;
  videoTransport: RemoteTransport;
  exa: ProviderSecretSettings;
  supadata: ProviderSecretSettings;
}

export interface ModelCapabilitySettings {
  /**
   * `auto` uses the built-in provider catalogue. `enabled` and `disabled`
   * are explicit overrides for custom OpenAI-compatible models.
   */
  vision: VisionCapability;
}

export type ResourceKind =
  | "pdf"
  | "docx"
  | "pptx"
  | "text"
  | "image"
  | "svg"
  | "web"
  | "video-transcript";

export type ResourceStatus = "pending" | "processing" | "ready" | "error";

export interface ResourceRef {
  id: string;
  kind: ResourceKind;
  name: string;
  mediaType: string;
  size: number;
  status: ResourceStatus;
}

export type ArtifactKind = "resource-view" | "svg-drawing" | "sticker";

export const stickerIds = [
  "ice-girl-joy",
  "ice-girl-laugh",
  "ice-girl-love",
  "ice-girl-shy",
  "ice-girl-surprised",
  "ice-girl-confused",
  "ice-girl-angry",
  "ice-girl-sad",
  "ice-girl-crying",
  "ice-girl-proud",
  "ice-girl-sleepy",
  "ice-girl-cheering",
] as const;
export type StickerId = (typeof stickerIds)[number];

export interface ArtifactRef {
  id: string;
  resourceId: string;
  kind: ArtifactKind;
}

export const resourceRefSchema: z.ZodType<ResourceRef> = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["pdf", "docx", "pptx", "text", "image", "svg", "web", "video-transcript"]),
  name: z.string().trim().min(1).max(500),
  mediaType: z.string().trim().min(1).max(200),
  size: z.number().int().nonnegative(),
  status: z.enum(["pending", "processing", "ready", "error"]),
}).strict();

export const artifactRefSchema: z.ZodType<ArtifactRef> = z.object({
  id: z.string().trim().min(1).max(200),
  resourceId: z.string().trim().min(1).max(200),
  kind: z.enum(["resource-view", "svg-drawing", "sticker"]),
}).strict();

export interface AppSettings {
  version: 4;
  voiceRoute: VoiceRoute;
  voiceInteraction: VoiceInteractionSettings;
  llm: LlmSettings;
  stt: SttSettings;
  tts: TtsSettings;
  realtime: RealtimeSettings;
  content: ContentProviderSettings;
  capabilities: ModelCapabilitySettings;
  subtitlesEnabled: boolean;
}

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const BRIDGE_CHUNK_BYTES = 256 * 1024;

export const bridgeOperationIds = [
  "models",
  "chat",
  "transcribe",
  "synthesize",
  "vision",
  "exa",
  "supadata",
  "read-page",
] as const;
export type BridgeOperation = (typeof bridgeOperationIds)[number];

export const bridgeProviderIds = [
  "openai-compatible",
  "openai",
  "openrouter",
  "minimax",
  "google",
  "google-cloud",
  "exa",
  "supadata",
  "extension-reader",
] as const;
export type BridgeProvider = (typeof bridgeProviderIds)[number];

export type ExtensionConnectionStatus =
  | "checking"
  | "not-detected"
  | "ready"
  | "outdated"
  | "permission-required"
  | "permission-denied"
  | "disconnected"
  | "error";

export interface ExtensionConnectionState {
  status: ExtensionConnectionStatus;
  extensionVersion?: string;
  protocolVersion?: number;
  capabilities: BridgeOperation[];
  grantedOrigins: string[];
  requiredOrigin?: string;
  error?: string;
}

const bridgeRequestIdSchema = z.string().trim().min(1).max(200);
const bridgeNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
const bridgeCredentialSchema = z.object({
  value: z.string().min(1).max(32_768),
}).strict();

export const bridgeProtocolMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    webVersion: z.string().trim().min(1).max(100),
  }).strict(),
  z.object({
    type: z.literal("ready"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    extensionVersion: z.string().trim().min(1).max(100),
    capabilities: z.array(z.enum(bridgeOperationIds)).max(bridgeOperationIds.length),
    grantedOrigins: z.array(z.string().url()).max(1_000),
  }).strict(),
  z.object({
    type: z.literal("request-start"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema,
    operation: z.enum(bridgeOperationIds),
    provider: z.enum(bridgeProviderIds),
    baseUrl: z.string().url().max(2_000).optional(),
    credential: bridgeCredentialSchema.optional(),
    bodyKind: z.enum(["none", "json", "text", "binary"]),
    mediaType: z.string().trim().min(1).max(200).optional(),
    totalBytes: z.number().int().nonnegative().max(100 * 1024 * 1024).optional(),
  }).strict(),
  z.object({
    type: z.literal("body-chunk"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema,
    sequence: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil(BRIDGE_CHUNK_BYTES * 4 / 3) + 16),
    encoding: z.enum(["base64", "utf8"]),
    final: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("response-head"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema,
    status: z.number().int().min(100).max(599),
    statusText: z.string().max(500),
    mediaType: z.string().max(200).optional(),
    contentLength: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal("response-chunk"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema,
    sequence: z.number().int().nonnegative(),
    data: z.string().max(Math.ceil(BRIDGE_CHUNK_BYTES * 4 / 3) + 16),
    encoding: z.enum(["base64", "utf8"]),
  }).strict(),
  z.object({
    type: z.literal("ack"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema,
    channel: z.enum(["request", "response"]),
    sequence: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal("end"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema,
  }).strict(),
  z.object({
    type: z.literal("error"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema.optional(),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(10_000),
    retryable: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("cancel"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    requestId: bridgeRequestIdSchema,
  }).strict(),
  z.object({
    type: z.literal("ping"),
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    nonce: bridgeNonceSchema,
    timestamp: z.number().int().nonnegative(),
  }).strict(),
]);

export type BridgeProtocolMessage = z.infer<typeof bridgeProtocolMessageSchema>;

export const stageLayoutIds = [
  "half-body-left",
  "half-body-right",
  "full-body-center",
  "half-body-center",
] as const;
export type StageLayoutId = (typeof stageLayoutIds)[number];

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}
