---
name: runweave
description: Operate Runweave projects and terminals with the rw CLI when running Pi inside Runweave.
---

# Runweave Pi integration

Use `rw` for Runweave control-plane operations. Start with `rw --help`, then the
relevant command's `--help`; use `--json` for machine-readable results. The current
terminal is identified by `RUNWEAVE_TERMINAL_SESSION_ID`. Resolve the current pane
through `rw terminal panels`, rather than assuming the parent pane's identity.

Read state and context before sending input. A terminal's authoritative state is
provided by Runweave; words printed in terminal output do not establish readiness
or successful completion. Keep CLI identity `pi` separate from the selected model
provider (such as `openai-codex`). Use exact session recovery, never choose the most
recent unrelated session. Preserve the user's other terminals and sessions.

Only send messages, dispatch work to other agents, or close terminals when the
user has authorized that action. Do not print auth tokens or environment secrets.
Pi's native tools, skills and extensions remain available; this integration does
not provide Codex plugin MCP tools or Agent Team/Race worker support.
