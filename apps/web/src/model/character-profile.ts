import { z } from "zod";
import { stageLayoutIds, type TtsProviderId } from "@live2d-chat/shared";
import { decorationIds, live2dCatalog, stateIds, type DecorationId, type StateId } from "./live2d/catalog";
import { agentToolNames, type AgentToolName } from "@/agent/tool-context";

export interface CharacterProfile {
  id: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue?: string;
  systemPrompt?: string;
  enabledTools: AgentToolName[];
  live2d: {
    modelId: string;
    defaultState: StateId;
    defaultDecorations: DecorationId[];
    defaultLayout: (typeof stageLayoutIds)[number];
  };
  voice: {
    ttsProvider?: TtsProviderId;
    voice?: string;
    language?: string;
    rate?: number;
    pitch?: number;
  };
}

const trimmedText = (maximum: number) => z.string().trim().max(maximum);

export const characterProfileSchema: z.ZodType<CharacterProfile> = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "Use letters, numbers, hyphens, or underscores."),
  name: trimmedText(100).pipe(z.string().min(1)),
  description: trimmedText(2000),
  personality: trimmedText(4000),
  scenario: trimmedText(4000),
  firstMessage: trimmedText(2000),
  exampleDialogue: trimmedText(8000).optional(),
  systemPrompt: trimmedText(12000).optional(),
  enabledTools: z.array(z.enum(agentToolNames)).max(agentToolNames.length)
    .refine((names) => new Set(names).size === names.length, "Enabled tools must not contain duplicates."),
  live2d: z.object({
    // Phase one intentionally supports only the model bundled with the app.
    modelId: z.literal(live2dCatalog.id),
    defaultState: z.enum(stateIds),
    defaultDecorations: z.array(z.enum(decorationIds)).max(decorationIds.length)
      .refine((ids) => new Set(ids).size === ids.length, "Decorations must not contain duplicates.")
      .refine((ids) => !(ids.includes("ponytail") && ids.includes("hair-down")), "ponytail and hair-down cannot be enabled together."),
    defaultLayout: z.enum(stageLayoutIds),
  }).strict(),
  voice: z.object({
    ttsProvider: z.enum(["vits-local", "browser-speech", "openai-compatible", "google-cloud"]).optional(),
    voice: trimmedText(200).optional(),
    language: z.string().trim().min(2).max(35).optional(),
    rate: z.number().min(0.5).max(2).optional(),
    pitch: z.number().min(0.5).max(2).optional(),
  }).strict(),
}).strict();

export const defaultCharacterProfile: CharacterProfile = {
  id: "ai-secretary",
  name: "AI Secretary",
  description: "A capable Live2D assistant who helps with everyday questions and tasks.",
  personality: "Helpful, engaging, entertaining, truthful, and concise.",
  scenario: "You are speaking with the user as their personal AI secretary.",
  firstMessage: "",
  enabledTools: [...agentToolNames],
  live2d: {
    modelId: live2dCatalog.id,
    defaultState: "neutral",
    defaultDecorations: [],
    defaultLayout: "full-body-center",
  },
  voice: {},
};

export function parseCharacterProfileJson(json: string): CharacterProfile {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : "Unable to parse file."}`, { cause: error });
  }
  const result = characterProfileSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${issue.path.join(".") || "profile"}: ${issue.message}`);
  }
  return result.data;
}

export function serializeCharacterProfile(profile: CharacterProfile): string {
  return `${JSON.stringify(characterProfileSchema.parse(profile), null, 2)}\n`;
}
