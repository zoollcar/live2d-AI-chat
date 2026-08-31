import type { ArtifactRef, ResourceRef } from "@live2d-chat/shared";

export interface ResourceLocator {
  page?: number;
  slide?: number;
  timeSeconds?: number;
}

export interface ResourceReadRequest {
  resourceId: string;
  query?: string;
  locator?: ResourceLocator;
  cursor?: string;
  maxChars: number;
}

export interface AgentResourceAccess {
  list(signal?: AbortSignal): Promise<ResourceRef[]>;
  read(request: ResourceReadRequest, signal?: AbortSignal): Promise<unknown>;
  inspectImage?(resourceId: string, question: string | undefined, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentWorkspaceAccess {
  showResource(resourceId: string, locator?: ResourceLocator, signal?: AbortSignal): Promise<ArtifactRef>;
  closeContent(artifactId?: string, signal?: AbortSignal): Promise<unknown>;
  drawSvg(input: { title: string; alt: string; svg: string }, signal?: AbortSignal): Promise<ArtifactRef>;
  sendSticker(stickerId: string, signal?: AbortSignal): Promise<ArtifactRef>;
}

export interface AgentNetworkAccess {
  readWebPage(resourceId: string, signal?: AbortSignal): Promise<unknown>;
  readVideoTranscript(input: {
    resourceId: string;
    language?: string;
    cursor?: string;
  }, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentToolCapabilities {
  inspectImage: boolean;
}
