# Run Project After AI

## Purpose

Use this skill when code changes are complete and you need to boot this repository reliably for local verification.

## When to use

- The user asks "how do I run this project now" after code changes.
- You finished implementation and need a consistent startup checklist.
- You need dev mode (`pnpm dev`) or production-style local run (`pnpm start`).

## Repo facts

- Package manager: `pnpm@10.6.2`
- Workspaces: `frontend`, `backend`, `packages/shared`
- Required backend env vars: `AUTH_USERNAME`, `AUTH_PASSWORD`, `AUTH_JWT_SECRET`
- Default backend preferred port: `5000`

## Quick start flow

1. Install dependencies.
2. Prepare backend env file.
3. Choose run mode:
   - Development mode: backend + frontend dev servers
   - Production-style local mode: build first, then one backend process serving `frontend/dist`

## Commands

### 1) Install

```bash
pnpm install
```

### 2) Prepare env

```bash
cp backend/.env.example backend/.env
```

Then set at least:

- `AUTH_USERNAME`
- `AUTH_PASSWORD`
- `AUTH_JWT_SECRET`

### 3A) Development mode (recommended for coding)

```bash
pnpm dev
```

Optional headed browser mode:

```bash
BROWSER_HEADLESS=false pnpm dev
```

### 3B) Production-style local run

```bash
pnpm start
```

Optional preferred port:

```bash
pnpm start -- --port 5600
```

`pnpm start` behavior:

- Runs `pnpm build`
- Verifies artifacts (`backend/dist/index.js`, `frontend/dist/index.html`)
- Finds an available backend port
- Starts backend and serves static frontend when `frontend/dist` exists
- Prints Local/Network URLs

## Health checks

- Backend health: `GET /health`
- If frontend opens but API fails, verify `backend/.env` and backend logs.

## Common issues

- `Failed to bind server ...`: port in use. Use `--port` or free port.
- `missing required environment variable`: fill required auth vars in `backend/.env`.
- restore session warnings on startup: stale persisted sessions from old targets; clear session DB/profile if needed.

## Optional verification commands

```bash
pnpm lint
pnpm typecheck
pnpm test
```
