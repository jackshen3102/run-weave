#!/usr/bin/env bash

set -uo pipefail

CONFIG_FILE="${FEISHU_NOTIFY_ENV:-${HOME}/.runweave/feishu_notify.env}"
LOG_FILE="${FEISHU_NOTIFY_LOG:-${HOME}/.runweave/feishu_notify.log}"
OPENSSL_BIN="${OPENSSL_BIN:-/opt/homebrew/bin/openssl}"

if [[ ! -f "$CONFIG_FILE" && -f /etc/runweave/feishu.env ]]; then
  CONFIG_FILE=/etc/runweave/feishu.env
fi

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

extract_last_assistant_content() {
  local transcript_path="$1"

  if [[ -z "$transcript_path" || ! -f "$transcript_path" ]]; then
    return 1
  fi

  local content
  content="$(tail -200 "$transcript_path" \
    | jq -s '[.[] | select(.message.message.role == "assistant" and .message.message.content != "" and .message.message.content != null)] | last | .message.message.content // empty' -r 2>/dev/null)"

  if [[ -n "$content" ]]; then
    printf '%s' "$content"
    return 0
  fi
  return 1
}

load_config() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    log "skip: config file missing"
    return 1
  fi

  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  return 0
}

build_message_text() {
  local agent_name="$1"
  local cwd="$2"
  local content="$3"
  local session_id="$4"
  local terminal_context="$5"
  local timestamp="$6"

  cat <<EOF
${agent_name} 任务完成

路径: ${cwd}
内容:
${content}

会话: ${session_id}
${terminal_context}
时间: ${timestamp}
当引用上述消息的时候，必须使用 runweave(rw) CLI  来发送命令或发送消息
EOF
}

format_terminal_context() {
  local raw_id="$1"

  raw_id="${raw_id#session=}"
  raw_id="${raw_id#runweave-}"
  if [[ -n "$raw_id" ]]; then
    printf 'terminalId: %s (这个终端 ID 适用于给 rw cli 发送命令)' "$raw_id"
  else
    printf 'terminalId: unknown (这个终端 ID 适用于给 rw cli 发送命令)'
  fi
}

resolve_terminal_context() {
  local terminal_id payload_session env_session tmux_info

  terminal_id="$(json_get '.terminalId // .terminal_id // .terminalSessionId // .terminal_session_id')"
  if [[ -n "$terminal_id" ]]; then
    format_terminal_context "$terminal_id"
    return
  fi

  payload_session="$(json_get '.tmux_session_name // .tmuxSessionName')"
  if [[ -n "$payload_session" ]]; then
    format_terminal_context "$payload_session"
    return
  fi

  env_session="${RUNWEAVE_TERMINAL_SESSION_ID:-}"
  if [[ -n "$env_session" ]]; then
    format_terminal_context "$env_session"
    return
  fi

  env_session="${RUNWEAVE_TMUX_SESSION_NAME:-}"
  if [[ -n "$env_session" ]]; then
    format_terminal_context "$env_session"
    return
  fi

  if [[ -n "${TMUX:-}" ]] && command -v tmux >/dev/null 2>&1; then
    tmux_info="$(
      tmux display-message -p \
        'session=#{session_name}' \
        2>/dev/null || true
    )"
    if [[ -n "$tmux_info" ]]; then
      format_terminal_context "$tmux_info"
      return
    fi
  fi

  printf 'terminalId: unknown (这个终端 ID 适用于给 rw cli 发送命令)'
}

