# App Server 状态同步测试案

## 范围

本文档只保留基于当前代码可执行、可取证的测试。测试目标是验证 App Server 作为本机事件中心和轻量 ThreadRef 状态中心时，能够：

1. 独立启动并写入 lock/token。
2. 接收、持久化、查询并推送 `agent.hook` / `agent.completion` / diagnostic 事件。
3. 从事件投影 ThreadRef 状态。
4. 将事件和 latest projection 同步到本地 cloud sync 模拟目录。
5. 重启后从 event log 恢复 projection。
6. 通过 Codex thread 状态轮询生成同协议补偿 `agent.hook` 事件。
7. 保持 hook bridge 双写和 backend fallback 兼容。

不覆盖没有可执行入口的 Web/App UI 场景。需要新增这类 case 时，先补脚本或 Playwright E2E，再把 case 加回本文档。

## 当前代码事实

- App Server 入口：`app-server/src/index.ts`，构建后通过 `node app-server/dist/index.js` 启动。
- 隔离 state dir：`RUNWEAVE_APP_SERVER_STATE_DIR`。
- 隔离 sync dir：`RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR`。
- 随机端口：`RUNWEAVE_APP_SERVER_PORT=0`。
- lock 文件：`$RUNWEAVE_APP_SERVER_STATE_DIR/app-server.lock.json`。
- token 文件：`$RUNWEAVE_APP_SERVER_STATE_DIR/app-server-token`。
- 事件日志：`$RUNWEAVE_APP_SERVER_STATE_DIR/app-server-events.jsonl`。
- ThreadRef 状态：`$RUNWEAVE_APP_SERVER_STATE_DIR/app-server-thread-state.json`。
- sync 目录默认值：`~/.runweave/app-server-cloud-sync-sim/`；测试必须优先使用临时覆盖目录。

## 必跑命令

按顺序执行，任一失败即停止：

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

## 自动化覆盖映射

`pnpm app-server:verify` 覆盖：

- ASTS-001：App Server 隔离目录启动、`/healthz` 可用、lock/token 写入。
- ASTS-002：同一 state dir 下第二个 App Server 不抢占 owner。
- ASTS-003：`POST /events` 写入事件，`GET /events` 查询事件。
- ASTS-004：相同 `dedupeKey` 返回既有事件，不重复追加。
- ASTS-005：`/events/stream` catchup 和 live event 推送。
- ASTS-006：App Server 重启后 event log 保留，事件 id 继续递增。
- ASTS-007：鉴权、Origin、query 参数和 payload 校验。
- ASTS-008：event log retention 清理过期事件，但保留新事件和 id 单调递增。

`pnpm app-server:verify-cli-start` 覆盖：

- ASTS-009：CLI 安装 runtime 后可启动 App Server。
- ASTS-010：CLI start/status/stop/restart 生命周期。
- ASTS-011：stale lock、legacy lock 和并发 start 兼容。

`pnpm app-server:verify-state-sync` 覆盖：

- ASTS-012：`SessionStart` 创建 ThreadRef，并写入 projection JSONL。
- ASTS-013：`UserPromptSubmit` 更新 ThreadRef 为 `running`。
- ASTS-014：`Stop` 更新 ThreadRef 为 `idle`。
- ASTS-015：`agent.completion hook_stop + rawHookEvent=Stop` 兜底更新为 `idle`。
- ASTS-016：`notify` completion 不覆盖 `running`。
- ASTS-017：`ai_process_exit` 更新为 `completed`。
- ASTS-018：不同 agent/thread 隔离。
- ASTS-019：同一 terminal 下不同 panel/thread 隔离。
- ASTS-020：缺失 threadId 时使用 `agent + terminalSessionId + terminalPanelId + sourceInstanceId` 降级 key，并在真实 threadId 到达时迁移。
- ASTS-021：相同 `dedupeKey` 不重复投影。
- ASTS-022：状态查询 API 与 `/events` 一致要求 bearer token。
- ASTS-023：状态查询支持 project、terminalSession、terminalPanel、agent、status、limit/after 过滤。
- ASTS-024：`/events/stream` 推送 `thread.state.changed`。
- ASTS-025：本地同步目录写入事件镜像、latest projection、cursor、manifest。
- ASTS-026：App Server 重启后从 event log 恢复 projection。
- ASTS-027：删除 state JSON 后从 event log 重建 projection。
- ASTS-028：同步目录不可用时 `/events` 和 projection 仍成功，`/sync/status` 暴露 degraded。
- ASTS-029：App Server 轮询最近 3 小时内 `agent=codex` 的 ThreadRef，发现真实状态与 projection 不一致时生成同协议 `agent.hook` 补偿事件。
- ASTS-030：latest projection 和 sync manifest 不复制 token/Authorization 等敏感字段。
- ASTS-031：大量事件分页和 sync mirror 完整性。

