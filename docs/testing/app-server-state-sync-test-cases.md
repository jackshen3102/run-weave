# App Server 状态中心与本地云同步模拟测试计划

## 范围

本测试计划覆盖 App Server 从“事件中转中心”升级为“轻量状态中心 + 本地云同步模拟入口”的第一阶段能力。

目标能力包括：

1. App Server 继续接收、持久化并推送 `agent.hook` / `agent.completion` 等事件。
2. App Server 从事件投影出轻量 Thread 状态，不保存 thread 详情正文。
3. App Server 提供状态查询接口，让外部可读取当前 thread 状态。
4. App Server 将事件和投影状态同步到本地固定目录，用于模拟后续云端同步。
5. Backend / Web / App 真实场景中可以通过 App Server 状态或事件链路补齐终端状态。

本计划只覆盖测试与验收，不要求在执行本计划前实现具体代码。实现完成后，必须按本计划进行验证。

## 非目标

- 不把 Codex / Trae / TraeCLI / Traex 的完整 thread 内容复制进 App Server。
- 不实现真实云端上传、账号体系、团队空间、远程冲突合并或加密存储。
- 不新增单元测试文件。本仓库验证方式仍以 `pnpm typecheck`、`pnpm lint`、app-server 验证脚本、Playwright E2E 和真实行为核对为主。
- 不让 hook bridge 自动启动 App Server。
- 不让 backend 直接 import `app-server/src/*`。
- 不改变现有 `/events` append-only 事件语义。

## 固定本地同步目录

第一阶段用本地固定目录模拟云端同步：

```bash
~/.runweave/app-server-cloud-sync-sim/
```

实现允许提供测试覆盖用的环境变量覆盖目录，例如：

```bash
RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR=/tmp/runweave-app-server-cloud-sync-sim
```

但默认行为必须落到上面的固定目录。所有测试中涉及真实用户默认目录的场景，必须先说明并得到人工确认；自动化和开发验证优先使用临时覆盖目录。

建议同步目录结构：

```text
app-server-cloud-sync-sim/
  events/
    app-server-events.jsonl
  projections/
    threads.jsonl
    latest-threads.json
  cursors/
    upload-cursor.json
  manifests/
    sync-manifest.json
```

## 术语与轻量状态模型

### ThreadRef

ThreadRef 是 App Server 持有的轻量 thread 索引，不保存完整详情。

必需字段：

- `threadId`
- `agent`
- `status`
- `projectId`
- `terminalSessionId`
- `terminalPanelId`
- `cwd`
- `lastEventId`
- `lastActivityAt`
- `updatedAt`

可选字段：

- `runId`
- `detailRef`
- `sourceInstanceId`
- `lastHookEvent`
- `lastCompletionReason`

### 状态枚举

第一阶段至少覆盖：

- `starting`
- `running`
- `idle`
- `completed`
- `failed`
- `unknown`

映射规则：

- `agent.hook` + `SessionStart` -> `starting`
- `agent.hook` + `UserPromptSubmit` -> `running`
- `agent.hook` + `Stop` -> `idle`
- `agent.completion` + `completionReason=hook_stop` -> `idle`
- `agent.completion` + `completionReason=ai_process_exit` -> `completed`
- 无法解释的事件不应覆盖已有明确状态，只能更新事件日志。

## 预期命令

实现完成后至少执行：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/app-server typecheck
pnpm --filter @runweave/app-server lint
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm app-server:verify
pnpm app-server:verify-cli-start
pnpm toolkit:verify-hooks
git diff --check
```

当前仓库已提供自动化入口时，必须一并执行：

```bash
pnpm app-server:verify-state-sync
```

`pnpm app-server:verify-state-sync` 使用临时 `RUNWEAVE_APP_SERVER_STATE_DIR` 和临时 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR`，不得污染默认 `~/.runweave/app-server-cloud-sync-sim/`。

如果新增验证脚本，建议命名：

```bash
pnpm app-server:verify-state-sync
```

