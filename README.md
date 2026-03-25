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
- `SESSION_DB_FILE`: sqlite session DB path.
  - Default: `<BROWSER_PROFILE_DIR>/session-store.db`.
- `BROWSER_HEADLESS`: browser headless mode switch.
  - Default: `true` (headless).
  - Set to `false` to run headed for debugging.