`pnpm toolkit:verify-hooks` 覆盖：

- ASTS-032：hook bridge 发现 App Server 时双写 `agent.hook` / `agent.completion`。
- ASTS-033：App Server 不可用或鉴权失败时不阻断 backend fallback。

## Agent 自动化执行规则

执行本文档时，Agent 必须直接运行“必跑命令”，不得把启动 App Server、写事件、读取 lock/token、检查 sync 文件这类步骤转交给用户手动执行。

启动类 case 的自动化证据来自 `pnpm app-server:verify` 和 `pnpm app-server:verify-state-sync`：

- 两个脚本都会先执行 `pnpm --filter @runweave/app-server build`。
- 两个脚本都会创建临时 `RUNWEAVE_APP_SERVER_STATE_DIR`。
- 两个脚本都会创建或指定临时 `RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR`。
- 两个脚本都会用 `RUNWEAVE_APP_SERVER_PORT=0 node app-server/dist/index.js` 启动真实 App Server 进程。
- 两个脚本都会等待 `app-server.lock.json` 写入，并用 lock 中的 host/port 请求 `/healthz`。
- 两个脚本都会读取 `app-server-token`，再用 bearer token 调用受保护接口。
- 两个脚本都会在结束时停止 App Server 并删除临时目录。

如果需要单独复核某一个启动类 case，也应由 Agent 执行对应脚本或临时 Node 验证脚本，并在结果里给出命令和关键输出；不要要求用户复制 shell 片段手动操作。

## ASTS-029 Codex 状态补偿细则

`pnpm app-server:verify-state-sync` 使用 fake `CODEX_BIN`，并通过当前 App Server 真实进程验证补偿逻辑：

1. 写入 Codex `UserPromptSubmit`，本地 ThreadRef 进入 `running`。
2. fake Codex 对同一 `threadId` 返回 `status.type=idle`。
3. App Server 补偿轮询生成 `agent.hook Stop`。
4. 写入另一个 Codex `Stop`，本地 ThreadRef 进入 `idle`。
5. fake Codex 对第二个 `threadId` 返回 `status.type=active`。
6. App Server 补偿轮询生成 `agent.hook UserPromptSubmit`。

预期：

- 候选 ThreadRef 条件是最近 3 小时内 `agent=codex`，不要求本地 `status=running`。
- 只有远端状态和本地 projection 不一致时追加补偿事件。
- 补偿事件 `kind=agent.hook`。
- 补偿事件 `payload.source=codex`。
- 补偿事件 `payload.compensation=true`。
- 补偿事件 `payload.compensationReason=codex_thread_status_mismatch`。
- `idle` 映射为 `stateHookEvent=Stop`。
- `active` 映射为 `stateHookEvent=UserPromptSubmit`。
- 远端状态与本地一致时不追加事件。

失败判断：

- 仍然只扫描本地 `status=running` 的 ThreadRef。
- 只改 ThreadRef projection，但没有追加 `agent.hook` 事件。
- 使用新的私有 event kind，导致 backend 需要第二套消费协议。
- 状态一致时仍重复写补偿事件。

## 验收通过标准

必须同时满足：

- 必跑命令全部通过。
- App Server 可在临时 state/sync dir 启动，且不会污染默认 sync 目录。
- event log、ThreadRef projection、sync mirror、cursor、manifest 都能从真实文件取证。
- 补偿事件与普通 hook 事件同协议。
- hook bridge 双写与 backend fallback 不回退。
- 任一失败用例都有失败命令、关键输出和复现条件。