该脚本应使用临时 `RUNWEAVE_APP_SERVER_STATE_DIR` 和临时 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR`，不得污染用户默认目录。

## 当前自动化覆盖

`scripts/verify-app-server-state-sync.mjs` 覆盖以下核心路径：

- ASTS-001：`agent.hook SessionStart` 创建 ThreadRef，并写入 projection JSONL。
- ASTS-002：`UserPromptSubmit` 更新 ThreadRef 为 `running`。
- ASTS-003：`Stop` 更新 ThreadRef 为 `idle`。
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
- ASTS-019：`/events/stream` 推送 `thread.state.changed`。
- ASTS-027：latest projection 和 sync manifest 不复制 token/Authorization 等敏感字段。
- ASTS-028：大量事件分页和 sync mirror 完整性。

真实 Codex/Web/App 场景验收涉及 UI 时必须使用 `$playwright-cli` 记录证据；自动化脚本不冒充这些浏览器/人工场景。

## 测试数据约定

测试用固定标识：

```text
projectId: project-state-sync-001
terminalSessionId: terminal-state-sync-001
terminalPanelId: panel-main-001
runId: run-state-sync-001
threadId: thread-state-sync-001
agent: codex
cwd: /tmp/runweave-state-sync
```

受 bearer token 保护的状态 API：

- `GET /threads?projectId=&terminalSessionId=&terminalPanelId=&agent=&status=&limit=&after=`
- `GET /threads/:threadId`
- `GET /sync/status`

事件源：

```json
{
  "app": "hook",
  "instanceId": "hook-state-sync-test",
  "pid": 12345
}
```

## ASTS-001 事件写入后创建 ThreadRef

步骤：

1. 使用临时 state dir 和 cloud sync dir 启动 App Server。
2. `POST /events` 写入 `agent.hook`：
   - `scope.projectId=project-state-sync-001`
   - `scope.terminalSessionId=terminal-state-sync-001`
   - `scope.terminalPanelId=panel-main-001`
   - `correlationId=thread-state-sync-001`
   - `payload.source=codex`
   - `payload.stateHookEvent=SessionStart`
3. 调用状态查询接口读取 thread 状态。
4. 读取本地同步目录中的 projection 文件。

预期：

- `/events` 返回 `201`。
- ThreadRef 被创建。
- `threadId=thread-state-sync-001`。
- `agent=codex`。
- `status=starting`。
- `projectId`、`terminalSessionId`、`terminalPanelId`、`cwd` 与事件 scope/payload 一致。
- `lastEventId` 等于刚写入的事件 id。
- 本地同步目录中存在该 ThreadRef 的增量记录。

失败判断：

- 只写入 event log 但没有 ThreadRef。
- ThreadRef 保存了完整 thread 详情正文。
- `terminalPanelId` 丢失。

## ASTS-002 UserPromptSubmit 更新为 running

步骤：

1. 先执行 ASTS-001。
2. 写入同一 `threadId` 的 `agent.hook`，`payload.stateHookEvent=UserPromptSubmit`。
3. 查询 ThreadRef。

预期：

- ThreadRef `status=running`。
- `lastEventId` 推进到最新事件。
- WebSocket `/events/stream` 订阅者收到 live event。
- 如果实现了状态变化事件，订阅者还应收到 thread 状态变化事件。

失败判断：

- 状态仍停留在 `starting`。
- 写入重复 ThreadRef，导致同一 `threadId` 有多个 latest 记录。

## ASTS-003 Stop 更新为 idle

步骤：

1. 先让 ThreadRef 进入 `running`。
2. 写入同一 `threadId` 的 `agent.hook`，`payload.stateHookEvent=Stop`。
3. 查询 ThreadRef 和 `/events`。

预期：

- ThreadRef `status=idle`。
- 原始 Stop 事件仍可通过 `/events` 查到。
- projection 中 `lastHookEvent=Stop`。

失败判断：

- 仅记录 completion 通知，但状态不变。
- 直接删除 ThreadRef。

## ASTS-004 completion hook_stop 兜底更新为 idle

步骤：

1. 先让 ThreadRef 进入 `running`。
2. 不发送 `agent.hook Stop`。
3. 写入 `agent.completion`：
   - `payload.source=codex`
   - `payload.completionReason=hook_stop`
   - `payload.rawHookEvent=Stop`
4. 查询 ThreadRef。

预期：

- 状态从 `running` 更新为 `idle`。
- projection 保留 `lastCompletionReason=hook_stop`。
- 该逻辑与现有 backend completion fallback 语义一致。

失败判断：

- `notify`、`manual` 或无 `rawHookEvent=Stop` 的普通 completion 也把状态改为 idle。

## ASTS-005 普通 completion 不覆盖 running

步骤：

1. 先让 ThreadRef 进入 `running`。
2. 写入 `agent.completion`，`completionReason=notify`。
3. 查询 ThreadRef。

预期：

- ThreadRef 仍为 `running`。
- 原始 completion event 仍保留。
- projection 可更新 `lastEventId` 或保留当前状态，具体以实现约定为准，但不得把状态误改为 idle/completed。

失败判断：

- 任意 completion 都结束 running 状态。

## ASTS-006 ai_process_exit 更新为 completed

步骤：

1. 先让 ThreadRef 进入 `running`。
2. 写入 `agent.completion`，`completionReason=ai_process_exit`。
3. 查询 ThreadRef。

预期：

- ThreadRef `status=completed`。
- `lastCompletionReason=ai_process_exit`。

失败判断：

- 与 `hook_stop` 混淆为 `idle`。

## ASTS-007 多 agent 隔离

步骤：

1. 写入 Codex thread `thread-state-sync-001` 的 `UserPromptSubmit`。
2. 写入 Trae thread `thread-state-sync-trae-001` 的 `UserPromptSubmit`。
3. 分别查询两个 ThreadRef。

预期：

- 两个 ThreadRef 独立存在。
- Codex 状态变化不覆盖 Trae。
- `threadId` 不冲突，`agent` 字段能区分 agent 类型。

失败判断：

- 只用 `terminalSessionId` 作为主键，导致不同 agent/thread 互相覆盖。

## ASTS-008 同一 terminal 多 panel 隔离

步骤：

1. 写入同一 `terminalSessionId`、不同 `terminalPanelId` 的两个 Codex thread。
2. 分别发送 `UserPromptSubmit`。
3. 只对第一个 panel 的 thread 发送 `Stop`。
4. 查询两个 ThreadRef。

预期：

- 第一个 thread `status=idle`。
- 第二个 thread 仍 `status=running`。
- projection key 至少能区分 `threadId`；当 threadId 缺失时，必须能用 agent + terminalSessionId + terminalPanelId + sourceInstanceId 避免覆盖。

失败判断：

- 一个 panel 停止导致整个 terminal session 的所有 panel 状态变 idle。

## ASTS-009 缺失 threadId 的降级键

步骤：

1. 写入没有 `correlationId/threadId` 的 `agent.hook SessionStart`。
2. scope 包含 `terminalSessionId` 和 `terminalPanelId`。
3. 查询 ThreadRef。

预期：

- 系统创建可追踪的降级 ThreadRef。
- 状态为 `starting`。
- 后续同一 agent + terminalSessionId + terminalPanelId + sourceInstanceId 的事件能更新同一记录。
- 一旦后续事件带来真实 `threadId`，实现必须按约定迁移或关联，不得留下两个 active running 记录。

失败判断：

- 直接丢弃事件。
- 创建不可查询、不可同步的匿名状态。

## ASTS-010 幂等 dedupe 不重复投影

步骤：

1. 使用相同 `dedupeKey` 写入同一 `agent.hook UserPromptSubmit` 两次。
2. 查询 `/events`、ThreadRef、本地同步文件。

预期：

- 第二次 `/events` 返回已有事件。
- ThreadRef 只应用一次状态变化。
- 本地同步目录不产生重复 projection 增量。

失败判断：

- 同一个 dedupe event 导致 `lastActivityAt` 或 projection history 被重复推进。

## ASTS-011 重启恢复 projection

步骤：

1. 写入 `SessionStart`、`UserPromptSubmit`、`Stop`。
2. 停止 App Server。
3. 用同一个 state dir 和 cloud sync dir 重启。
4. 查询 ThreadRef、`/events`。

预期：

- event log 保留。
- projection 在启动后可恢复。
- latest 状态仍为 `idle`。
- 新事件 id 从历史最大值继续递增。
- 同步目录 manifest 不回退 cursor。

失败判断：

- 重启后状态丢失，只剩 event log。
- 重启后重复写入所有历史 projection，导致同步目录膨胀且无法去重。

## ASTS-012 projection 重建

步骤：

1. 保留 `app-server-events.jsonl`。
2. 删除本地 projection 文件，但不删除 event log。
3. 重启 App Server。
4. 查询状态。

预期：

- App Server 能从 event log 重建 projection。
- 重建结果与删除前一致。
- 本地同步目录中的 latest 文件被重新生成。

失败判断：

- projection 文件丢失后 App Server 无法启动。
- 重建后状态与事件顺序不一致。

## ASTS-013 本地同步目录写入事件镜像

步骤：

1. 使用临时 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR` 启动 App Server。
2. 写入 3 条不同 kind 的事件。
3. 检查同步目录 `events/app-server-events.jsonl`。

