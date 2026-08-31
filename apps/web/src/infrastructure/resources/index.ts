export {
  RESOURCE_ARCHIVE_FORMAT,
  RESOURCE_ARCHIVE_MANIFEST,
  RESOURCE_ARCHIVE_VERSION,
  exportResourceArchiveV2,
  importResourceArchive,
  type ExportResourceArchiveInput,
  type ImportedResourceArchive,
  type ResourceArchiveEntry,
  type ResourceArchiveManifest,
} from "./archive";
export { reclaimConversationResources, deleteConversationWithResources } from "./conversation-cascade";
export {
  exportConversationLibraryArchive,
  importConversationLibraryArchive,
  type ConversationArchiveImportResult,
  type ImportConversationArchiveOptions,
} from "./conversation-archive";
export {
  buildAttachmentPrompt,
  createConversationResourceController,
  isTranscriptUrl,
  type ConversationResourceController,
  type ConversationResourceControllerOptions,
  type ResourceControllerUpdate,
} from "./conversation-resource-controller";
export { ResourceError, type ResourceErrorCode } from "./errors";
export {
  hardenRenderedOfficePreview,
  renderOfficeResourcePreview,
  renderPdfResourcePreview,
  type DocxPreviewRuntime,
  type OfficePreviewHandle,
  type OfficePreviewLoaders,
  type PdfCanvasSurface,
  type PdfPreviewDocument,
  type PdfPreviewHandle,
  type PdfPreviewLoader,
  type PdfPreviewLoadingTask,
  type PdfPreviewPage,
  type PdfPreviewRuntime,
  type PdfPreviewViewport,
  type PptxPreviewRuntime,
  type PptxPreviewSlideHandle,
  type PptxPreviewViewer,
  type RenderOfficePreviewOptions,
  type RenderPdfPreviewOptions,
} from "./document-preview";
export {
  LIVE2D_DATABASE_NAME,
  LIVE2D_DATABASE_VERSION,
  RESOURCE_STORE_NAMES,
  createIndexedDbResourceRepository,
  openLive2dDatabaseV2,
  resourceRepository,
  upgradeLive2dDatabaseToV2,
} from "./indexed-db-v2";
export {
  ingestDocxResource,
  ingestImageResource,
  ingestOfficeResource,
  ingestPdfResource,
  ingestPptxResource,
  ingestResourceFile,
  ingestSvgResource,
  ingestTextResource,
  sanitizeSvgText,
  type ResourceIngestionAdapter,
  type ResourceIngestionOptions,
  type SvgSanitizationOptions,
} from "./ingestion";
export { RESOURCE_LIMITS } from "./limits";
export { readResourceChunks } from "./read-resource";
export { getSticker, ICE_GIRL_STICKERS, type StickerManifestEntry } from "./stickers";
export {
  createSvgRasterPreviewBundle,
  rasterizeSanitizedSvg,
  type CreateSvgPreviewBundleOptions,
  type RasterizedSvg,
  type RasterizeSvgOptions,
  type SvgRasterizerWorker,
  type SvgRasterizerWorkerFactory,
} from "./svg-rasterizer";
export {
  loadStageArtifact,
  type LoadedStageArtifact,
  type StageArtifactLoaderOptions,
  type StageArtifactResourceRepository,
  type StageObjectUrlAdapter,
} from "./stage-artifact-loader";
export {
  createStageDocumentPreviewSource,
  getStageDocumentPreviewSource,
  registerStageDocumentPreviewSource,
  type StageDocumentPreviewHandle,
  type StageDocumentPreviewMountOptions,
  type StageDocumentPreviewSource,
  type StageDocumentPreviewSourceOptions,
  type StageOriginalDocumentKind,
} from "./stage-document-preview";
export type { ConversationCascadeResult, ResourceMetadataPatch, ResourceRepository } from "./repository";
export { validateResourceFile, type ValidatedResourceFile } from "./validation";
export {
  assertInflatedEntriesMatchInspection,
  assertSafeArchivePath,
  defaultArchiveSafetyLimits,
  inspectZipArchive,
  officeArchiveSafetyLimits,
  verifyZipArchiveContents,
  type VerifyZipArchiveOptions,
  type ZipEntryInfo,
  type ZipInspection,
  type ZipSafetyLimits,
  type ZipValidationWorker,
  type ZipValidationWorkerFactory,
} from "./zip-safety";
