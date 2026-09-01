import type {
  ArtifactRef,
  ContentProviderSettings,
  ResourceRef,
} from "@live2d-chat/shared";
import type {
  AgentNetworkAccess,
  AgentResourceAccess,
  AgentWorkspaceAccess,
  ResourceLocator as AgentResourceLocator,
} from "@/agent/tool-context";
import { toArtifactRef, type ArtifactRecord } from "@/model/artifact";
import {
  createPendingResource,
  createResourceId,
  resourceRecordSchema,
  toResourceRef,
  type ResourceBundle,
  type ResourceKind,
  type ResourceLocator,
  type ResourceMetadata,
  type ResourceRecord,
} from "@/model/resource";
import {
  createContentNetworkClient,
  type ContentNetworkClient,
  type VideoTranscriptContent,
  type VideoTranscriptPending,
  type WebPageContent,
} from "@/infrastructure/network";
import { buildResourceChunks, extractedTextLength, type ExtractedResourceSection } from "./chunks";
import { sha256Blob } from "./hash";
import { ingestResourceFile } from "./ingestion";
import { resourceRepository } from "./indexed-db-v2";
import { loadStageArtifact, type LoadedStageArtifact } from "./stage-artifact-loader";
import { useStageWorkspaceStore } from "./stage-workspace-store";
import { STAGE_WORKSPACE_MAX_ARTIFACTS } from "@/model/stage-workspace";
import { getSticker } from "./stickers";
import type { ResourceRepository } from "./repository";
import { createSvgRasterPreviewBundle } from "./svg-rasterizer";

const MAX_ATTACHMENTS_PER_TURN = 10;
const MAX_TOOL_TEXT = 12_000;
const VIDEO_HOSTS = new Set([
  "youtu.be",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "vimeo.com",
  "www.vimeo.com",
  "tiktok.com",
  "www.tiktok.com",
  "instagram.com",
  "www.instagram.com",
  "facebook.com",
  "www.facebook.com",
  "twitch.tv",
  "www.twitch.tv",
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
]);

export interface ResourceControllerUpdate {
  resource: ResourceRef;
  errorMessage?: string;
}

export interface ConversationResourceControllerOptions {
  conversationId: string;
  contentSettings: ContentProviderSettings;
  repository?: ResourceRepository;
  networkClient?: ContentNetworkClient;
  inspectImage?: (resourceId: string, question: string | undefined, signal?: AbortSignal) => Promise<unknown>;
  onUpdate?(update: ResourceControllerUpdate): void;
  onNotification?(message: string): void;
}

export interface ConversationResourceController {
  readonly resources: AgentResourceAccess;
  readonly workspace: AgentWorkspaceAccess;
  readonly network: AgentNetworkAccess;
  attachFiles(files: readonly File[]): Promise<ResourceRef[]>;
  attachUrl(url: string): Promise<ResourceRef>;
  showResource(resourceId: string, locator?: AgentResourceLocator): Promise<ArtifactRef>;
  closeArtifact(artifactId: string, expectedLayoutRevision?: number): boolean;
  cancelResource(resourceId: string): Promise<void>;
  retryResource(resourceId: string): Promise<void>;
  removeResource(resourceId: string): Promise<void>;
  dispose(): void;
}

function abortError(): DOMException {
  return new DOMException("The resource operation was cancelled.", "AbortError");
}

function extensionForKind(kind: ResourceKind, mediaType: string): string {
  if (kind === "web") return mediaType === "text/markdown" ? "md" : "txt";
  if (kind === "video-transcript") return "txt";
  if (kind === "image") return mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1] || "png";
  return kind;
}

function inferredUploadKind(file: File): Exclude<ResourceKind, "web" | "video-transcript"> {
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === "pdf" || extension === "docx" || extension === "pptx") return extension;
  if (extension === "png" || extension === "jpg" || extension === "jpeg" || extension === "webp") return "image";
  if (extension === "svg") return "svg";
  return "text";
}

function displayNameForUrl(value: string, kind: "web" | "video-transcript"): string {
  const url = new URL(value);
  const path = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "").slice(0, 120);
  return path || (kind === "video-transcript" ? `${url.hostname} transcript` : url.hostname);
}

export function isTranscriptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return VIDEO_HOSTS.has(host) || [...VIDEO_HOSTS].some((known) => host.endsWith(`.${known}`));
  } catch {
    return false;
  }
}