send_webhook_message() {
  local text="$1"

  if [[ -z "${FEISHU_WEBHOOK_URL:-}" ]]; then
    return 1
  fi

  local body
  if [[ -n "${FEISHU_WEBHOOK_SECRET:-}" ]]; then
    local timestamp sign openssl_cmd
    timestamp="$(date +%s)"
    openssl_cmd="$OPENSSL_BIN"
    if [[ ! -x "$openssl_cmd" ]]; then
      openssl_cmd="$(command -v openssl || true)"
    fi
    if [[ -z "$openssl_cmd" ]]; then
      log "webhook failed: openssl not found for signed webhook"
      return 0
    fi
    sign="$(printf '' | "$openssl_cmd" dgst -sha256 -hmac "${timestamp}"$'\n'"${FEISHU_WEBHOOK_SECRET}" -binary | base64 | tr -d '\n')"
    body="$(jq -nc --arg text "$text" --arg timestamp "$timestamp" --arg sign "$sign" \
      '{timestamp:$timestamp, sign:$sign, msg_type:"text", content:{text:$text}}')"
  else
    body="$(jq -nc --arg text "$text" '{msg_type:"text", content:{text:$text}}')"
  fi

  local response
  response="$(curl --connect-timeout 3 --max-time 5 -sS \
    -H 'Content-Type: application/json' \
    -d "$body" \
    "$FEISHU_WEBHOOK_URL" 2>&1)"
  local status=$?
  if ((status != 0)); then
    log "webhook failed: curl exit ${status}"
    return 0
  fi

  local code
  code="$(printf '%s' "$response" | jq -r '.code // .StatusCode // 0' 2>/dev/null || printf '0')"
  if [[ "$code" != "0" ]]; then
    log "webhook failed: response code ${code}"
  fi
  return 0
}

send_app_message() {
  local text="$1"
  export FEISHU_APP_ID FEISHU_APP_SECRET FEISHU_TARGET_CHAT_ID
  export FEISHU_ALLOWED_OPEN_IDS FEISHU_BINDING_TTL_HOURS
  export RUNWEAVE_FEISHU_STATE_DIR
  local rw_bin
  local -a rw_command
  rw_bin="${RUNWEAVE_CLI_BIN:-$(command -v rw || true)}"
  if [[ -n "$rw_bin" && -x "$rw_bin" ]]; then
    rw_command=("$rw_bin")
  elif [[ -n "$rw_bin" && -f "$rw_bin" ]] && command -v node >/dev/null 2>&1; then
    rw_command=(node "$rw_bin")
  else
    log "app notify failed: rw CLI not found"
    return 0
  fi

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

  load_config || return 0
  if ! command -v jq >/dev/null 2>&1; then
    log "skip: jq missing"
    return 0
  fi

  local agent_name cwd content session_id terminal_context timestamp text
  agent_name="${FEISHU_AGENT_NAME:-$(json_get '.source' 'Codex')}"
  case "$agent_name" in
    codex) agent_name="Codex" ;;
    coco | trae) agent_name="Coco" ;;
    claude) agent_name="Claude" ;;
  esac
  cwd="$(json_get '.cwd' "${PWD:-unknown}")"
  session_id="$(json_get '.session_id' 'unknown')"

  # Try extracting last assistant message from transcript file
  local transcript_path
  transcript_path="$(json_get '.transcript_path')"
  # Fallback: derive transcript path from session_id
  if [[ -z "$transcript_path" || ! -f "$transcript_path" ]]; then
    transcript_path="${HOME}/Library/Caches/coco/sessions/${session_id}/events.jsonl"
  fi
  content="$(extract_last_assistant_content "$transcript_path" || true)"
  if [[ -z "$content" ]]; then
    content="$(json_get '.last_assistant_message // .message // .body' '(任务已完成)')"
  fi
  content="$(truncate_text "$content" 2500)"
  terminal_context="$(resolve_terminal_context)"
  timestamp="$(date '+%Y-%m-%d %H:%M:%S %Z')"
  text="$(build_message_text "$agent_name" "$cwd" "$content" "$session_id" "$terminal_context" "$timestamp")"

  if [[ "${FEISHU_NOTIFY_DEBUG_PAYLOAD:-0}" == "1" ]]; then
    printf '%s\n' "$PAYLOAD" >>"${HOME}/.runweave/feishu_notify_payload.log" 2>/dev/null || true
  fi

  case "${FEISHU_NOTIFY_TRANSPORT:-app}" in
    app) send_app_message "$text" ;;
    webhook) send_webhook_message "$text" ;;
    *) log "invalid FEISHU_NOTIFY_TRANSPORT" ;;
  esac
  return 0
}

main "$@" || log "unexpected failure"
exit 0