预期：

- 同步目录存在。
- 每条 event 以 JSONL 形式追加。
- event id、kind、source、scope、correlationId、createdAt 与 App Server event log 一致。
- 不泄露 app-server token、Authorization header 或本机敏感环境变量。

失败判断：

- 同步目录只写 projection，不写原始事件镜像。
- JSONL 格式不可逐行解析。

## ASTS-014 本地同步目录写入 latest projection

步骤：

1. 写入一个 thread 的 `SessionStart`、`UserPromptSubmit`、`Stop`。
2. 检查 `projections/latest-threads.json`。

预期：

- latest 文件是完整 JSON，可被人工直接查看。
- 同一 thread 只保留最终状态。
- 文件内容不包含完整 thread 对话详情。
- `updatedAt` 与最后一次状态变化一致。

失败判断：

- latest 文件缺失或只能从增量日志推断。
- 人工无法确认当前状态。

## ASTS-015 同步 cursor 与 manifest

步骤：

1. 写入多条事件。
2. 检查 `cursors/upload-cursor.json` 和 `manifests/sync-manifest.json`。
3. 重启 App Server。
4. 再写入一条事件。

预期：

- cursor 记录最后已同步 event id。
- manifest 记录 schema/version、生成时间、源 app-server instance 信息和同步目录路径。
- 重启后 cursor 不回退。
- 新事件只追加一次。