function agentLocator(locator: AgentResourceLocator | undefined): ResourceLocator | undefined {
  if (!locator) return undefined;
  return {
    page: locator.page,
    slide: locator.slide,
    ...(locator.timeSeconds === undefined ? {} : {
      startSeconds: locator.timeSeconds,
      endSeconds: locator.timeSeconds + 30,
    }),
  };
}

function assertOwnedResource(resource: ResourceRecord | undefined, conversationId: string): ResourceRecord {
  if (!resource || resource.conversationId !== conversationId) {
    throw new Error("The requested resource is not available in this conversation.");
  }
  return resource;
}

async function readyExtractedBundle(input: {
  id: string;
  conversationId: string;
  kind: "web" | "video-transcript";
  name: string;
  mediaType: string;
  sourceUrl: string;
  sections: readonly ExtractedResourceSection[];
  metadata?: ResourceMetadata;
  now?: number;
}): Promise<ResourceBundle> {
  const now = input.now ?? Date.now();
  const chunks = buildResourceChunks(input.id, input.sections);
  const text = input.sections.map((section) => section.text).join("\n");
  const blob = new Blob([text], { type: input.mediaType });
  const sha256 = await sha256Blob(blob);
  const resource = resourceRecordSchema.parse({
    id: input.id,
    conversationId: input.conversationId,
    kind: input.kind,
    origin: input.kind === "web" ? "web" : "video",
    name: input.name,
    mimeType: input.mediaType,
    extension: extensionForKind(input.kind, input.mediaType),
    status: "ready",
    byteSize: blob.size,
    originalByteSize: blob.size,
    sha256,
    textLength: extractedTextLength(chunks),
    chunkCount: chunks.length,
    sourceUrl: input.sourceUrl,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  });
  return {
    resource,
    blob: { resourceId: input.id, blob, byteSize: blob.size, mimeType: input.mediaType },
    chunks,
  };
}

function webBundle(resource: ResourceRecord, content: WebPageContent): Promise<ResourceBundle> {
  return readyExtractedBundle({
    id: resource.id,
    conversationId: resource.conversationId,
    kind: "web",
    name: content.title?.trim() || resource.name,
    mediaType: content.mediaType,
    sourceUrl: content.resolvedUrl,
    sections: [{ text: content.text }],
    metadata: {
      title: content.title,
      author: content.author,
      description: `Extracted by ${content.provider}`,
    },
    now: resource.createdAt,
  });
}

function transcriptBundle(resource: ResourceRecord, content: VideoTranscriptContent): Promise<ResourceBundle> {
  const durationSeconds = content.cues.reduce((maximum, cue) => Math.max(maximum, cue.endSeconds), 0);
  return readyExtractedBundle({
    id: resource.id,
    conversationId: resource.conversationId,
    kind: "video-transcript",
    name: resource.name,
    mediaType: "text/plain",
    sourceUrl: content.sourceUrl,
    sections: content.cues.map((cue) => ({
      text: cue.text,
      locator: {
        startSeconds: cue.startSeconds,
        endSeconds: cue.endSeconds,
        ...(cue.language ? { label: cue.language } : {}),
      },
    })),
    metadata: {
      durationSeconds,
      description: content.language
        ? `Supadata transcript (${content.language})`
        : "Supadata transcript",
    },
    now: resource.createdAt,
  });
}

function createArtifact(resource: ResourceRecord, kind: ArtifactRecord["kind"], previewResourceId?: string): ArtifactRecord {
  const now = Date.now();
  return {
    id: resource.id,
    conversationId: resource.conversationId,
    kind,
    title: resource.name,
    resourceId: resource.id,
    previewResourceId,
    sourceUrl: resource.sourceUrl,
    createdAt: now,
    updatedAt: now,
  };
}

function boundedToolResult(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_TOOL_TEXT) return value;
  return {
    truncated: true,
    text: serialized.slice(0, MAX_TOOL_TEXT),
    warning: "The tool result was truncated to 12,000 characters.",
  };
}

