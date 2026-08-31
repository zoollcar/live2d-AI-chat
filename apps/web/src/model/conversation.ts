import { z } from "zod";
import { artifactRefSchema, resourceRefSchema, type LlmSettings } from "@live2d-chat/shared";
import type { ChatMessage } from "@/agent";

export const CONVERSATION_EXPORT_FORMAT = "live2d-chat-conversations";
export const CONVERSATION_EXPORT_VERSION = 1;
export const MAX_CONVERSATION_IMPORT_BYTES = 50 * 1024 * 1024;

export interface ConversationModelSnapshot {
  transport: LlmSettings["transport"];
  baseUrl: string;
  modelId: string;
}

export interface ConversationSummary {
  content: string;
  compactedMessageCount: number;
  updatedAt: number;
  /** New summaries keep the full transcript; absent means legacy pruned storage. */
  transcriptRetained?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  starred: boolean;
  characterId: string;
  modelSnapshot: ConversationModelSnapshot;
  summary?: ConversationSummary;
  messages: ChatMessage[];
}

export interface ConversationExport {
  format: typeof CONVERSATION_EXPORT_FORMAT;
  version: typeof CONVERSATION_EXPORT_VERSION;
  exportedAt: string;
  conversations: Conversation[];
}

const toolCallSchema = z.object({
  callId: z.string().trim().min(1).max(500).optional(),
  name: z.string().trim().min(1).max(200),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().max(100_000).optional(),
  canceled: z.boolean().optional(),
}).passthrough();

const chatMessageSchema: z.ZodType<ChatMessage> = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(2_000_000),
  inputMode: z.enum(["text", "voice"]).optional(),
  transcriptUnavailable: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  reasoning: z.string().max(2_000_000).optional(),
  toolCalls: z.array(toolCallSchema).max(2_000).optional(),
  attachments: z.array(resourceRefSchema).max(10).optional(),
  artifacts: z.array(artifactRefSchema).max(200).optional(),
}).passthrough();

const currentConversationModelSnapshotSchema: z.ZodType<ConversationModelSnapshot> = z.object({
  transport: z.enum(["extension", "direct", "local", "chrome"]),
  baseUrl: z.string().trim().max(2_000),
  modelId: z.string().trim().min(1).max(500),
}).strict();

export const conversationModelSnapshotSchema: z.ZodType<ConversationModelSnapshot> = z.preprocess((value) => {
  if (typeof value !== "object" || value === null) return value;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.transport !== "proxy") return value;
  return {
    ...snapshot,
    transport: "extension",
    baseUrl: typeof snapshot.baseUrl === "string" && snapshot.baseUrl.startsWith("/api/llm/")
      ? "https://api.openai.com/v1"
      : snapshot.baseUrl,
  };
}, currentConversationModelSnapshotSchema);

export const conversationSchema: z.ZodType<Conversation> = z.object({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  starred: z.boolean(),
  characterId: z.string().trim().min(1).max(80),
  modelSnapshot: conversationModelSnapshotSchema,
  summary: z.object({
    content: z.string().trim().min(1).max(2_000_000),
    compactedMessageCount: z.number().int().positive(),
    updatedAt: z.number().int().nonnegative(),
    transcriptRetained: z.boolean().optional(),
  }).strict().optional(),
  messages: z.array(chatMessageSchema).max(10_000),
}).strict().refine((conversation) => conversation.updatedAt >= conversation.createdAt, {
  message: "updatedAt must not be earlier than createdAt.",
  path: ["updatedAt"],
});

const exportSchema = z.object({
  format: z.literal(CONVERSATION_EXPORT_FORMAT),
  version: z.literal(CONVERSATION_EXPORT_VERSION),
  exportedAt: z.string().datetime(),
  conversations: z.array(conversationSchema).max(5_000),
}).strict();

const legacyExportSchema = z.object({
  format: z.literal(CONVERSATION_EXPORT_FORMAT),
  version: z.literal(0),
  exportedAt: z.string().datetime().optional(),
  conversations: z.array(z.object({
    id: z.string(),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    starred: z.boolean().optional(),
    characterId: z.string(),
    model: conversationModelSnapshotSchema,
    messages: z.array(chatMessageSchema),
  }).strict()).max(5_000),
}).strict();

export function createModelSnapshot(settings: LlmSettings): ConversationModelSnapshot {
  return {
    transport: settings.transport,
    baseUrl: settings.baseUrl,
    modelId: settings.modelId,
  };
}

export function createConversation(input: {
  characterId: string;
  modelSnapshot: ConversationModelSnapshot;
  messages: ChatMessage[];
  title?: string;
  now?: number;
}): Conversation {
  const now = input.now ?? Date.now();
  return conversationSchema.parse({
    id: createConversationId(),
    title: input.title?.trim() || "New conversation",
    createdAt: now,
    updatedAt: now,
    starred: false,
    characterId: input.characterId,
    modelSnapshot: input.modelSnapshot,
    messages: input.messages,
  });
}

export function deriveConversationTitle(messages: readonly ChatMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.role === "user");
  const content = firstUser?.content.trim().replace(/\s+/g, " ")
    || firstUser?.attachments?.map((attachment) => attachment.name).join(", ");
  if (!content) return undefined;
  return content.length > 48 ? `${content.slice(0, 47)}…` : content;
}

export function serializeConversationExport(conversations: readonly Conversation[]): string {
  const payload: ConversationExport = {
    format: CONVERSATION_EXPORT_FORMAT,
    version: CONVERSATION_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    conversations: conversations.map((conversation) => conversationSchema.parse(conversation)),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function parseConversationExport(json: string): ConversationExport {
  if (new Blob([json]).size > MAX_CONVERSATION_IMPORT_BYTES) {
    throw new Error("Conversation import exceeds the 50 MiB limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : "Unable to parse file."}`, { cause: error });
  }
  const current = exportSchema.safeParse(value);
  if (current.success) return current.data;

  const legacy = legacyExportSchema.safeParse(value);
  if (legacy.success) {
    return {
      format: CONVERSATION_EXPORT_FORMAT,
      version: CONVERSATION_EXPORT_VERSION,
      exportedAt: legacy.data.exportedAt ?? new Date().toISOString(),
      conversations: legacy.data.conversations.map(({ model, starred = false, ...conversation }) =>
        conversationSchema.parse({ ...conversation, starred, modelSnapshot: model })),
    };
  }

  const issue = current.error.issues[0];
  throw new Error(`${issue.path.join(".") || "export"}: ${issue.message}`);
}

export function createConversationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
