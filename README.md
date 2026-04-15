# Runweave

Runweave is a 24/7 CLI-first agent workspace for turning ideas into running
programs from anywhere. The current implementation combines a browser viewer,
terminal workspace, AI bridge, Express/WebSocket backend, Playwright control
plane, and Electron desktop client.

Note: the code namespace still uses `browser-viewer` in package names, protocol
identifiers, storage keys, and some internal paths. Treat those as technical
identifiers until a separate code-level rename is done.

## Run modes

### Development

```bash
# setup backend env
cp backend/.env.example backend/.env

# start backend + frontend dev servers
pnpm dev

# headed browser mode for debugging
BROWSER_HEADLESS=false pnpm dev
```

### Production run (`pnpm start`)

```bash
# setup backend env
cp backend/.env.example backend/.env

# build all workspaces
pnpm build

# start backend for nginx proxying
pnpm start
```

What `pnpm start` does:

- Starts backend only.
- Binds Node to `127.0.0.1:5001`.
- Intended for Nginx reverse proxy deployment.

Examples:

```bash
pnpm --filter ./backend start -- --host 127.0.0.1 --port 5001
```

## Backend environment variables

- `PORT`: backend preferred service port (default: `5000`).
- `FRONTEND_ORIGIN`: allowed frontend origins for CORS, comma-separated.
- `AUTH_USERNAME`: login username (set to `admin`).
- `AUTH_PASSWORD`: login password.
- `AUTH_JWT_SECRET`: signing secret for auth token.
- `AUTH_TOKEN_TTL_SECONDS`: auth token TTL in seconds (default: `28800`).
- `BROWSER_PROFILE_DIR`: persistent browser profile directory used by Playwright.
  - Default: `~/.browser-profile`.
  - Set this to a custom path if you want to reuse or isolate login state.
- `SESSION_STORE_FILE`: persisted browser session store path.
  - Default: `<BROWSER_PROFILE_DIR>/session-store.json`.
- `TERMINAL_SESSION_STORE_FILE`: persisted terminal session store path.
  - Default: `<BROWSER_PROFILE_DIR>/terminal-session-store.json`.
- `BROWSER_HEADLESS`: browser headless mode switch.
  - Default: `true` (headless).
  - Set to `false` to run headed for debugging.

## License

MIT
