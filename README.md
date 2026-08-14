# Live2D AI Chat

一个以 Live2D 舞台为中心的全栈 AI Chat。前端使用 Vite、React 与 Pixi，后端使用平台无关的 Hono LLM 代理。远程模型支持任意 OpenAI-compatible API，本地模型由 wllama 在浏览器中运行。

## 功能

- Live2D 表情、动作、姿态与安全布局预设
- AI SDK 多步 Agent 与浏览器端工具调用
- OpenAI-compatible 直连、Hono 同源代理、本地 GGUF 三种 LLM 模式
- Web Speech / OpenAI-compatible 语音识别
- 本地 VITS / Browser Speech / OpenAI-compatible 语音合成
- 流式多句回复、逐句语音播放和用户打断
- 可替换的视觉上下文接口，为后续舞台识别预留

## 项目结构

```text
apps/web        Vite + React 网页、Live2D、Agent、STT/TTS
apps/api        Hono LLM 代理及 Node/Vercel 薄适配入口
packages/shared 前后端共享类型与请求校验
api             当前 Vercel 部署适配入口
```

Hono 核心只依赖 Fetch API。Node.js 是默认生产入口，Vercel 只是可替换的部署适配器。

## 本地开发

要求 Node.js 22+ 与 pnpm 11。

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
pnpm dev
```

- 网页：http://localhost:5173
- Hono API：http://localhost:8787/api/health

默认代理连接 `http://127.0.0.1:11434/v1`。可在 `apps/api/.env` 修改：

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_ALLOWED_MODELS=
LLM_ALLOW_CLIENT_KEY=true
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

`LLM_BASE_URL` 只能由服务端配置，浏览器不能借代理访问任意 URL。公开部署若使用共享服务端密钥，请同时配置访问控制、额度限制或平台防火墙。

## 构建与运行

```bash
pnpm check
pnpm start
```

`pnpm build` 会生成 `apps/web/dist` 和 `apps/api/dist/server`。Node 入口会在同一个端口提供 Hono API 与网页静态文件。

也可以使用 Docker：

```bash
docker build -t live2d-ai-chat .
docker run --rm -p 8787:8787 --env-file apps/api/.env live2d-ai-chat
```

## 模型与语音配置

网页设置中可以分别配置 LLM、STT 与 TTS。API Key 默认只进入当前标签页的 `sessionStorage`，只有勾选“在本机记住密钥”后才写入 `localStorage`。

本地 LLM 默认下载 `unsloth/Qwen3.5-0.8B-GGUF` 的 `Q4_K_M` 量化文件。模型存入浏览器 OPFS 缓存。wllama 多线程需要 COOP/COEP 响应头；Vercel 示例已经配置，其他部署平台需要添加等价响应头。

浏览器语音服务的远程 URL 必须允许 CORS，并且不会经过 Hono LLM 代理。

## 检查

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```
