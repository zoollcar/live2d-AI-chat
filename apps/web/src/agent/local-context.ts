import type { ChatCompletionMessage } from "@wllama/wllama";

export const LOCAL_CONTEXT_TOKENS = 8_192;
export const LOCAL_MAX_OUTPUT_TOKENS = 600;

function estimateToolResultTokens(messages: ChatCompletionMessage[]): number {
  return messages.reduce((total, message) => {
    const serialized = JSON.stringify(message);
    // Tool results are usually compact JSON. Counting Unicode code points is
    // deliberately conservative for both English and CJK text, with a small
    // allowance for chat-template framing around each message.
    return total + Array.from(serialized).length + 16;
  }, 0);
}

export function hasContextForNextLocalStep(
  usedTokens: number | undefined,
  addedMessages: ChatCompletionMessage[],
): boolean {
  if (usedTokens === undefined) return true;
  return usedTokens + estimateToolResultTokens(addedMessages) + LOCAL_MAX_OUTPUT_TOKENS
    <= LOCAL_CONTEXT_TOKENS;
}
