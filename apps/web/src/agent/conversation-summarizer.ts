import { generateText } from "ai";
import type { LlmSettings } from "@live2d-chat/shared";
import { buildSummaryPrompt, type ConversationCompactionPlan } from "@/model/conversation-compaction";
import { summarizeWithChromePromptApi } from "./chrome-agent";
import { summarizeWithLocalModel } from "./index";
import { createRemoteLanguageModel } from "./language-model";

export async function summarizeConversation(
  plan: ConversationCompactionPlan,
  settings: LlmSettings,
  signal: AbortSignal,
): Promise<string> {
  const prompt = buildSummaryPrompt(plan);
  if (settings.transport === "local") {
    return summarizeWithLocalModel(prompt, settings, signal);
  }
  if (settings.transport === "chrome") {
    return summarizeWithChromePromptApi(prompt, signal);
  }
  const result = await generateText({
    model: createRemoteLanguageModel(settings),
    system: "Create durable conversation memory. Preserve facts, decisions, preferences, unresolved tasks, and necessary tool outcomes. Do not invent details. Return only the updated summary.",
    prompt,
    maxOutputTokens: 900,
    temperature: 0.2,
    abortSignal: signal,
  });
  const summary = result.text.trim();
  if (!summary) throw new Error("The model returned an empty conversation summary.");
  return summary;
}