失败判断：

- 每次重启都从 event id 0 重新同步。

## ASTS-016 同步目录不可写时降级

步骤：

1. 将 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR` 指向不可写目录。
2. 启动 App Server。
3. 写入 `agent.hook` 事件。
4. 查询 `/events` 和 ThreadRef。

预期：

- `/events` 写入仍成功，App Server 主流程不被本地同步失败阻断。
- ThreadRef projection 仍在 App Server 主状态中更新。
- 日志记录同步失败。
- 健康检查可暴露 sync degraded 状态，或至少不报告同步成功。

失败判断：

- 同步目录失败导致 `/events` 返回 500。
- event log 写入成功但 projection 被跳过。

## ASTS-017 状态查询 API 鉴权

步骤：

1. 不带 token 查询 thread 状态接口。
2. 使用错误 token 查询。
3. 使用正确 token 查询。

预期：

- 受保护状态接口与 `/events` 一致，缺失或错误 token 返回 `401`。
- 正确 token 返回状态。
- `/healthz` / `/readyz` 仍保持现有无需 token 语义。

失败判断：

- 状态接口绕过鉴权。
- 状态接口要求 token 但 `/events` 不一致。

## ASTS-018 状态查询过滤

步骤：

1. 写入多个 project、agent、terminalSession、terminalPanel 的状态。
2. 分别按 project、agent、terminalSession、terminalPanel 查询。

预期：

- 每种过滤条件只返回匹配记录。
- 多条件查询取交集。
- limit / after 或 cursor 行为明确且稳定。

失败判断：

- 过滤只在前端做，后端返回全部状态。
- 多条件查询语义不稳定。

## ASTS-019 WebSocket 状态变化推送

步骤：

1. 连接 App Server `/events/stream`，订阅状态相关事件。
2. 写入 `SessionStart`、`UserPromptSubmit`、`Stop`。
3. 记录 WebSocket 消息。

预期：

- 连接先收到 catchup。
- 后续每次状态变化收到 live event。
- live event 中包含可定位的 `threadId`、`agent`、`status`、`lastEventId`。
- 如果重复事件没有造成状态变化，不应重复推送状态变化事件。

失败判断：

- 只能通过轮询状态接口观察变化。
- WebSocket 推送缺少 thread 归属字段。

## ASTS-020 Backend 消费 App Server 状态补齐终端状态

步骤：

1. 启动 App Server 和 backend，使用隔离 state dir。
2. 创建一个 backend terminal session，并使本地 `TerminalState` 处于 `agent_running/codex`。
3. 向 App Server 写入同一 `terminalSessionId` 的 `agent.completion hook_stop Stop`。
4. 等待 backend 消费或补偿任务执行。
5. 查询 backend `/api/terminal/session/:id/state`。
6. 监听 backend `/ws/terminal-events`。

预期：

- backend 状态更新为 `agent_idle/codex`。
- backend 通过 `TerminalStateService` 写 DB。
- backend `/ws/terminal-events` 发出 `terminal_state_changed`。
- Web/App 无需刷新即可看到 running/Stop 消失。

失败判断：

- backend 直接改 DB 但不发 `terminal_state_changed`。
- backend 与 App Server 状态长期不一致。

## ASTS-021 Backend ownership 过滤

步骤：

1. 启动一个 backend。
2. 向 App Server 写入属于当前 backend project/session 的事件。
3. 写入另一个未知 project/session 的事件。
4. 观察 backend 状态变更。

预期：

- backend 只消费属于自己的 project/session。
- 未知 session 事件留在 App Server，但不污染当前 backend DB。
- cursor 推进规则不导致相关事件被跳过。

失败判断：

- 任意 App Server 事件都能改当前 backend 的 terminal state。

## ASTS-022 Hook double-write 兼容

步骤：

1. 使用 hook 验证脚本模拟 Codex `UserPromptSubmit` 和 `Stop`。
2. 同时提供 backend fallback 和 App Server。
3. 查询 backend terminal state。
4. 查询 App Server ThreadRef。

预期：

- backend fallback 仍可工作。
- App Server 事件写入成功。
- App Server ThreadRef 与 backend terminal state 最终一致。
- App Server 写失败时 hook 仍不阻断 backend fallback。

失败判断：

- 为了新状态中心破坏旧 fallback。

## ASTS-023 真实场景：Codex 终端完整运行

步骤：

1. 使用隔离 `RUNWEAVE_APP_SERVER_STATE_DIR` 和 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR` 启动 App Server。
2. 启动 backend 和 Web。
3. 通过 UI 或 CLI 创建一个 terminal。
4. 在 terminal 内启动 Codex。
5. 发送一条真实 prompt。
6. 等待 hook 写入 App Server。
7. 打开 Web terminal 页面，确认 running 状态。
8. 停止或等待 Codex 完成。
9. 检查 App Server 状态接口、本地同步目录、backend terminal state、Web UI。

