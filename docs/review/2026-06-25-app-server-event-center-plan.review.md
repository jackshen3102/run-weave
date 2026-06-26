# app-server Event Center 计划评审

评审对象：`docs/plans/2026-06-25-app-server-event-center.md`

评审结论：暂不建议直接进入实现。方向本身符合“全局单例 Event Center / 多 backend 共享事件源”的目标，但当前计划有一个环境阻塞假设失败，以及两个会让执行范围和验收不稳定的计划缺口。

## Findings

- **P1 严重：当前 Node runtime 不支持计划首选的 `node:sqlite`，第一阶段持久化路径无法按计划落地。** 计划把 `node:sqlite` 作为第一选择，并写明实施前必须验证、不支持则停止；当前仓库实际 Node 为 `v22.12.0`，执行 `node -e "import('node:sqlite')..."` 返回 `ERR_UNKNOWN_BUILTIN_MODULE`。这意味着 `SQLite event log`、`dedupeKey` 唯一索引、重启恢复验收都不能按现计划实现。定位：`docs/plans/2026-06-25-app-server-event-center.md:115`、`docs/plans/2026-06-25-app-server-event-center.md:121`、`docs/plans/2026-06-25-app-server-event-center.md:127`。修复方向：先把第一阶段持久化选型改为明确可执行方案，例如升级并固定 app-server Node runtime 到支持 `node:sqlite` 的版本，或改用 append-only JSONL/SQLite npm 依赖，并同步更新 schema、验证命令和回滚策略。

- **P1 严重：阶段边界自相矛盾，hook bridge 到 app-server 到底是一阶段还是三阶段不清楚。** 目标章节写第一阶段要让 hook bridge 成为 app-server 事件生产者，后文也详细规划了第一阶段双写和 hook 验收；但“后续阶段预留”又把“hook bridge 接入 app-server”列为第三阶段。执行者可能按第一阶段改 hook，也可能按后续阶段跳过 hook，导致验收闭环互相冲突。定位：`docs/plans/2026-06-25-app-server-event-center.md:33`、`docs/plans/2026-06-25-app-server-event-center.md:454`、`docs/plans/2026-06-25-app-server-event-center.md:488`、`docs/plans/2026-06-25-app-server-event-center.md:1298`。修复方向：二选一明确阶段：如果一阶段包含 hook 双写，删除或改写第三阶段为“由 app-server 广播替代 backend 直写”；如果 hook 接入真在三阶段，则从一阶段目标、文件范围、验收命令里移除 hook bridge 修改。

- **P2 一般：单例发现只要求 `/healthz` 200，但 API 没有定义可校验的 app-server 标识。** 启动流程说 lock pid 存活且 `GET /healthz` 返回 200 就复用 owner；风险章节又说必须返回 app-server 标识才复用。但 `GET /healthz` 响应只定义了 `ok/pid/version`，没有 `service`、协议版本、lock nonce 或 pid 校验字段。这样 stale lock 指向的其它本地服务只要返回 200，就可能被误判为 app-server owner。定位：`docs/plans/2026-06-25-app-server-event-center.md:170`、`docs/plans/2026-06-25-app-server-event-center.md:305`、`docs/plans/2026-06-25-app-server-event-center.md:311`、`docs/plans/2026-06-25-app-server-event-center.md:1260`。修复方向：在 health 协议里增加稳定标识，例如 `service: "runweave-app-server"`、`protocolVersion`、`pid`，并要求 singleton 校验响应 pid 与 lock pid 一致。

- **P2 一般：Trae 来源验收要求区分 `trae/traecli/traex`，但现有 hook 源识别链路只会产出 `trae`。** 计划要求 `agent.completion.payload.source` 允许 `traecli`、`traex`，且验收要求不把 `trae`、`traecli`、`traex` 混成同一个值；当前 `runweave-hook-dispatch.cjs` 的 `SOURCES` 只有 `codex/trae/claude`，`runweave-hook-bridge.cjs` 的 `normalizeSource()` 也只保留 `claude/codex/trae`，其它都会变成 `unknown`。定位：`docs/plans/2026-06-25-app-server-event-center.md:690`、`docs/plans/2026-06-25-app-server-event-center.md:767`、`plugins/toolkit/hooks/runweave-hook-dispatch.cjs:8`、`plugins/toolkit/hooks/runweave-hook-bridge.cjs:282`。修复方向：计划里明确是否本阶段真的要区分 Trae family；如果要，就把 dispatch、bridge、Electron launcher script、验证脚本一起纳入文件范围。

- **P2 一般：新增 hook helper 的同步/验证范围需要从“检查”改成明确修改项，否则 `app-server-client.cjs` 容易漏进 Electron resource。** 计划要求新增 `plugins/toolkit/hooks/app-server-client.cjs` 和 `electron/resources/hooks/app-server-client.cjs`，并“检查”同步脚本；但当前 `scripts/sync-toolkit-plugin.mjs` 的 `toolkitHookAssets` 是硬编码三项，`scripts/verify-toolkit-hooks.mjs` 的 `hookAssets` 也是硬编码三项。只新增 helper 不改这两个数组，`pnpm toolkit:sync` 不会同步它，verify 也不会检查一致性。定位：`docs/plans/2026-06-25-app-server-event-center.md:702`、`docs/plans/2026-06-25-app-server-event-center.md:851`、`scripts/sync-toolkit-plugin.mjs:30`、`scripts/verify-toolkit-hooks.mjs:23`。修复方向：把两个资产列表新增 `app-server-client.cjs` 写成硬性任务，并在验收里断言插件源、Electron resource、安装到 `~/.runweave/bin` 的运行路径都能 resolve 到 helper。

## 更简单的替代方向

建议先做一个更小的 Phase 0：只落地 `app-server` 单例、token、append-only JSONL 事件日志、`POST /events`、`GET /events`、`WS /events/stream` 和一个 repo-local client；暂不碰 hook bridge 和 backend consumer。这样可以先验证“全局唯一事件源 + 多 producer/subscriber + 重启恢复”这个核心假设，同时避开当前 `node:sqlite` 不可用、hook 资产同步、Trae source 细分这些耦合风险。代价是第一阶段不会马上收集真实 AI hook 事件，但会让控制平面边界先稳定下来。

## 检查范围与证据

- 已完整阅读计划文档。
- 对照读取了 `plugins/toolkit/hooks/runweave-hook-bridge.cjs`、`plugins/toolkit/hooks/runweave-hook-dispatch.cjs`、`scripts/sync-toolkit-plugin.mjs`、`scripts/verify-toolkit-hooks.mjs`。
- 验证命令：`node -v` 返回 `v22.12.0`；`node -e "import('node:sqlite').then(() => console.log('ok'))"` 返回 `ERR_UNKNOWN_BUILTIN_MODULE`。
- 未修改被评审计划和源码。
