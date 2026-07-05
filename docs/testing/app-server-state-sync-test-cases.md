# App Server State Sync Test Cases

本文档记录当前仓库内 App Server “轻量状态中心 + 本地云同步模拟”阶段的验证入口。原始计划来自同仓库族的 app-server state sync 测试计划。

实现和验证均在当前 checkout 内执行。

## Commands

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
pnpm app-server:verify-state-sync
git diff --check
```

`pnpm app-server:verify-state-sync` 使用临时 `RUNWEAVE_APP_SERVER_STATE_DIR` 和临时 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR`，不会污染默认：

```text
~/.runweave/app-server-cloud-sync-sim/
```

## Automated Coverage

`scripts/verify-app-server-state-sync.mjs` 覆盖以下核心路径：

- ASTS-001：`agent.hook SessionStart` 创建 ThreadRef，并写入 projection JSONL。
- ASTS-002：`UserPromptSubmit` 更新 ThreadRef / AgentSessionRef 为 `running`。
- ASTS-003：`Stop` 更新 ThreadRef / AgentSessionRef 为 `idle`。
- ASTS-004：`agent.completion hook_stop + rawHookEvent=Stop` 兜底更新为 `idle`。
- ASTS-005：`notify` completion 不覆盖 `running`。
- ASTS-006：`ai_process_exit` 更新为 `completed`。
- ASTS-007：不同 agent/thread 隔离。
- ASTS-008：同一 terminal 下不同 panel/thread 隔离。
- ASTS-009：缺失 threadId 时使用 `agent + terminalSessionId + terminalPanelId + sourceInstanceId` 降级 key，并在后续真实 threadId 到达时迁移。
- ASTS-010：相同 `dedupeKey` 不重复投影。
- ASTS-011：App Server 重启后从 event log 恢复 projection。
- ASTS-012：删除 state JSON 后从 event log 重建 projection。
- ASTS-013：本地同步目录写入事件镜像。
- ASTS-014：本地同步目录写入 latest projection。
- ASTS-015：cursor 与 manifest 持久化，不随重启回退。
- ASTS-016：同步目录不可用时 `/events` 和 projection 仍成功，`/sync/status` 暴露 degraded。
- ASTS-017：状态查询 API 与 `/events` 一致要求 bearer token。
- ASTS-018：状态查询支持 project、terminalSession、terminalPanel、agent、status、limit/after 过滤。
- ASTS-019：`/events/stream` 推送 `thread.state.changed` 与 `agent_session.state.changed`。
- ASTS-027：latest projection 和 sync manifest 不复制 token/Authorization 等敏感字段。
- ASTS-028：大量事件分页和 sync mirror 完整性。

## Runtime / Real Scenario Coverage

- ASTS-020 Backend 状态补齐仍依赖现有 `backend/src/app-server/event-consumer.ts` 消费原始 `agent.hook` / `agent.completion`，并复用 `TerminalStateService`。本阶段没有让 backend 直接 import `app-server/src/*`。
- ASTS-021 ownership 过滤仍由 `backend/src/app-server/ownership.ts` 控制：只消费属于当前 backend project/session 的事件。
- ASTS-022 hook double-write 兼容由 `pnpm toolkit:verify-hooks` 和 `pnpm app-server:verify` 共同覆盖。
- ASTS-023 至 ASTS-026 是真实 Codex/Web/App 场景验收，涉及 UI 时必须使用 `$playwright-cli` 记录证据；当前自动化脚本不冒充这些浏览器/人工场景。

## API

受 bearer token 保护：

- `GET /threads?projectId=&terminalSessionId=&terminalPanelId=&agent=&status=&limit=&after=`
- `GET /threads/:threadId`
- `GET /agent-sessions?projectId=&terminalSessionId=&terminalPanelId=&agent=&status=&limit=&after=`
- `GET /sync/status`

仍无需 token：

- `GET /healthz`
- `GET /readyz`
