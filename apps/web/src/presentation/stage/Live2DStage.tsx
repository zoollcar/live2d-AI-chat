import { useEffect, useRef } from "react";
import { stageLayoutIds, type StageLayoutId } from "@live2d-chat/shared";
import type { SceneController } from "@/model/live2d/scene-controller";
import { live2dCatalog } from "@/model/live2d/catalog";

interface Props {
  onReady(controller: SceneController): void;
  onError(error: Error): void;
}

export function Live2DStage({ onReady, onError }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      try {
        const [{ Application, Ticker }, { Live2DModel }, { SceneController }] = await Promise.all([
          import("pixi.js"),
          import("pixi-live2d-display-lipsyncpatch"),
          import("@/model/live2d/scene-controller"),
        ]);
        if (disposed) return;
        const canvas = document.createElement("canvas");
        canvas.className = "stage-canvas";
        host.appendChild(canvas);
        const app = new Application({
          view: canvas,
          width: host.clientWidth,
          height: host.clientHeight,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio, 2),
          backgroundAlpha: 0,
        });
        const model = await Live2DModel.from(live2dCatalog.source, { ticker: Ticker.shared });
        if (disposed) {
          app.destroy(true, { children: true });
          return;
        }
        app.stage.addChild(model);
        model.interactive = false;
        const controller = new SceneController(app, model);
        if (import.meta.env.DEV) {
          const requestedLayout = new URLSearchParams(window.location.search).get("layout");
          if (stageLayoutIds.includes(requestedLayout as StageLayoutId)) {
            controller.setStageLayout(requestedLayout as StageLayoutId);
          }
        }
        const observer = new ResizeObserver(() => {
          controller.resize(host.clientWidth, host.clientHeight);
        });
        observer.observe(host);
        onReady(controller);
        cleanup = () => {
          observer.disconnect();
          controller.dispose();
          app.destroy(true, { children: true, texture: false, baseTexture: false });
        };
      } catch (error) {
        onError(error instanceof Error ? error : new Error("Live2D model failed to load."));
      }
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [onError, onReady]);

  return <div className="stage-host" ref={hostRef} aria-label="Live2D stage" />;
}
