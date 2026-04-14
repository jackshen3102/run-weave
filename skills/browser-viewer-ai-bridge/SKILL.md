---
name: browser-viewer-ai-bridge
description: Use when work must attach to a browser created by Runweave instead of launching a separate Playwright browser, especially for E2E checks, difficult debugging, screenshots, or tasks that explicitly require the ai-default -> ai-bridge workflow before handing control to playwright-cli or another CDP-capable tool.
---

# Runweave AI Bridge

## Purpose

Use this skill to obtain a reusable AI bridge URL from the local Runweave
backend, using the project's default AI session when possible.

Note: the skill `name` remains `browser-viewer-ai-bridge` for compatibility with
the current local skill registry. The product name is Runweave.

This skill only covers the bootstrap phase:

1. authenticate to the backend
2. resolve or create the default AI viewer session
3. request the AI bridge URL
4. return `sessionId` and `bridgeUrl`

After that, hand control to `playwright-cli` or another CDP-capable tool.

## Hard Rule

- Do not launch a separate Playwright browser when this skill is in use.
- Always attach to the browser that Runweave created.

## Use Cases

- E2E checks that must share the same Runweave viewer session
- hard-to-reproduce debugging that benefits from the live viewer
- screenshots or inspection tasks that must run through viewer-managed browser state
- user instructions like "must use viewer", "reuse AI viewer", "through ai-bridge", or "不要自己起一个 playwright"

## Preconditions

- The project dev servers are already running, typically via `pnpm dev`
- The backend is reachable, typically `http://127.0.0.1:5003`
- Valid login credentials are available

## Workflow

### 1. Log in

Request:

```http
POST /api/auth/login
Content-Type: application/json
```

Body:

```json
{
  "username": "admin",
  "password": "admin"
}
```

Use the actual project credentials if they differ.

Read `accessToken` from the response.

### 2. Ensure the default AI session

First choice:

```http
GET /api/session/ai-default
Authorization: Bearer <accessToken>
```

If it returns `404`, create or reuse one with:

```http
POST /api/session/ai-default/ensure
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Optional body:

```json
{
  "name": "AI Viewer"
}
```

Read `sessionId` from the response.

### 3. Request the AI bridge

```http
POST /api/session/:id/ai-bridge
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Typical body:

```json
{}
```

Read `bridgeUrl` from the response.

### 4. Hand off

Return this result shape to the next step:

```json
{
  "sessionId": "<session-id>",
  "bridgeUrl": "ws://127.0.0.1:5003/ws/ai-bridge?sessionId=<session-id>"
}
```

Then hand off to:

- `playwright-cli`
- a Playwright script using `chromium.connectOverCDP(bridgeUrl)`
- another CDP-capable debugging tool

## Recommended Handoff

For `playwright-cli`, the next step should explicitly use the bridge-backed browser
session and continue with page navigation, snapshots, screenshots, or debugging.

For Playwright code, attach with:

```ts
const browser = await chromium.connectOverCDP(bridgeUrl);
```

## Output Contract

At minimum, report:

- `sessionId`
- `bridgeUrl`

If a page action is also performed afterwards, additionally report:

- final page URL
- page title
- artifact path such as screenshot or trace path

## Failure Checks

- `401` on auth or session routes: credentials expired or missing
- `404` on `GET /api/session/ai-default`: no default AI session exists yet
- `404` on `POST /api/session/:id/ai-bridge`: session was deleted or backend state changed
- websocket attach failure: backend is up, but the target browser session is not healthy

## Notes

- This skill is intentionally narrow. It does not own page interactions.
- If the task is "open site, click, type, screenshot", this skill only gets the bridge; the browser actions belong to `playwright-cli`.
