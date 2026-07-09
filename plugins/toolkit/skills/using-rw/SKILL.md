---
name: using-rw
description: "Use the Runweave `rw` CLI for agent control-plane work: health, auth, app discovery, projects, terminals, input delivery, context snapshots, handoff, and explicit cleanup."
---

# Runweave CLI with rw

## Quick start

```bash
# inside the Runweave source checkout
pnpm cli:build
RW_BIN=(node packages/runweave-cli/dist/index.js)
export RUNWEAVE_BACKEND_PORT="${RUNWEAVE_BACKEND_PORT:-5001}"

"${RW_BIN[@]}" health --json
"${RW_BIN[@]}" app overview --json

PROJECT_ID="$("${RW_BIN[@]}" project ensure --name runweave --path "$PWD" --json | jq -r '.projectId')"
TERMINAL_ID="$("${RW_BIN[@]}" terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json | jq -r '.terminalSessionId')"

"${RW_BIN[@]}" terminal send "$TERMINAL_ID" --text "pwd" --mode line --json
"${RW_BIN[@]}" terminal history "$TERMINAL_ID" --tail 120 --plain
"${RW_BIN[@]}" terminal delete "$TERMINAL_ID" --json
```

## Command entry

```bash
# source checkout: prefer the current built artifact
pnpm cli:build
RW_BIN=(node packages/runweave-cli/dist/index.js)

# installed environment
RW_BIN=(rw)

"${RW_BIN[@]}" version --json
```

## Core commands

```bash
"${RW_BIN[@]}" health --json
"${RW_BIN[@]}" health --backend-port 5111 --json
"${RW_BIN[@]}" app overview --json
"${RW_BIN[@]}" auth status --json
"${RW_BIN[@]}" auth login --username admin --json
```

## Projects

```bash
"${RW_BIN[@]}" project list --json
"${RW_BIN[@]}" project ensure --name runweave --path "$PWD" --json
```

## Terminals

```bash
"${RW_BIN[@]}" terminal list --json
"${RW_BIN[@]}" terminal show "$TERMINAL_ID" --json
"${RW_BIN[@]}" terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --json
"${RW_BIN[@]}" terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --command bash --arg -lc --arg "echo ok" --json
"${RW_BIN[@]}" terminal create --project-id "$PROJECT_ID" --cwd "$PWD" --runtime pty --command bash --arg -lc --arg "exit 0" --json
"${RW_BIN[@]}" terminal create --inherit-from "$TERMINAL_ID" --json
"${RW_BIN[@]}" terminal delete "$TERMINAL_ID" --json
```

`terminal create` returns after the backend creates the session. If a command was
provided with `--command` / `--arg`, do not assert its output immediately. Poll
`terminal history --json` or `terminal snapshot --json` and inspect `.tail`:

```bash
COMMAND_TERMINAL_ID="$(
  "${RW_BIN[@]}" terminal create \
    --project-id "$PROJECT_ID" \
    --cwd "$PWD" \
    --command bash --arg -lc --arg "echo RW_COMMAND_OK; sleep 5" \
    --json | jq -r '.terminalSessionId'
)"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  "${RW_BIN[@]}" terminal history "$COMMAND_TERMINAL_ID" --tail 80 --json \
    | jq -e '(.tail | contains("RW_COMMAND_OK"))' >/dev/null && break
  sleep 0.5
done
```

## Send input

```bash
"${RW_BIN[@]}" terminal send "$TERMINAL_ID" --text "pwd" --mode line --json
"${RW_BIN[@]}" terminal send "$TERMINAL_ID" --text "raw bytes" --mode raw --json
"${RW_BIN[@]}" terminal send "$TERMINAL_ID" --text "/compact" --mode codex_slash_command --json
"${RW_BIN[@]}" terminal send "$TERMINAL_ID" --agent codex --text "继续" --json
"${RW_BIN[@]}" terminal send "$TERMINAL_ID" --agent traex --agent-overwrite --text "继续" --json
printf 'pwd' | "${RW_BIN[@]}" terminal send "$TERMINAL_ID" --stdin --mode line --json
printf '%s' 'printf "%s\n" RW_STDIN_OK' \
  | "${RW_BIN[@]}" terminal send "$TERMINAL_ID" --stdin --mode line --json
```