预期：

- App Server 能看到该 thread 的状态变化序列。
- 本地同步目录包含原始事件和 latest projection。
- backend terminal state 与 App Server projected status 不冲突。
- Web UI 的 running/Stop 与最终状态一致。

必须记录的证据：

- App Server `/events` 响应片段。
- ThreadRef 状态响应。
- 同步目录文件路径和关键 JSON 行。
- backend `/api/terminal/session/:id/state` 响应。
- Web 页面截图或 Playwright DOM 断言。

失败判断：

- 只用手工观察 terminal 输出，没有检查 App Server 状态和同步目录。

## ASTS-024 真实场景：多 panel 并发 agent

步骤：

1. 创建 tmux-backed terminal。
2. 开启 panel split。
3. 在两个 panel 分别触发 Codex 或兼容 agent 事件。
4. 让 panel A 停止，panel B 保持 running。
5. 查询 App Server ThreadRef。
6. 检查 Web active target 和 backend terminal state。

预期：

- App Server 能区分两个 panel 的状态。
- panel A `idle` 不覆盖 panel B `running`。
- 本地同步目录保留两个 thread 的 latest 状态。
- 如果 backend 仍只有 session-level terminal state，测试报告必须明确记录该限制，不能把它伪装成 panel-level 成功。

失败判断：

- 同一 terminalSessionId 下只保留一个 agent 状态。

## ASTS-025 真实场景：App Server 重启期间事件恢复

步骤：

1. 启动 App Server、backend、Web。
2. 写入 `SessionStart` 和 `UserPromptSubmit`。
3. 停止 App Server。
4. 重启 App Server。
5. 写入 `Stop`。
6. 检查 App Server projection、backend 状态、本地同步目录。

预期：

- 重启前事件仍在。
- 重启后 Stop 正常投影。
- 本地同步 cursor 不回退。
- backend 可通过 catchup 或下一轮补偿达到一致状态。

