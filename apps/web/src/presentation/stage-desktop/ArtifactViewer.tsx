import type { ReactNode } from "react";
import { clampStagePageIndex, type StageArtifact } from "@/model/stage-workspace";
import { OriginalDocumentPreview } from "./OriginalDocumentPreview";
import { formatStageTranscriptTimestamp } from "./viewer-adapters";

const MAX_VISIBLE_TEXT_CHARACTERS = 500_000;
const MAX_VISIBLE_TRANSCRIPT_CUES = 5_000;

export interface ArtifactViewerProps {
  artifact: StageArtifact;
  pageIndex: number;
  searchQuery: string;
  onSelectTranscriptCue?(cueId: string, startMs: number): void;
}

interface SafeImageProps {
  src: string;
  alt: string;
  className: string;
}

function SafeImage({ src, alt, className }: SafeImageProps) {
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      decoding="async"
    />
  );
}

function visibleText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_VISIBLE_TEXT_CHARACTERS) return { text, truncated: false };
  return { text: text.slice(0, MAX_VISIBLE_TEXT_CHARACTERS), truncated: true };
}

function highlightPlainText(text: string, rawQuery: string): ReactNode {
  const query = rawQuery.trim().slice(0, 200);
  const visible = visibleText(text);
  if (!query) {
    return (
      <>
        {visible.text}
        {visible.truncated ? <span className="stage-desktop-truncation">\nPreview truncated for performance.</span> : null}
      </>
    );
  }
  const foldedText = visible.text.toLocaleLowerCase();
  const foldedQuery = query.toLocaleLowerCase();
  const segments: ReactNode[] = [];
  let cursor = 0;
  let matchStart = foldedText.indexOf(foldedQuery);
  while (matchStart >= 0) {
    if (matchStart > cursor) segments.push(visible.text.slice(cursor, matchStart));
    const matchEnd = matchStart + query.length;
    segments.push(<mark key={`${matchStart}-${matchEnd}`}>{visible.text.slice(matchStart, matchEnd)}</mark>);
    cursor = matchEnd;
    matchStart = foldedText.indexOf(foldedQuery, Math.max(matchEnd, matchStart + 1));
  }
  if (cursor < visible.text.length) segments.push(visible.text.slice(cursor));
  if (visible.truncated) {
    segments.push(<span className="stage-desktop-truncation" key="truncated">\nPreview truncated for performance.</span>);
  }
  return segments;
}

function EmptyPreview({ label }: { label: string }) {
  return <p className="stage-desktop-empty-preview">{label} preview is not available yet.</p>;
}