`terminal send` success means the backend accepted the input. It does not mean the shell command or AI task finished.
When `--agent <name>` is set, rw first ensures the terminal is in that exact
agent's `agent_idle` or `agent_running` state. Agent names are not normalized:
`trae`, `traecli`, and `traex` are distinct. If another agent is already active,
pass `--agent-overwrite`; rw sends `--agent-exit-command`, starts the requested
agent, waits for it, then sends the input. If `--agent-exit-command` is omitted,
rw defaults to `/quit` for `codex`, `traex`, and `traecli`, and `/exit` for
other agents. If the same agent is already active and `--agent-overwrite` is set, rw sends
`--agent-clear-command` (default `/clear`) before sending the input. With
`--agent`, omitted `--mode` defaults to `line`.
When building stdin payloads that contain escapes, prefer `printf '%s' '...'`
so the local shell does not turn `\n` into a real newline before Runweave sends
the command.

## Read context

```bash
"${RW_BIN[@]}" terminal state "$TERMINAL_ID" --json
"${RW_BIN[@]}" terminal snapshot "$TERMINAL_ID" --tail 120 --json
"${RW_BIN[@]}" terminal snapshot "$TERMINAL_ID" --tail 120 --plain
"${RW_BIN[@]}" terminal history "$TERMINAL_ID" --tail 200 --json
"${RW_BIN[@]}" terminal history "$TERMINAL_ID" --tail 200 --plain
"${RW_BIN[@]}" terminal handoff "$TERMINAL_ID" --tail 120 --json
```

For `terminal snapshot --json` and `terminal history --json`, the output is the
session payload plus a string `tail` field. There is no `.text` field. Machine
checks should inspect `.tail` or `.scrollback`, for example:

```bash
"${RW_BIN[@]}" terminal snapshot "$TERMINAL_ID" --tail 120 --json \
  | jq -e '(.tail | contains("expected text"))'
"${RW_BIN[@]}" terminal history "$TERMINAL_ID" --tail 200 --json \
  | jq -e '(.tail | contains("expected text"))'
```

## Output modes

Use `--json` for machine parsing. Use `--plain` only when the agent needs terminal text.

## Auth and config

```bash
export RUNWEAVE_BACKEND_PORT="${RUNWEAVE_BACKEND_PORT:-5001}"
export RUNWEAVE_CONFIG_FILE="$(mktemp -d)/runweave-config.json"
```

Use `RUNWEAVE_BACKEND_PORT` to point rw at a local backend port other than the
default `5001`:

```bash
export RUNWEAVE_BACKEND_PORT=5111
"${RW_BIN[@]}" health --json
```

Use `--backend-port` for a single rw invocation:

```bash
"${RW_BIN[@]}" health --backend-port 5111 --json
"${RW_BIN[@]}" terminal list --backend-port 5111 --json
```

Use `RUNWEAVE_BASE_URL` directly when the backend is not on `127.0.0.1` or when
the URL needs a custom scheme, host, or path. `RUNWEAVE_BASE_URL` takes
precedence over `RUNWEAVE_BACKEND_PORT`; explicit `--backend-port` takes
precedence over both environment variables.

Prefer `RUNWEAVE_ACCESS_TOKEN` or an existing profile. In non-interactive environments, do not run bare `rw auth login`; pass credentials via stdin or ask the host to provide a token.

## Safety rules

Use exact IDs returned by `project ensure`, `terminal create`, `terminal list`, or `app overview`. Do not infer terminal IDs from names. Only delete terminal sessions explicitly created or explicitly provided for cleanup.
