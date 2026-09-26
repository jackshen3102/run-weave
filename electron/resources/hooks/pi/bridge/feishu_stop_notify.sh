#!/usr/bin/env bash

set -uo pipefail

# A Hook has no independent configuration source. The bound CLI owns YAML access.
[[ -n "${RUNWEAVE_RUNTIME_CONFIG_ROOT:-}" && -n "${RUNWEAVE_RUNTIME_INSTANCE_ID:-}" ]] || exit 0
LOG_FILE="${RUNWEAVE_RUNTIME_CONFIG_ROOT}/runtime/feishu-notify.log"

log() {
  local message="$1"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$message" >>"$LOG_FILE" 2>/dev/null || true
}

json_get() {
  local filter="$1"
  local fallback="${2:-}"

  if [[ -z "${PAYLOAD:-}" ]] || ! command -v jq >/dev/null 2>&1; then
    printf '%s' "$fallback"
    return
  fi

  local value
  value="$(printf '%s' "$PAYLOAD" | jq -r "$filter // empty" 2>/dev/null || true)"
  if [[ -n "$value" && "$value" != "null" ]]; then
    printf '%s' "$value"
  else
    printf '%s' "$fallback"
  fi
}

truncate_text() {
  local text="$1"
  local limit="${2:-3000}"

  if ((${#text} > limit)); then
    printf '%s\n...(truncated)' "${text:0:limit}"
  else
    printf '%s' "$text"
  fi
}

build_message_text() {
  local cwd="$1"
  local terminal_id="$2"
  local content="$3"

  cat <<EOF
路径: ${cwd}(${terminal_id})

${content}
EOF
}

format_terminal_id() {
  local raw_id="$1"

  raw_id="${raw_id#session=}"
  raw_id="${raw_id#runweave-}"
  if [[ -n "$raw_id" ]]; then
    printf '%s' "$raw_id"
  else
    printf 'unknown'
  fi
}

resolve_terminal_id() {
  local terminal_id payload_session env_session tmux_info

  terminal_id="$(json_get '.terminalId // .terminal_id // .terminalSessionId // .terminal_session_id')"
  if [[ -n "$terminal_id" ]]; then
    format_terminal_id "$terminal_id"
    return
  fi

  payload_session="$(json_get '.tmux_session_name // .tmuxSessionName')"
  if [[ -n "$payload_session" ]]; then
    format_terminal_id "$payload_session"
    return
  fi

  env_session="${RUNWEAVE_TERMINAL_SESSION_ID:-}"
  if [[ -n "$env_session" ]]; then
    format_terminal_id "$env_session"
    return
  fi

  env_session="${RUNWEAVE_TMUX_SESSION_NAME:-}"
  if [[ -n "$env_session" ]]; then
    format_terminal_id "$env_session"
    return
  fi

  if [[ -n "${TMUX:-}" ]] && command -v tmux >/dev/null 2>&1; then
    tmux_info="$(
      tmux display-message -p \
        'session=#{session_name}' \
        2>/dev/null || true
    )"
    if [[ -n "$tmux_info" ]]; then
      format_terminal_id "$tmux_info"
      return
    fi
  fi

  printf 'unknown'
}

send_app_message() {
  local text="$1"
  local rw_bin="${RUNWEAVE_RUNTIME_CONFIG_ROOT}/runtime/bin/rw"
  [[ -x "$rw_bin" ]] || return 0
  local -a rw_command=("$rw_bin")

  local notify_payload
  notify_payload="$(printf '%s' "$PAYLOAD" | jq -c --arg text "$text" '. + {notificationText:$text}' 2>/dev/null || true)"
  if [[ -z "$notify_payload" ]]; then
    log "app notify failed: invalid payload"
    return 0
  fi
  if ! printf '%s' "$notify_payload" | "${rw_command[@]}" feishu notify --stdin --json >/dev/null 2>>"$LOG_FILE"; then
    log "app notify failed: rw feishu notify returned non-zero"
  fi
}

main() {
  PAYLOAD="$(cat || true)"

  local event
  event="$(json_get '.hook_event_name // .hookEventName // .event')"
  case "$event" in
    "" | "Stop" | "stop" | "SubagentStop" | "subagent_stop") ;;
    *) return 0 ;;
  esac

  if ! command -v jq >/dev/null 2>&1; then
    log "skip: jq missing"
    return 0
  fi

  local cwd content terminal_id text extractor script_dir
  cwd="$(json_get '.cwd' "${PWD:-unknown}")"
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  extractor="${script_dir}/runweave-hook-payload.cjs"
  content="$(printf '%s' "$PAYLOAD" | "${RUNWEAVE_HOOK_NODE:-node}" "$extractor" 2>/dev/null || true)"
  if [[ -z "$content" ]]; then
    content="$(json_get '.last_assistant_message // .message // .body' '(任务已完成)')"
  fi
  content="$(truncate_text "$content" 2500)"
  terminal_id="$(resolve_terminal_id)"
  text="$(build_message_text "$cwd" "$terminal_id" "$content")"

  send_app_message "$text"
  return 0
}

main "$@" || log "unexpected failure"
exit 0