export function ArtifactViewer({
  artifact,
  pageIndex,
  searchQuery,
  onSelectTranscriptCue,
}: ArtifactViewerProps) {
  switch (artifact.kind) {
    case "pdf":
    case "docx":
    case "pptx": {
      const safePageIndex = clampStagePageIndex(artifact, pageIndex);
      const page = artifact.content?.pages[safePageIndex];
      if (!page) return <EmptyPreview label={artifact.kind.toUpperCase()} />;
      const hasOriginalPreview = artifact.content?.originalPreviewAvailable === true;
      return (
        <article className="stage-desktop-document-page" aria-label={page.label ?? `Page ${safePageIndex + 1}`}>
          {page.title ? <h3>{page.title}</h3> : null}
          {hasOriginalPreview ? (
            <OriginalDocumentPreview
              artifactId={artifact.id}
              kind={artifact.kind}
              pageIndex={page.sourcePageIndex ?? safePageIndex}
            />
          ) : null}
          {page.previewUrl ? (
            <SafeImage
              className="stage-desktop-page-image"
              src={page.previewUrl}
              alt={page.previewAlt ?? page.label ?? `${artifact.title}, page ${safePageIndex + 1}`}
            />
          ) : null}
          {page.text ? hasOriginalPreview ? (
            <details className="stage-document-extracted-text" open={Boolean(searchQuery.trim())}>
              <summary>Extracted text</summary>
              <div className="stage-desktop-plain-text">{highlightPlainText(page.text, searchQuery)}</div>
            </details>
          ) : (
            <div className="stage-desktop-plain-text">{highlightPlainText(page.text, searchQuery)}</div>
          ) : null}
          {!hasOriginalPreview && !page.previewUrl && !page.text ? <EmptyPreview label={page.label ?? "Page"} /> : null}
        </article>
      );
    }
    case "text":
      return artifact.content ? (
        <pre className="stage-desktop-plain-text stage-desktop-text-file">
          {highlightPlainText(artifact.content.text, searchQuery)}
        </pre>
      ) : <EmptyPreview label="Text" />;
    case "image":
      return artifact.content ? (
        <figure className="stage-desktop-media-figure">
          <SafeImage className="stage-desktop-media-image" src={artifact.content.imageUrl} alt={artifact.content.alt} />
          {artifact.content.caption ? <figcaption>{highlightPlainText(artifact.content.caption, searchQuery)}</figcaption> : null}
        </figure>
      ) : <EmptyPreview label="Image" />;
    case "svg":
      return artifact.content ? (
        <figure className="stage-desktop-media-figure">
          <SafeImage
            className="stage-desktop-media-image"
            src={artifact.content.rasterPreviewUrl}
            alt={artifact.content.alt}
          />
          {artifact.content.caption ? <figcaption>{highlightPlainText(artifact.content.caption, searchQuery)}</figcaption> : null}
        </figure>
      ) : <EmptyPreview label="Drawing" />;
    case "web":
      return artifact.content ? (
        <article className="stage-desktop-web-preview">
          {artifact.content.previewImageUrl ? (
            <SafeImage
              className="stage-desktop-web-image"
              src={artifact.content.previewImageUrl}
              alt={artifact.content.previewImageAlt ?? "Web page preview"}
            />
          ) : null}
          {artifact.content.siteName ? <p className="stage-desktop-site-name">{artifact.content.siteName}</p> : null}
          {artifact.content.byline ? <p className="stage-desktop-byline">{artifact.content.byline}</p> : null}
          <div className="stage-desktop-plain-text">{highlightPlainText(artifact.content.text, searchQuery)}</div>
        </article>
      ) : <EmptyPreview label="Web page" />;
    case "video-transcript": {
      if (!artifact.content) return <EmptyPreview label="Video transcript" />;
      const cues = artifact.content.cues.slice(0, MAX_VISIBLE_TRANSCRIPT_CUES);
      return (
        <article className="stage-desktop-transcript">
          {artifact.content.posterUrl ? (
            <SafeImage
              className="stage-desktop-video-poster"
              src={artifact.content.posterUrl}
              alt={artifact.content.posterAlt ?? "Video poster"}
            />
          ) : null}
          <ol className="stage-desktop-transcript-list">
            {cues.map((cue) => (
              <li className="stage-desktop-transcript-cue" id={`stage-cue-${cue.id}`} key={cue.id}>
                <button
                  type="button"
                  className="stage-desktop-timestamp"
                  onClick={onSelectTranscriptCue
                    ? () => onSelectTranscriptCue(cue.id, cue.startMs)
                    : undefined}
                  disabled={!onSelectTranscriptCue}
                  aria-label={`Go to ${formatStageTranscriptTimestamp(cue.startMs)}`}
                >
                  {formatStageTranscriptTimestamp(cue.startMs)}
                </button>
                <p>
                  {cue.speaker ? <strong>{cue.speaker}: </strong> : null}
                  {highlightPlainText(cue.text, searchQuery)}
                </p>
              </li>
            ))}
          </ol>
          {artifact.content.cues.length > cues.length ? (
            <p className="stage-desktop-truncation">Transcript preview limited to {MAX_VISIBLE_TRANSCRIPT_CUES} cues.</p>
          ) : null}
        </article>
      );
    }
  }
}
