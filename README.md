# Browser Viewer

## Backend environment variables

- `PORT`: backend service port (default: `5001`).
- `FRONTEND_ORIGIN`: allowed frontend origins for CORS, comma-separated.
- `AUTH_USERNAME`: login username (set to `admin`).
- `AUTH_PASSWORD`: login password.
- `AUTH_JWT_SECRET`: signing secret for auth token.
- `AUTH_TOKEN_TTL_SECONDS`: auth token TTL in seconds (default: `28800`).
- `BROWSER_PROFILE_DIR`: persistent browser profile directory used by Playwright.
  - Default: `./.browser-profile` (relative to repository root).
  - Set this to a custom path if you want to reuse or isolate login state.
- `BROWSER_HEADLESS`: browser headless mode switch.
  - Default: `true` (headless).
  - Set to `false` to run headed for debugging.

Examples:

```bash
# Setup backend env
cp backend/.env.example backend/.env

# Default headless
pnpm dev

# Headed debug mode
BROWSER_HEADLESS=false pnpm dev

# Custom profile with headless mode
BROWSER_PROFILE_DIR="/tmp/browser-viewer-profile" pnpm --filter ./backend dev
```
