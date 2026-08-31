# Live2D AI

A stage-first AI assistant built around Live2D. The static web app uses Vite, React, and Pixi. User-authorized remote requests run through a Manifest V3 companion extension, while local GGUF models run directly in the browser through wllama.

The bundled Ice Girl assets are the default character only. The assistant personality and product interface are intentionally model-neutral, and the catalog can be adapted to another compatible Live2D model.

## Features

- Live2D expressions, actions, poses, and safe stage layouts
- Multi-step AI SDK agent with browser-side tool execution
- Companion-extension, direct OpenAI-compatible, Chrome built-in, and local GGUF inference modes
- Web Speech and OpenAI-compatible speech recognition
- Local VITS, browser Speech Synthesis, OpenAI-compatible, and Google Cloud speech synthesis
- Streaming responses, sentence-level playback, lip sync, and user interruption
- File, image, web-page, and public-video transcript resources shared by every agent route
- A single Live2D stage content window with navigation, search, progress, retry, cancel, and tray controls
- Safe static SVG drawings plus a bundled 12-image, no-text Ice Girl sticker pack
- ZIP v2 conversation archives containing original files, extracted text, and generated artifacts

## Project structure

```text
apps/web        Vite + React web app, Live2D stage, agent, STT, and TTS
apps/extension  WXT Manifest V3 companion extension and permissioned network bridge
packages/shared Shared web/extension types and protocol validation
```

## Local development

Node.js 22+ and pnpm 11 are required.

```bash
pnpm install
pnpm dev
```

- Web app: http://localhost:5173
- Extension development build: `apps/extension/.output/chrome-mv3-dev`

Load the extension output in Chrome or Edge 116+ as an unpacked extension from `chrome://extensions`, open its popup on the web app, and choose **Connect this site**. Known provider origins are included in the extension manifest. Grant custom model or read-page origins individually from the popup; granted optional origins can also be revoked there.

The page bridge is nonce-bound to one connected top-level origin. It accepts only the shared `models`, `chat`, `transcribe`, `synthesize`, `vision`, `exa`, `supadata`, and `read-page` operations. The page cannot supply arbitrary headers: credentials stay in validated request frames, are converted to provider-specific authentication headers inside the extension, and are never persisted by the extension. Bodies and responses use acknowledged 256 KiB chunks with cancellation and a 100 MiB transfer ceiling.

## Build and run

```bash
pnpm check
pnpm start
```

`pnpm build` creates the static web output in `apps/web/dist`, side-loadable Chrome and Edge extensions in `apps/extension/.output/chrome-mv3` and `apps/extension/.output/edge-mv3`, plus both ZIP packages in `apps/extension/.output`. `pnpm start` previews the static web build.

Docker is also supported:

```bash
docker build -t live2d-ai .
docker run --rm -p 8080:8080 live2d-ai
```

## Model and speech settings

The settings panel configures LLM, STT, and TTS providers independently, including direct Google Cloud Text-to-Speech access with your own API key. API keys are stored in `sessionStorage` by default. A key is written to `localStorage` only when **Remember this key on this device** is enabled. The extension accepts credentials only through the validated request protocol and constructs authentication headers itself.

The default local LLM is the `Q4_K_M` build of `unsloth/Qwen3.5-0.8B-GGUF`. Models are cached in browser OPFS storage. Multithreaded wllama requires COOP and COEP response headers; the included Vercel configuration already provides them, and other deployment platforms need equivalent headers.

The companion extension handles approved cross-origin HTTP requests. Gemini Live WebSocket audio and browser-local providers remain in the web page.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
