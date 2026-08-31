import type { ArtifactRecord } from "@/model/artifact";
import type {
  ReadResourceRequest,
  ReadResourceResult,
  ResourceBlobRecord,
  ResourceBundle,
  ResourceChunk,
  ResourceRecord,
} from "@/model/resource";

export interface ConversationCascadeResult {
  conversationDeleted: boolean;
  resourcesDeleted: number;
  artifactsDeleted: number;
}

export type ResourceMetadataPatch = Partial<Pick<
  ResourceRecord,
  "status" | "errorMessage" | "name" | "sourceUrl" | "metadata" | "updatedAt"
>>;

export interface ResourceRepository {
  saveResource(bundle: ResourceBundle): Promise<void>;
  saveResourceMetadata(resource: ResourceRecord): Promise<void>;
  updateResource(id: string, patch: ResourceMetadataPatch): Promise<ResourceRecord>;
  getResource(id: string): Promise<ResourceRecord | undefined>;
  getResourceBlob(id: string): Promise<ResourceBlobRecord | undefined>;
  getResourceChunks(id: string): Promise<ResourceChunk[]>;
  listResources(conversationId: string): Promise<ResourceRecord[]>;
  readResource(id: string, request?: ReadResourceRequest): Promise<ReadResourceResult>;
  deleteResource(id: string): Promise<boolean>;
  saveArtifact(artifact: ArtifactRecord): Promise<void>;
  getArtifact(id: string): Promise<ArtifactRecord | undefined>;
  listArtifacts(conversationId: string): Promise<ArtifactRecord[]>;
  deleteArtifact(id: string): Promise<boolean>;
  deleteConversationResources(conversationId: string): Promise<ConversationCascadeResult>;
  deleteConversationCascade(conversationId: string): Promise<ConversationCascadeResult>;
}
