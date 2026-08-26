# Repository Guidelines

## Project Structure & Module Organization

This repository is a pnpm workspace written in TypeScript.

- `apps/web/`: Vite + React client. Domain code is grouped under `agent/`, `interaction/`, `model/`, `infrastructure/`, and `presentation/`.
- `apps/api/`: Hono API and LLM proxy. Keep runtime-specific code in `src/adapters/`; shared request handling belongs in `src/app.ts`.
- `packages/shared/`: types and Zod schemas used by both applications.
- `api/`: thin Vercel adapter; `apps/web/public/` contains static assets.
- Tests live beside source files as `*.test.ts`. Generated output under `dist/` must not be edited manually.

## Build, Test, and Development Commands

Use Node.js 22+ and pnpm 11.

- `pnpm install`: install all workspace dependencies.
- `cp apps/api/.env.example apps/api/.env`: create local API configuration.
- `pnpm dev`: run the web app on port 5173 and API on port 8787.
- `pnpm dev:fresh`: clear Vite caches before starting development.
- `pnpm typecheck`: run TypeScript checks across all packages.
- `pnpm lint`: run ESLint with zero warnings allowed.
- `pnpm test` or `pnpm test:coverage`: run Vitest once, optionally with V8 coverage.
- `pnpm build`: build/check shared, API, and web packages.
- `pnpm check`: run the complete typecheck, lint, test, and build gate.

## Coding Style & Naming Conventions

Follow the existing style: two-space indentation, semicolons, double quotes, and ES modules. Use `PascalCase` for React components and types, `camelCase` for variables/functions, and kebab-case filenames for non-component modules (for example, `sentence-segmenter.ts`). Prefer the `@/` alias for imports rooted at `apps/web/src`. Prefix intentionally unused parameters or variables with `_` to satisfy ESLint.

## Testing Guidelines

Vitest discovers `apps/**/*.test.ts` and `packages/**/*.test.ts`; browser-oriented tests use jsdom and Testing Library where appropriate. Add focused tests beside changed behavior and describe observable outcomes. There is no fixed coverage threshold, but new logic should cover success, failure, and boundary cases. Run `pnpm check` before opening a pull request.

## Commit & Pull Request Guidelines

Recent commits favor concise, imperative Conventional Commit subjects, usually scoped: `feat(web): add provider`, `fix(api): validate origin`, or `chore: update tooling`. Keep commits focused and avoid committing local `.env` files or generated artifacts. Pull requests should explain the behavior change, list validation performed, link relevant issues, and include screenshots or recordings for visible UI changes. Call out configuration, security, or deployment impacts explicitly.

## Security & Configuration

Never commit API keys. Keep server-controlled LLM endpoints and origin allowlists in `apps/api/.env`. Treat client-side remembered credentials and changes to proxy, CORS, or deployment headers as security-sensitive.
