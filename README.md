# Live2D AI

A full-stack, stage-first AI assistant built around Live2D. The frontend uses Vite, React, and Pixi, while the backend provides a platform-neutral Hono proxy for language models. Remote inference works with OpenAI-compatible APIs, and local GGUF models run directly in the browser through wllama.

The bundled Ice Girl assets are the default character only. The assistant personality and product interface are intentionally model-neutral, and the catalog can be adapted to another compatible Live2D model.

## Features

- Live2D expressions, actions, poses, and safe stage layouts
- Multi-step AI SDK agent with browser-side tool execution
- Direct OpenAI-compatible, same-origin Hono proxy, and local GGUF inference modes
- Web Speech and OpenAI-compatible speech recognition
- Local VITS, browser Speech Synthesis, OpenAI-compatible, and Google Cloud speech synthesis
- Streaming responses, sentence-level playback, lip sync, and user interruption
- Replaceable visual-context interface for future scene awareness

## Project structure

```text
apps/web        Vite + React web app, Live2D stage, agent, STT, and TTS
apps/api        Hono LLM proxy with thin Node and Vercel adapters
packages/shared Shared frontend/backend types and request validation
api             Vercel deployment adapter
```

The Hono core depends only on the Fetch API. Node.js is the default production host, while Vercel is an optional deployment adapter.

## Local development

Node.js 22+ and pnpm 11 are required.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm dev
```

- Web app: http://localhost:5173
- Hono API: http://localhost:8787/api/health

The proxy connects to `http://127.0.0.1:11434/v1` by default. Update `apps/api/.env` to use another OpenAI-compatible service:

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_ALLOWED_MODELS=
LLM_ALLOW_CLIENT_KEY=true
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

`LLM_BASE_URL` is controlled by the server, so browser clients cannot use the proxy to access arbitrary URLs. Public deployments that use a shared server key should also configure authentication, quotas, or platform firewall rules.

## Build and run

```bash
pnpm check
pnpm start
```

`pnpm build` creates `apps/web/dist` and `apps/api/dist/server`. The Node entry point serves both the Hono API and the built web app on one port.

Docker is also supported:

```bash
docker build -t live2d-ai .
docker run --rm -p 8787:8787 --env-file apps/api/.env live2d-ai
```

## Model and speech settings

The settings panel configures LLM, STT, and TTS providers independently, including direct Google Cloud Text-to-Speech access with your own API key. API keys are stored in `sessionStorage` by default. A key is written to `localStorage` only when **Remember this key on this device** is enabled.

The default local LLM is the `Q4_K_M` build of `unsloth/Qwen3.5-0.8B-GGUF`. Models are cached in browser OPFS storage. Multithreaded wllama requires COOP and COEP response headers; the included Vercel configuration already provides them, and other deployment platforms need equivalent headers.

Remote browser speech services must allow CORS and do not pass through the Hono LLM proxy.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```