失败判断：

- 重启导致 thread 状态回到 unknown。

## ASTS-026 真实场景：离线本地同步补偿

步骤：

1. 使用可写同步目录运行并写入若干事件。
2. 临时将同步目录改为不可写，继续写入事件。
3. 恢复目录可写。
4. 触发下一次同步。

预期：

- App Server 主事件日志完整。
- 不可写期间状态 projection 仍更新。
- 恢复后同步目录补齐缺失事件和 latest projection。
- manifest 记录最近一次同步错误和恢复时间。

失败判断：

- 不可写期间的数据永久丢失。

## ASTS-027 安全与脱敏

步骤：

1. 写入 payload 中包含疑似 token、Authorization、cookie、secret 字段的诊断事件。
2. 检查 event log、projection、本地同步目录。

预期：

- 如果事件协议允许原样保存 payload，测试报告必须明确风险。
- projection 和 latest 文件不得复制敏感 header 到状态字段。
- sync manifest 不包含 bearer token 或 app-server token。

失败判断：

- token 出现在 `latest-threads.json`、`sync-manifest.json` 或日志输出中。

## ASTS-028 大量事件与分页

步骤：

1. 写入超过单页限制的事件，例如 1200 条。
2. 查询 `/events` 分页。
3. 查询 ThreadRef latest。
4. 检查同步目录完整性。

预期：

- event id 单调递增。
- 状态 projection 以最新可解释事件为准。
- 同步目录没有漏 event。
- 查询接口不会一次返回无限数据。

失败判断：

- 只处理第一页事件，latest 状态落后。

## ASTS-029 保留窗口与同步目录

步骤：

1. 构造过期事件和新事件。
2. 启动 App Server，让 retention prune 生效。
3. 查询 `/events` 和 projection。
4. 检查本地同步目录。

预期：

- App Server event store 按既有保留窗口清理过期事件。
- projection 对 latest 状态的处理规则明确：要么保留 latest 状态，要么根据剩余事件重建。
- 本地同步目录作为云同步模拟，不应因本地 retention 未说明地删除已同步历史；若会删除，必须写入 manifest。

失败判断：

- retention 清理导致 latest 状态无解释地消失。

## ASTS-030 回滚兼容

步骤：

1. 使用旧格式事件启动新 App Server。
2. 写入新格式状态事件。
3. 使用没有状态中心能力的旧 backend 只消费 `/events`。

预期：

- 旧事件仍可读取。
- 新状态能力不破坏旧 `/events` API。
- 旧 backend 不识别状态事件时应忽略，不应崩溃。

失败判断：

- 为状态中心修改事件 envelope，导致旧事件无法解析。

## 真实场景测试执行顺序

真实场景测试前必须按顺序完成：

1. 运行静态检查。
2. 运行 app-server 原有 event center 验证。
3. 运行新增 state sync 验证脚本。
4. 用临时 state dir 和 cloud sync dir 执行 ASTS-001 到 ASTS-022。
5. 确认没有污染默认 `~/.runweave/app-server-cloud-sync-sim/`。
6. 人工确认可以使用固定默认同步目录。
7. 执行 ASTS-023 到 ASTS-026。
8. 汇总证据路径、命令输出、截图和关键 JSON。

## 验收通过标准

必须同时满足：

- 所有静态检查通过。
- 原有 app-server event center 验证不回退。
- 状态 projection 能从事件生成、更新、重启恢复。
- 本地同步模拟目录包含事件镜像、projection latest、cursor、manifest。
- 真实 Codex 终端场景中 App Server、backend、Web/App 展示最终一致。
- 多 panel 测试明确证明 panel 状态不会互相覆盖，或明确记录 backend session-level 限制。
- 任一失败用例都有明确阻塞原因和复现证据。

## 实现前必须确认的边界

1. 默认固定同步目录是否最终使用 `~/.runweave/app-server-cloud-sync-sim/`。
2. 状态查询 API 路径命名，例如 `/threads`、`/threads/:threadId`。
3. 无 `threadId` 事件的降级 key 是否接受 `agent + terminalSessionId + terminalPanelId + sourceInstanceId`。
4. `ai_process_exit` 在第一阶段是否确认为 `completed`，还是统一先落为 `idle`。
