import type { ResourceBundle, ResourceMetadata, ResourceOrigin } from "@/model/resource";
import type { ValidatedResourceFile } from "../validation";

export interface ResourceIngestionOptions {
  conversationId: string;
  origin?: ResourceOrigin;
  resourceId?: string;
  now?: number;
  signal?: AbortSignal;
}

export interface ResourceIngestionAdapter {
  readonly kinds: readonly ValidatedResourceFile["kind"][];
  ingest(file: ValidatedResourceFile, options: ResourceIngestionOptions): Promise<ResourceBundle>;
}

export interface ResourceBundleInput {
  file: Pick<ValidatedResourceFile, "file" | "extension" | "mimeType">;
  blob?: Blob;
  originalSha256?: string;
  options: ResourceIngestionOptions;
  kind: ValidatedResourceFile["kind"];
  sections: Array<{
    text: string;
    locator?: {
      page?: number;
      slide?: number;
      startSeconds?: number;
      endSeconds?: number;
      label?: string;
    };
  }>;
  metadata?: ResourceMetadata;
}
