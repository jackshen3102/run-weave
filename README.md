# Browser Viewer

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

### Production-style local run (`pnpm start`)

```bash
# setup backend env
cp backend/.env.example backend/.env

# build all workspaces, then start one backend process
pnpm start
```

What `pnpm start` does:

- Runs `pnpm build` first.
- Verifies build artifacts exist (`backend/dist/index.js`, `frontend/dist/index.html`).
- Finds an available backend port (from `--port`, `PORT`, or default `5000`).
- Starts backend with static frontend serving (serves `frontend/dist` when present).
- Prints Vite-style access URLs, for example:
  - `Local:   http://localhost:5000/`
  - `Network: http://<your-lan-ip>:5000/`

Examples:

```bash
# specify preferred port (will auto-fallback if occupied)
pnpm start -- --port 5600

# set host/port via env
HOST=0.0.0.0 PORT=5000 pnpm start
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
- `SESSION_DB_FILE`: sqlite session DB path.
  - Default: `<BROWSER_PROFILE_DIR>/session-store.db`.
- `BROWSER_HEADLESS`: browser headless mode switch.
  - Default: `true` (headless).
  - Set to `false` to run headed for debugging.
