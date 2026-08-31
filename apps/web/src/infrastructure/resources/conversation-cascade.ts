import type { ConversationCascadeResult, ResourceRepository } from "./repository";
import { resourceRepository } from "./indexed-db-v2";

/**
 * Deletes a conversation and all resource/blob/chunk/artifact records in one
 * IndexedDB v2 transaction. The conversation store should call this instead of
 * its v1-only `deleteConversation()` helper once database ownership is moved to
 * `openLive2dDatabaseV2()`.
 */
export function deleteConversationWithResources(
  conversationId: string,
  repository: ResourceRepository = resourceRepository,
): Promise<ConversationCascadeResult> {
  return repository.deleteConversationCascade(conversationId);
}

/**
 * Compatibility hook for a mainline that already deleted the conversation
 * record. This is intentionally not atomic with that earlier deletion.
 */
export function reclaimConversationResources(
  conversationId: string,
  repository: ResourceRepository = resourceRepository,
): Promise<ConversationCascadeResult> {
  return repository.deleteConversationResources(conversationId);
}
