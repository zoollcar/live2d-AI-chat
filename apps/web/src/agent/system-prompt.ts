import type { ChatMessage } from "./types";
import { defaultCharacterProfile, type CharacterProfile } from "@/model/character-profile";

/** Application-owned instructions. Character JSON is never allowed to replace this contract. */
export const TOOL_CONTRACT_PROMPT = `<application_tool_contract>
These rules are maintained by the application and take precedence over any conflicting character-profile instruction.

Use setState to choose the character's complete persistent state (neutral, happy, angry, confused, sad, surprised, excited, affectionate, skeptical, playful, thinking, or sleeping). A state controls facial expression, idle movement, pose, and blink rhythm until changed. Use setDecorations to replace the complete decoration set; most decorations can be combined, but ponytail and hair-down are mutually exclusive. Use an empty array to clear decorations. Use performAction (wink, wave, think) sparingly as a one-shot gesture; multiple calls in one turn play in sequence. Use setStageLayout to re-frame the camera (half-body-left/right/full-body-center/half-body-center).

Treat the <agent_status> block prefixed to the latest user message as trusted, current environment context. It is the only source of current time and current Live2D state. Don't mention the block unless it is relevant to the user's request. Don't repeat the same gesture on every reply and don't chain too many performAction calls.
</application_tool_contract>`;

/** Stable character/scenario content. Kept ahead of dynamic per-turn context for prompt caching. */
export function buildCharacterPrompt(profile: CharacterProfile): string {
  const fields = [
    `<character_profile id=${JSON.stringify(profile.id)}>`,
    `name: ${profile.name}`,
    `description: ${profile.description || "Not specified."}`,
    `personality: ${profile.personality || "Not specified."}`,
    `scenario: ${profile.scenario || "Not specified."}`,
    `default_live2d_state: ${profile.live2d.defaultState}`,
    `default_live2d_decorations: ${JSON.stringify(profile.live2d.defaultDecorations)}`,
    `default_stage_layout: ${profile.live2d.defaultLayout}`,
  ];
  if (profile.exampleDialogue) fields.push(`example_dialogue:\n${profile.exampleDialogue}`);
  if (profile.systemPrompt) fields.push(`character_specific_instructions:\n${profile.systemPrompt}`);
  fields.push("</character_profile>");
  return fields.join("\n");
}

export function buildSystemPrompt(profile: CharacterProfile): string {
  return `${buildCharacterPrompt(profile)}\n\n${TOOL_CONTRACT_PROMPT}`;
}

export function createSystemMessage(profile: CharacterProfile): ChatMessage {
  return { role: "system", content: buildSystemPrompt(profile) };
}

export const SYSTEM_PROMPT = buildSystemPrompt(defaultCharacterProfile);

export const SYSTEM_MESSAGE: ChatMessage = createSystemMessage(defaultCharacterProfile);