export function buildAttachmentPrompt(text: string, attachments: readonly ResourceRef[]): string {
  if (attachments.length === 0) return text;
  const resources = attachments.map((attachment) =>
    `- ${attachment.name} (contentId=${attachment.id}, kind=${attachment.kind}, status=${attachment.status})`).join("\n");
  const userText = text.trim() || "Please inspect the attached resources and respond appropriately.";
  return `${userText}\n\n<attached_resources trust="untrusted-data-only">\n${resources}\n</attached_resources>`;
}

export function createConversationResourceController(
  options: ConversationResourceControllerOptions,
): ConversationResourceController {
  const repository = options.repository ?? resourceRepository;
  const client = options.networkClient ?? createContentNetworkClient(options.contentSettings);
  const operations = new Map<string, AbortController>();
  const operationPromises = new Map<string, Promise<void>>();
  const operationPhases = new Map<string, "web" | "transcript-initial" | "transcript-background">();
  const loadedArtifacts = new Map<string, LoadedStageArtifact>();
  const transcriptJobs = new Map<string, VideoTranscriptPending>();
  const canceledResourceIds = new Set<string>();
  const removedResourceIds = new Set<string>();
  let disposed = false;

  const assertActive = () => {
    if (disposed) throw abortError();
  };

  const emitResource = (resource: ResourceRecord, errorMessage?: string) => {
    if (disposed) return;
    options.onUpdate?.({ resource: toResourceRef(resource), errorMessage });
  };

  const reconcileLoadedArtifacts = () => {
    const retainedIds = new Set(useStageWorkspaceStore.getState().artifacts.map((artifact) => artifact.id));
    for (const [artifactId, loaded] of loadedArtifacts) {
      if (retainedIds.has(artifactId)) continue;
      loaded.dispose();
      loadedArtifacts.delete(artifactId);
    }
  };

  const closeLoadedArtifact = (artifactId: string, expectedLayoutRevision?: number): boolean => {
    const accepted = useStageWorkspaceStore.getState().closeArtifact(artifactId, expectedLayoutRevision);
    if (!accepted) return false;
    loadedArtifacts.get(artifactId)?.dispose();
    loadedArtifacts.delete(artifactId);
    return true;
  };

  const refreshArtifact = async (artifact: ArtifactRecord, focus = false) => {
    const loaded = await loadStageArtifact(artifact, { repository });
    if (disposed) {
      loaded.dispose();
      return;
    }
    loadedArtifacts.get(artifact.id)?.dispose();
    loadedArtifacts.set(artifact.id, loaded);
    useStageWorkspaceStore.getState().openArtifact(loaded.artifact, { focus });
    reconcileLoadedArtifacts();
  };

  const refreshResourceArtifacts = async (resourceId: string) => {
    if (disposed) return;
    const artifacts = await repository.listArtifacts(options.conversationId);
    if (disposed) return;
    await Promise.all(artifacts
      .filter((artifact) => artifact.resourceId === resourceId || artifact.previewResourceId === resourceId)
      .map((artifact) => refreshArtifact(artifact, false)));
  };

  const storedBundle = async (resource: ResourceRecord): Promise<ResourceBundle> => {
    const [blob, chunks] = await Promise.all([
      repository.getResourceBlob(resource.id),
      repository.getResourceChunks(resource.id),
    ]);
    if (!blob) throw new Error(`Resource '${resource.id}' has no stored source file.`);
    return { resource, blob, chunks };
  };

  const markFailure = async (resource: ResourceRecord, error: unknown) => {
    if (
      disposed
      || canceledResourceIds.has(resource.id)
      || removedResourceIds.has(resource.id)
      || (error instanceof DOMException && error.name === "AbortError")
    ) return;
    const message = error instanceof Error ? error.message : "Resource processing failed.";
    let failed: ResourceRecord;
    try {
      failed = await repository.updateResource(resource.id, {
        status: "error",
        errorMessage: message.slice(0, 2_000),
        metadata: { progress: { label: "Processing failed" } },
      });
    } catch (updateError) {
      if (disposed || canceledResourceIds.has(resource.id) || removedResourceIds.has(resource.id)) return;
      throw updateError;
    }
    if (disposed) return;
    emitResource(failed, message);
    await refreshResourceArtifacts(resource.id);
  };

  const assertSavedOperationIsCurrent = async (resourceId: string, signal: AbortSignal): Promise<void> => {
    if (removedResourceIds.has(resourceId)) {
      await repository.deleteResource(resourceId).catch(() => undefined);
      throw abortError();
    }
    if (canceledResourceIds.has(resourceId)) {
      const stored = await repository.getResource(resourceId);
      if (stored) {
        await repository.updateResource(resourceId, {
          status: "error",
          errorMessage: "Processing was cancelled.",
          metadata: { progress: { label: "Canceled" } },
        }).catch(() => undefined);
      }
      throw abortError();
    }
    signal.throwIfAborted();
  };

  const processWeb = async (resource: ResourceRecord, signal: AbortSignal) => {
    const sourceUrl = resource.sourceUrl;
    if (!sourceUrl) throw new Error("The web resource has no source URL.");
    const processing = await repository.updateResource(resource.id, {
      status: "processing",
      metadata: { progress: { label: `Reading with ${options.contentSettings.webProvider}` } },
    });
    emitResource(processing);
    await refreshResourceArtifacts(resource.id);
    const content = await client.readWebPage(sourceUrl, signal);
    signal.throwIfAborted();
    const bundle = await webBundle(resource, content);
    signal.throwIfAborted();
    await repository.saveResource(bundle);
    await assertSavedOperationIsCurrent(resource.id, signal);
    signal.throwIfAborted();
    emitResource(bundle.resource);
    await refreshResourceArtifacts(resource.id);
    if (!disposed) options.onNotification?.(`Web page ready: ${bundle.resource.name}`);
  };

  const continueTranscriptJob = async (
    resource: ResourceRecord,
    pending: VideoTranscriptPending,
    signal: AbortSignal,
  ): Promise<void> => {
    transcriptJobs.set(resource.id, pending);
    const saved = await repository.updateResource(resource.id, {
      status: "processing",
      metadata: {
        progress: { label: "Transcript is still processing" },
        providerJob: {
          provider: "supadata",
          id: pending.jobId,
          ...(pending.language ? { language: pending.language } : {}),
        },
      },
    });
    emitResource(saved);
    await refreshResourceArtifacts(resource.id);
    while (!signal.aborted) {
      const outcome = await client.pollVideoTranscriptJob({
        jobId: pending.jobId,
        sourceUrl: pending.sourceUrl,
        language: pending.language,
      }, signal);
      if (outcome.status === "processing") {
        pending = outcome;
        transcriptJobs.set(resource.id, outcome);
        continue;
      }
      const bundle = await transcriptBundle(resource, outcome);
      signal.throwIfAborted();
      await repository.saveResource(bundle);
      await assertSavedOperationIsCurrent(resource.id, signal);
      signal.throwIfAborted();
      transcriptJobs.delete(resource.id);
      emitResource(bundle.resource);
      await refreshResourceArtifacts(resource.id);
      if (!disposed) options.onNotification?.(`Transcript ready: ${resource.name}`);
      return;
    }
    throw abortError();
  };

  const processTranscript = async (resource: ResourceRecord, signal: AbortSignal, language?: string) => {
    const sourceUrl = resource.sourceUrl;
    if (!sourceUrl) throw new Error("The video resource has no source URL.");
    const processing = await repository.updateResource(resource.id, {
      status: "processing",
      metadata: { progress: { label: "Requesting Supadata transcript" } },
    });
    emitResource(processing);
    await refreshResourceArtifacts(resource.id);
    const storedJob = resource.metadata.providerJob;
    const knownJob = transcriptJobs.get(resource.id) ?? (storedJob ? {
      status: "processing" as const,
      provider: "supadata" as const,
      sourceUrl,
      jobId: storedJob.id,
      language: language ?? storedJob.language,
    } : undefined);
    const outcome = knownJob
      ? await client.pollVideoTranscriptJob({
          jobId: knownJob.jobId,
          sourceUrl: knownJob.sourceUrl,
          language: language ?? knownJob.language,
        }, signal)
      : await client.readVideoTranscript({ url: sourceUrl, language }, signal);
    signal.throwIfAborted();
    if (outcome.status === "processing") {
      transcriptJobs.set(resource.id, outcome);
      const pending = await repository.updateResource(resource.id, {
        status: "processing",
        metadata: {
          progress: { label: "Transcript is still processing" },
          providerJob: {
            provider: "supadata",
            id: outcome.jobId,
            ...(outcome.language ? { language: outcome.language } : {}),
          },
        },
      });
      emitResource(pending);
      await refreshResourceArtifacts(resource.id);
      return;
    }
    const bundle = await transcriptBundle(resource, outcome);
    signal.throwIfAborted();
    await repository.saveResource(bundle);
    await assertSavedOperationIsCurrent(resource.id, signal);
    signal.throwIfAborted();
    emitResource(bundle.resource);
    await refreshResourceArtifacts(resource.id);
    if (!disposed) options.onNotification?.(`Transcript ready: ${resource.name}`);
  };

  const startOperation = (
    resource: ResourceRecord,
    phase: "web" | "transcript-initial" | "transcript-background",
    operation: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (disposed) return Promise.reject(abortError());
    operations.get(resource.id)?.abort();
    const controller = new AbortController();
    operations.set(resource.id, controller);
    operationPhases.set(resource.id, phase);
    const promise = operation(controller.signal)
      .catch((error) => markFailure(resource, error))
      .finally(() => {
        if (operations.get(resource.id) === controller) {
          operations.delete(resource.id);
          operationPromises.delete(resource.id);
          operationPhases.delete(resource.id);
        }
      });
    operationPromises.set(resource.id, promise);
    void promise;
    return promise;
  };

  const startTranscript = (resource: ResourceRecord, language?: string): Promise<void> => {
    const initial = startOperation(
      resource,
      "transcript-initial",
      (signal) => processTranscript(resource, signal, language),
    );
    void initial.then(async () => {
      if (disposed) return;
      const pending = transcriptJobs.get(resource.id);
      const stored = await repository.getResource(resource.id);
      if (!pending || stored?.status !== "processing") return;
      await startOperation(
        stored,
        "transcript-background",
        (signal) => continueTranscriptJob(stored, pending, signal),
      );
    }).catch((error) => {
      if (!disposed) options.onNotification?.(error instanceof Error ? error.message : "Transcript processing failed.");
    });
    return initial;
  };

  const restorePersistedWorkspace = async (): Promise<void> => {
    try {
      const [artifacts, storedResources] = await Promise.all([
        repository.listArtifacts(options.conversationId),
        repository.listResources(options.conversationId),
      ]);
      if (disposed) return;
      const retainedArtifacts = [...artifacts]
        .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt)
        .slice(-STAGE_WORKSPACE_MAX_ARTIFACTS);
      for (let index = 0; index < retainedArtifacts.length; index += 1) {
        await refreshArtifact(retainedArtifacts[index], index === retainedArtifacts.length - 1);
        if (disposed) return;
      }

      for (const resource of storedResources) {
        if (disposed || (resource.status !== "pending" && resource.status !== "processing")) continue;
        if (resource.kind === "video-transcript" && resource.metadata.providerJob && resource.sourceUrl) {
          const pending: VideoTranscriptPending = {
            status: "processing",
            provider: "supadata",
            sourceUrl: resource.sourceUrl,
            jobId: resource.metadata.providerJob.id,
            language: resource.metadata.providerJob.language,
          };
          transcriptJobs.set(resource.id, pending);
          void startOperation(
            resource,
            "transcript-background",
            (signal) => continueTranscriptJob(resource, pending, signal),
          );
          continue;
        }

        // Replaying an interrupted provider request could duplicate a billed
        // POST. Leave resubmission behind the explicit Retry action. A known
        // Supadata job above is safe to resume because it only polls its id.
        const interrupted = await repository.updateResource(resource.id, {
          status: "error",
          errorMessage: "Processing was interrupted. Retry to continue.",
          metadata: { progress: { label: "Retry required" } },
        });
        emitResource(interrupted, interrupted.errorMessage);
        await refreshResourceArtifacts(resource.id);
      }
    } catch (error) {
      if (!disposed) {
        options.onNotification?.(
          error instanceof Error ? error.message : "Saved stage content could not be restored.",
        );
      }
    }
  };

  const waitForOperation = async (resourceId: string, signal?: AbortSignal): Promise<void> => {
    const operation = operationPromises.get(resourceId);
    if (!operation) return;
    signal?.throwIfAborted();
    if (!signal) {
      await operation;
      return;
    }
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason ?? abortError()), { once: true });
      }),
    ]);
  };

  const showResource = async (resourceId: string, locator?: AgentResourceLocator): Promise<ArtifactRef> => {
    const resource = assertOwnedResource(await repository.getResource(resourceId), options.conversationId);
    const existing = (await repository.listArtifacts(options.conversationId)).find((artifact) =>
      artifact.resourceId === resourceId);
    let artifact = existing;
    if (!artifact) {
      let previewResourceId: string | undefined;
      if (resource.kind === "svg" && resource.status === "ready") {
        const preview = await createSvgRasterPreviewBundle(await storedBundle(resource), {
          alt: resource.metadata.description ?? resource.name,
        });
        await repository.saveResource(preview);
        previewResourceId = preview.resource.id;
      }
      artifact = {
        ...createArtifact(resource, "resource-view", previewResourceId),
        locator: agentLocator(locator),
      };
      await repository.saveArtifact(artifact);
    }
    await refreshArtifact(artifact, true);
    return toArtifactRef(artifact);
  };

  const resources: AgentResourceAccess = {
    async list(signal) {
      signal?.throwIfAborted();
      return (await repository.listResources(options.conversationId)).map((resource) => toResourceRef(resource));
    },
    async read(request, signal) {
      signal?.throwIfAborted();
      const resource = assertOwnedResource(await repository.getResource(request.resourceId), options.conversationId);
      if (resource.status !== "ready") {
        return { resource: toResourceRef(resource), processing: resource.status === "processing" };
      }
      return boundedToolResult(await repository.readResource(resource.id, {
        cursor: request.cursor,
        query: request.query,
        locator: agentLocator(request.locator),
        maxChars: Math.min(request.maxChars, MAX_TOOL_TEXT),
      }));
    },
    ...(options.inspectImage ? { inspectImage: options.inspectImage } : {}),
  };

  const workspace: AgentWorkspaceAccess = {
    showResource,
    async closeContent(contentId, signal) {
      signal?.throwIfAborted();
      const store = useStageWorkspaceStore.getState();
      const requestedId = contentId?.trim();
      const id = requestedId ?? store.activeArtifactId;
      if (!id) return { ok: true, closed: false, reason: "No matching stage content is open." };
      if (!closeLoadedArtifact(id)) {
        return { ok: true, closed: false, requestedId, reason: "No matching stage content is open." };
      }
      await repository.deleteArtifact(id);
      return { ok: true, closed: true, contentId: requestedId ?? id };
    },
    async drawSvg(input, signal) {
      signal?.throwIfAborted();
      const sourceId = createResourceId();
      const sourceFile = new File([input.svg], `${input.title}.svg`, { type: "image/svg+xml" });
      const source = await ingestResourceFile(sourceFile, {
        conversationId: options.conversationId,
        origin: "generated",
        resourceId: sourceId,
        signal,
      });
      const previewBundle = await createSvgRasterPreviewBundle(source, {
        name: `${input.title}.png`,
        alt: input.alt,
        signal,
      });
      source.resource.metadata.description = input.alt;
      await repository.saveResource(source);
      await repository.saveResource(previewBundle);
      const artifact = createArtifact(source.resource, "svg-drawing", previewBundle.resource.id);
      await repository.saveArtifact(artifact);
      await refreshArtifact(artifact, true);
      return toArtifactRef(artifact);
    },
    async sendSticker(stickerId, signal) {
      signal?.throwIfAborted();
      const sticker = getSticker(stickerId);
      if (!sticker) throw new Error(`Sticker '${stickerId}' is not in the installed pack.`);
      const response = await fetch(sticker.path, { signal, credentials: "same-origin", cache: "force-cache" });
      if (!response.ok) throw new Error("The selected sticker asset is unavailable.");
      const blob = await response.blob();
      if (blob.type !== "image/png") throw new Error("The sticker asset has an invalid media type.");
      const file = new File([blob], `${sticker.stickerId}.png`, { type: "image/png" });
      const bundle = await ingestResourceFile(file, {
        conversationId: options.conversationId,
        origin: "generated",
        signal,
      });
      bundle.resource.metadata.description = sticker.alt;
      await repository.saveResource(bundle);
      const artifact = createArtifact(bundle.resource, "sticker");
      artifact.title = sticker.name;
      await repository.saveArtifact(artifact);
      await refreshArtifact(artifact, true);
      return toArtifactRef(artifact);
    },
  };

  const network: AgentNetworkAccess = {
    async readWebPage(resourceId, signal) {
      const resource = assertOwnedResource(await repository.getResource(resourceId), options.conversationId);
      if (resource.kind !== "web") throw new Error("The selected resource is not a web page.");
      if (resource.status !== "ready" && operationPhases.get(resource.id) === "web") {
        await waitForOperation(resource.id, signal);
      }
      const updated = assertOwnedResource(await repository.getResource(resourceId), options.conversationId);
      if (updated.status !== "ready") {
        return {
          resource: toResourceRef(updated),
          processing: updated.status === "pending" || updated.status === "processing",
          error: updated.errorMessage,
        };
      }
      return boundedToolResult(await repository.readResource(resourceId, { maxChars: MAX_TOOL_TEXT }));
    },
    async readVideoTranscript(input, signal) {
      const resource = assertOwnedResource(await repository.getResource(input.resourceId), options.conversationId);
      if (resource.kind !== "video-transcript") throw new Error("The selected resource is not a video transcript.");
      if (resource.status !== "ready" && operationPhases.get(resource.id) === "transcript-initial") {
        await waitForOperation(resource.id, signal);
      }
      const updated = assertOwnedResource(await repository.getResource(resource.id), options.conversationId);
      if (updated.status !== "ready") {
        return {
          resource: toResourceRef(updated),
          processing: updated.status === "pending" || updated.status === "processing",
          error: updated.errorMessage,
        };
      }
      return boundedToolResult(await repository.readResource(resource.id, {
        cursor: input.cursor,
        maxChars: MAX_TOOL_TEXT,
      }));
    },
  };

  void restorePersistedWorkspace();

  return {
    resources,
    workspace,
    network,
    async attachFiles(files) {
      if (disposed) throw new Error("The resource controller has been disposed.");
      if (files.length > MAX_ATTACHMENTS_PER_TURN) throw new Error("A message can contain at most 10 attachments.");
      return Promise.all(files.map(async (file) => {
        const id = createResourceId();
        const pending: ResourceRef = {
          id,
          kind: inferredUploadKind(file),
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          size: file.size,
          status: "processing",
        };
        options.onUpdate?.({ resource: pending });
        const controller = new AbortController();
        operations.set(id, controller);
        try {
          const bundle = await ingestResourceFile(file, {
            conversationId: options.conversationId,
            resourceId: id,
            signal: controller.signal,
          });
          if (disposed || controller.signal.aborted) throw abortError();
          await repository.saveResource(bundle);
          if (disposed || controller.signal.aborted) {
            await repository.deleteResource(id).catch(() => undefined);
            throw abortError();
          }
          emitResource(bundle.resource);
          return toResourceRef(bundle.resource);
        } catch (error) {
          if (disposed || controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            throw abortError();
          }
          const message = error instanceof Error ? error.message : "The file could not be processed.";
          const failed = { ...pending, status: "error" as const };
          options.onUpdate?.({ resource: failed, errorMessage: message });
          return failed;
        } finally {
          if (operations.get(id) === controller) operations.delete(id);
        }
      }));
    },
    async attachUrl(url) {
      if (disposed) throw new Error("The resource controller has been disposed.");
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only HTTP and HTTPS URLs are supported.");
      parsed.hash = "";
      const normalized = parsed.toString();
      const existing = (await repository.listResources(options.conversationId)).find((resource) =>
        resource.sourceUrl === normalized);
      assertActive();
      if (existing) return toResourceRef(existing);
      const kind = isTranscriptUrl(normalized) ? "video-transcript" : "web";
      const resource = createPendingResource({
        conversationId: options.conversationId,
        kind,
        origin: kind === "web" ? "web" : "video",
        name: displayNameForUrl(normalized, kind),
        mimeType: "text/plain",
        extension: "txt",
        sourceUrl: normalized,
      });
      let artifact: ArtifactRecord | undefined;
      try {
        await repository.saveResourceMetadata(resource);
        assertActive();
        const processing = await repository.updateResource(resource.id, {
          status: "processing",
          metadata: { progress: { label: kind === "web" ? "Reading page" : "Preparing transcript" } },
        });
        assertActive();
        emitResource(processing);
        artifact = createArtifact(processing, "resource-view");
        await repository.saveArtifact(artifact);
        assertActive();
        await refreshArtifact(artifact, true);
        assertActive();
        if (kind === "web") void startOperation(processing, "web", (signal) => processWeb(processing, signal));
        else void startTranscript(processing);
        assertActive();
        return toResourceRef(processing);
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) {
          removedResourceIds.add(resource.id);
          if (artifact) await repository.deleteArtifact(artifact.id).catch(() => undefined);
          await repository.deleteResource(resource.id).catch(() => undefined);
          throw abortError();
        }
        throw error;
      }
    },
    showResource,
    closeArtifact(artifactId, expectedLayoutRevision) {
      const closed = closeLoadedArtifact(artifactId, expectedLayoutRevision);
      if (closed) {
        void repository.deleteArtifact(artifactId).catch((error) => {
          options.onNotification?.(
            error instanceof Error ? error.message : "Closed stage content could not be removed from storage.",
          );
        });
      }
      return closed;
    },
    async cancelResource(resourceId) {
      assertOwnedResource(await repository.getResource(resourceId), options.conversationId);
      assertActive();
      canceledResourceIds.add(resourceId);
      const hadOperation = operations.has(resourceId);
      operations.get(resourceId)?.abort();
      operations.delete(resourceId);
      operationPromises.delete(resourceId);
      operationPhases.delete(resourceId);
      await repository.getResource(resourceId).then((stored) => {
        if (!stored) {
          if (hadOperation) options.onNotification?.("File processing canceled.");
          return undefined;
        }
        return repository.updateResource(resourceId, {
          status: "error",
          errorMessage: "Processing was cancelled.",
          metadata: { progress: { label: "Canceled" } },
        });
      }).then((resource) => {
        if (!resource) return undefined;
        emitResource(resource, resource.errorMessage);
        return refreshResourceArtifacts(resourceId);
      });
    },
    async retryResource(resourceId) {
      const resource = assertOwnedResource(await repository.getResource(resourceId), options.conversationId);
      canceledResourceIds.delete(resourceId);
      if (resource.kind === "web") await startOperation(resource, "web", (signal) => processWeb(resource, signal));
      else if (resource.kind === "video-transcript") {
        await startTranscript(resource);
      } else {
        throw new Error("Uploaded file parsing must be retried by attaching the original file again.");
      }
    },
    async removeResource(resourceId) {
      assertOwnedResource(await repository.getResource(resourceId), options.conversationId);
      assertActive();
      removedResourceIds.add(resourceId);
      canceledResourceIds.delete(resourceId);
      operations.get(resourceId)?.abort();
      operations.delete(resourceId);
      operationPromises.delete(resourceId);
      operationPhases.delete(resourceId);
      transcriptJobs.delete(resourceId);
      const artifacts = await repository.listArtifacts(options.conversationId);
      assertActive();
      const removedArtifacts = artifacts.filter((artifact) =>
        artifact.resourceId === resourceId || artifact.previewResourceId === resourceId);
      const removedArtifactIds = new Set(removedArtifacts.map((artifact) => artifact.id));
      const retainedArtifacts = artifacts.filter((artifact) => !removedArtifactIds.has(artifact.id));
      const orphanedPreviewIds = new Set(removedArtifacts.flatMap((artifact) =>
        artifact.resourceId === resourceId && artifact.previewResourceId ? [artifact.previewResourceId] : []));
      for (const artifact of removedArtifacts) {
        loadedArtifacts.get(artifact.id)?.dispose();
        loadedArtifacts.delete(artifact.id);
        useStageWorkspaceStore.getState().closeArtifact(artifact.id);
        await repository.deleteArtifact(artifact.id);
      }
      await repository.deleteResource(resourceId);
      for (const previewResourceId of orphanedPreviewIds) {
        if (retainedArtifacts.some((artifact) =>
          artifact.resourceId === previewResourceId || artifact.previewResourceId === previewResourceId)) continue;
        const preview = await repository.getResource(previewResourceId);
        if (preview?.conversationId === options.conversationId) await repository.deleteResource(previewResourceId);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of operations.values()) controller.abort();
      operations.clear();
      operationPromises.clear();
      operationPhases.clear();
      transcriptJobs.clear();
      for (const loaded of loadedArtifacts.values()) loaded.dispose();
      loadedArtifacts.clear();
      useStageWorkspaceStore.getState().resetWorkspace();
    },
  };
}
