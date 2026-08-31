import { useEffect, useRef, useState } from "react";
import {
  getStageDocumentPreviewSource,
  type StageDocumentPreviewHandle,
  type StageOriginalDocumentKind,
} from "@/infrastructure/resources/stage-document-preview";

export interface OriginalDocumentPreviewProps {
  artifactId: string;
  kind: StageOriginalDocumentKind;
  pageIndex: number;
}

type PreviewState = "loading" | "ready" | "error";

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function OriginalDocumentPreview({
  artifactId,
  kind,
  pageIndex,
}: OriginalDocumentPreviewProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<StageDocumentPreviewHandle | undefined>(undefined);
  const requestedPageIndexRef = useRef(pageIndex);
  const [previewState, setPreviewState] = useState<PreviewState>("loading");
  requestedPageIndexRef.current = pageIndex;

  useEffect(() => {
    const container = mountRef.current;
    const source = getStageDocumentPreviewSource(artifactId);
    const controller = new AbortController();
    let active = true;
    let handle: StageDocumentPreviewHandle | undefined;
    setPreviewState("loading");

    if (!container || !source || source.kind !== kind) {
      setPreviewState("error");
      return () => controller.abort();
    }

    const initialPageIndex = requestedPageIndexRef.current;
    void source.mount(container, {
      initialPageIndex,
      signal: controller.signal,
    }).then(async (mounted) => {
      handle = mounted;
      if (!active || controller.signal.aborted) {
        mounted.dispose();
        return;
      }
      handleRef.current = mounted;
      if (requestedPageIndexRef.current !== initialPageIndex) {
        await mounted.showPage(requestedPageIndexRef.current, controller.signal);
      }
      if (active && !controller.signal.aborted) setPreviewState("ready");
    }).catch((error: unknown) => {
      if (active && !controller.signal.aborted && !isAbortError(error)) setPreviewState("error");
    });

    return () => {
      active = false;
      controller.abort(new DOMException("The document preview was closed.", "AbortError"));
      if (handleRef.current === handle) handleRef.current = undefined;
      handle?.dispose();
      container.replaceChildren();
    };
  }, [artifactId, kind]);

  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return undefined;
    const controller = new AbortController();
    void handle.showPage(pageIndex, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setPreviewState("ready");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && !isAbortError(error)) setPreviewState("error");
      });
    return () => controller.abort(new DOMException("A newer page was selected.", "AbortError"));
  }, [artifactId, pageIndex]);

  return (
    <div
      className={`stage-document-original state-${previewState}`}
      data-preview-kind={kind}
      aria-busy={previewState === "loading"}
    >
      <div className="stage-document-original-mount" ref={mountRef} />
      {previewState === "loading" ? (
        <p className="stage-document-original-status" role="status">Rendering original preview…</p>
      ) : null}
      {previewState === "error" ? (
        <p className="stage-document-original-status" role="alert">
          Original preview unavailable. Extracted text remains available below.
        </p>
      ) : null}
    </div>
  );
}
