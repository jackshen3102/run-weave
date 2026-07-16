# 终端状态与事件流：真实场景复现报告

## 结论

以 `2026-07-16` 当前工作区（HEAD `2d15b8e7` + 未提交终端状态改动）重新建立干净现场后，原问题清单中只剩 `R2` 能持续复现；另外发现一条新的低时长架构问题 `A7`。后续保留现场 `dvs-26f194 / ac7ac256` 又确认了多 Pane 诊断契约问题 `A8`。Hook 接收结果不可观测、测试前置缺失的 `A9` 曾在同一现场复现，已经在本轮修复并完成独立临时 Backend 验证。第一轮基于改动前代码得到的结果全部作废，没有混入本报告。

当前确认问题：

1. `R2`：普通终端输出可以伪造 `activeCommand`，影响高。
2. `A7`：Pane、State API、Session 列表与 Home 不是同一原子快照，prepare/hook 边界会出现约 `128–297ms` 的交叉状态，影响中。
3. `A8`：多 Pane 下 session 级 `activeCommand=null` 是有意的有损摘要，不能单独作为所有 Pane 已退出 Agent 的证据；当前 K1 文案没有限定观测层级，会造成稳定的验收假阳性，影响中。

原先持续数秒到数十秒的 `A1 / A2 / A4 / R4 / N1` 在当前代码下均无法复现；对应改动已经通过真实 Codex、真实 tmux、真实 hook、真实 App Server 和页面刷新验证。

## 现场

- Web：`http://127.0.0.1:5175`
- Backend：`http://127.0.0.1:5005`
- 临时 profile：`/private/tmp/runweave-terminal-risk-latest-20260716/profile`
- 临时 Activity：`/private/tmp/runweave-terminal-risk-latest-20260716/activity`
- 隔离 App Server：`/private/tmp/runweave-terminal-risk-latest-20260716/app-server`
- App Server 实例：`app-server:4b4a0e24-8100-4c70-8d75-e9c5d93c9273`
- 项目：`Terminal Risk Latest` / `62c0a1bb-c9a8-4c16-8589-8def133a4148`
- 主复现 Session：`8dd62a93`
- 单 Pane 对照 Session：`0df2d6a7`
- shell stress Session：`5b8345c2`
- 浏览器工具：`playwright-cli -s=terminal-risk-latest`

所有命令都通过真实 Terminal input、Agent Prepare API 或 xterm 输入进入真实 zsh/tmux；Agent 场景使用真实 Codex TUI 和真实 hook bridge。没有直接构造内部函数输入，没有手改 lowdb、tmux option 或 App Server JSONL。

## 当前可复现问题

### R2 普通命令能让终端短暂冒充“Codex 正在运行”

一句话结论：这是需要修复的代码 Bug；普通程序能够伪造 Agent 身份，后续自动纠正也不能消除已经出现的错误窗口。

真实命令：

```zsh
printf '\033]633;RunweaveCommand=codex\a'; sleep 2
```

观察：

- 约 `300ms` 时 Session API 返回 `activeCommand="codex"`。
- 同一时刻页面 terminal tab 的按钮文本为 `feature(codex)`。
- 真实执行内容只是 `printf + sleep`，没有启动 Codex。
- 命令结束后 metadata 会回到 `null`，但错误身份窗口已经真实存在。

原因是 `RunweaveCommand` OSC 只有内容解析，没有验证该 marker 是否来自 Runweave 注入的 shell hook。当前 tmux fallback 能最终纠正命令，不能阻止伪造窗口。

证据：[repro-latest-r2-osc-spoof-stable.png](./repro-latest-r2-osc-spoof-stable.png)

### A7 启动 Codex 时，几个页面的状态可能短暂对不上

一句话结论：这是转换边界内不到 `300ms` 的显示不一致，不是状态永久错乱。

真实 `POST /api/terminal/session/8dd62a93/agent/prepare` 返回 `command_submitted` 后，同时读取 Pane workspace、`/state`、Session 列表和 Home：

| 相对时间 | Pane             | `/state` / Session / Home |
| -------- | ---------------- | ------------------------- |
| `39ms`   | `shell_idle`     | `agent_starting`          |
| `169ms`  | `agent_starting` | `shell_idle`              |
| `297ms`  | `agent_starting` | `agent_starting`          |

真实 hook 转换边界还出现过约 `130ms` 的 `Pane=agent_idle`、`Home=running`。这些状态都在 `300ms` 内收敛，因此它不是旧版持续 5–7 秒的状态分裂，但说明多个用户可见读取面没有共享状态 revision 或原子快照。

触发机制：

- `GET panels` 会刷新 tmux metadata，并写 Pane / Session。
- `/state` 再聚合当前 Pane。
- Session 列表读取 manager snapshot。
- Home 同时叠加 Pane 聚合和 provider thread snapshot。

### A8 验收看错了对象：Codex 其实还没退出

一句话结论：这不是终端状态残留，而是旧验收条件把 session 汇总字段误当成了目标 Pane 的真实状态。

保留现场：

- Dev Session：`dvs-26f194`，Beta `pool-01`。
- Terminal Session：`ac7ac256`。
- `GET /api/terminal/session/ac7ac256`：`activeCommand=null`、session `terminalState=shell_idle/null`。
- `GET /api/terminal/session/ac7ac256/state`：`agent_idle/codex`。

这组返回值看起来违反 K1，但进一步读取真实 tmux 和持久化 panel 后，K1 的退出前置条件并未成立：

| 观测对象            | 真实状态                                                                             |
| ------------------- | ------------------------------------------------------------------------------------ |
| `%0` / main panel   | `pane_current_command=zsh`，`activeCommand=null`，`shell_idle/null`                  |
| `%1` / active panel | `pane_current_command=node`，`@runweave_command=.../codex`，Codex PID `21440` 仍存活 |
| `%1` 持久化 panel   | `activeCommand=null`，但 `terminalState=agent_idle/codex`                            |
| session 摘要        | 因存在两个 running panel，`activeCommand` 被压成 `null`                              |
| `/state`            | 聚合 running panels，返回 `agent_idle/codex`                                         |

因此这次 `TS-API-007` 应判为“未形成退出到 shell 的前置条件”，不能证明 TerminalState 清理失败。真正可复现的问题是观测契约有歧义：

- `TerminalManagerSessionRuntime.updateSessionMetadata()` 在多 running panel 时把 session 级 `activeCommand` 固定压成 `null`。
- `clearMultiPanelMetadataFromSession()` 同样清空 session 级 `activeCommand`。
- `/state` 不使用这个有损 session 字段，而是聚合每个 running panel 的 `terminalState`。
- K1 当前写成“`activeCommand=null` 时 `/state` 必须 shell idle”，没有说明这里必须是目标 panel 的 activeCommand，且所有 running panel 均已离开 Agent。

这不会直接证明产品状态错误，但会让测试、诊断脚本和人工排障把合法的多 Pane 聚合误报成状态残留。长期契约应把退出判据改成 panel 级：目标 Agent panel 的真实进程已退出，且该 panel 的当前 command/metadata 已回到 shell；session 级 `activeCommand=null` 只能表示“session 无单一 command”。

本次只读核查没有继续执行 `TS-API-008`、`TS-HOME-*` 或 `TS-UI-*`，也没有停止或清理用户保留的 Dev Session。

### A9 Hook 202 响应无法区分 recorded 与 ignored

同一保留现场对 `%1` 依次手工提交 `SessionStart`、`UserPromptSubmit` 和 `Stop`，HTTP 均返回 `202` 与当前 `agent_idle/codex`。仅看响应会得到三个互相矛盾的判断：SessionStart 似乎通过、UserPromptSubmit 似乎失败、Stop 又似乎通过。

Backend 结构化日志给出了真实结果：

| hook                    | requestId                              | Backend disposition           | 状态含义                                                              |
| ----------------------- | -------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `SessionStart`          | `76b33186-d715-473e-9fb6-1b8e6b60d2b9` | `terminal-state.hook.ignored` | 没有执行 idle 写入；只是返回原状态                                    |
| `UserPromptSubmit`      | `b5fcc2d8-0dc6-4f0d-99e9-69efe7d593f0` | `terminal-state.hook.ignored` | 没有进入 `resolveAgentHookTerminalState()`，不能证明 running 映射失效 |
| `Stop`                  | `3bf0b29e-6f3a-4c97-a37b-519f35f7a7b0` | `terminal-state.hook.ignored` | 没有执行 idle 写入；只是返回原状态                                    |
| `%0` `UserPromptSubmit` | `1f1189d6-e7b9-4f02-862d-8986729a218b` | `terminal-state.hook.ignored` | 普通 shell panel 拒绝符合预期                                         |

`%1` 仍有活跃的 operation generation：tmux `@runweave_agent_prepare_exit=pending:terminal_agent_prepare_954328c2-c73f-433b-af5a-89418d6fd68a`。`processTerminalAgentHook()` 在存在 generation 时要求 hook 携带 matching `operationId + agent`，否则会在状态映射之前返回 ignored。这组手工请求只绑定了 panelId，没有证明 operation identity 匹配，所以不满足真实 hook 接收前置。

这里有两条独立结论：

- `TS-HOOK-009` 没有复现 `UserPromptSubmit -> agent_running` 的产品缺陷；请求没有进入状态映射。
- API/测试契约确有可复现的诊断缺陷：`ignored` 和 `recorded` 使用相同 HTTP status/body，TS-HOOK-008/009/010 又没有声明 matching operationId 或“必须从日志证明 recorded”，导致响应值无法作为验收结论。

修复结果：

- Shared hook response 新增 `disposition: recorded | ignored | exited`；ignored 必须携带 `ignoreReason`。
- 四个门禁拒绝点分别返回 `panel_identity_mismatch`、`operation_identity_mismatch`、`agent_identity_mismatch` 或 `inactive_agent`。
- TS-HOOK case 明确 matching operationId 前置，并把 disposition 设为 202 响应的必断言字段。
- 独立临时 Backend `127.0.0.1:5011` 真实验证：无当前 Agent 的 UPS 返回 `ignored/inactive_agent`；携带可信 `commandName=codex` 的 UPS 返回 `recorded + agent_running/codex`；结构化日志同时记录 ignoreReason。临时 session、Backend、端口和 profile 已清理。

因此 A9 不再列入当前问题地图；保留本节作为“真实复现 → 修复 → 运行验证”的闭环证据。

## 原问题逐项复现结果

| 编号 | 真实场景                                                                        | 当前结果                                                                                                     | 判断                                          |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| A1   | 两 Pane；一个 Codex Idle，一个 Codex 执行 `sleep 10`                            | 连续 `13.2s`：Pane running、`/state` running、Session running、Home running；另一 Pane 保持 idle             | 无法复现，旧问题已修复                        |
| A2   | 现有 Pane 调用 Agent Prepare，真实 Codex 回答                                   | 稳定 `activeCommand=codex`；未出现 `export` 或环境变量 token；hook 带 matching operationId                   | 无法复现，旧问题已修复                        |
| A3   | 真实 hook、completion、live event、Activity 链路                                | 没有得到独立于 A7/R2 的用户故障                                                                              | 不记录为问题                                  |
| A4   | 单 Pane真实 Codex prepare                                                       | Session 保留 `agent_starting`；旧版持续 `6.85s` 的 starting→idle 聚合损失未出现                              | 无法复现，旧问题已修复                        |
| A5   | 多次真实 Agent 生命周期与补偿                                                   | 未观察到旧事件覆盖新状态                                                                                     | 无法复现                                      |
| A6   | 真实 completion 后刷新、选择 tab、再次刷新                                      | revision 持久化；刷新后绿点仍为 `bg-emerald-400`；选择后服务端 ack=`1` 且绿点清除                            | 已并入 R4 验证，无法复现                      |
| R1   | 真实 zsh/tmux 连续执行短命令；检查 scrollback 与最终 metadata                   | 实际执行至少 `31` 次 `sleep 0.12`，没有控制序列泄漏，最终 `activeCommand=null`                               | 真实现场无法复现；函数级手工拆 chunk 不算问题 |
| R2   | `printf` 输出伪造 OSC 后执行 `sleep 2`                                          | API 与页面均显示 Codex                                                                                       | **可复现**                                    |
| R3   | `FOO=bar sleep 1`；`pnpm exec node -e ...`                                      | 前者识别为 `sleep`；后者只出现 `pnpm → null`，没有 `node` 回摆                                               | 无法复现                                      |
| R4   | 真实 Codex Stop 产生 completion；刷新页面                                       | 刷新前后均为绿色；选择 tab 后 `completionRevision=1`、`acknowledgedCompletionRevision=1`                     | 无法复现，旧问题已修复                        |
| R5   | Agent running 时停止 Backend；Agent 在离线期间 Stop/completion；同 profile 重启 | App Server 离线记录 `Stop` id `54`、completion id `56`；Backend 从 cursor `52` 恢复，首次状态即 `agent_idle` | 无法复现                                      |
| R6   | 页面保持打开，Backend/Frontend 重启后通过真实 xterm 输入 `sleep 2`              | `null → sleep(237ms) → null(2300ms)`                                                                         | 无法复现                                      |
| R7   | `pnpm exec node -e "setTimeout(()=>{},1500)"`，20ms 采样                        | `pnpm(4ms) → null(1923ms)`，没有 wrapper 回摆                                                                | 无法复现                                      |
| R8   | 隔离 App Server 连续接收真实 hook/completion，Backend 多次重启                  | consumer 从 `after=45`、`after=52`、`after=56` 继续；没有 `app-server.consumer.message.failed`               | 无法复现                                      |
| N1   | Backend 与 tmux 指向隔离 App Server，真实 Codex 上报 hook                       | tmux session env 包含隔离 `RUNWEAVE_APP_SERVER_HOME`；事件 `3–57` 全部写入隔离 JSONL                         | 无法复现，旧问题已修复                        |

## 补充验收结果

| 用例        | 现场                                                                                                                        | 结果                                                                                                                                                                                            | 判断                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| TS-API-001  | `dvs-26f194 / backend http://127.0.0.1:5006`；在已认证 Runweave 页面中使用当前 connection access token 请求绝对 Backend URL | 精确路径 `/api/terminal/session/not-found/state` 连续 `10/10` 次返回 `404 Not Found`，body 均为 `{"message":"Terminal session not found"}`；`does-not-exist` 与 `00000000` 对照组也返回相同 404 | **无法复现产品 400 缺陷**；当前 route 无 ID 格式校验，auth 失败只会返回 401。无 header/body 的 400 需要先证明最终绝对 URL 确实到达 Backend |
| TS-API-007  | `dvs-26f194 / ac7ac256`，两个 running panel；session `activeCommand=null`，`/state=agent_idle/codex`                        | 活动 `%1` 中 Codex PID `21440` 仍存活，tmux `@runweave_command` 仍为 Codex                                                                                                                      | **未复现 K1 状态清理缺陷**；复现了 A8 观测契约歧义                                                                                         |
| TS-HOOK-008 | `%1` Codex panel，手工 `SessionStart`                                                                                       | HTTP 202 返回 idle，但 backend disposition 为 `ignored`                                                                                                                                         | **不能判通过**；返回状态只是既有 idle                                                                                                      |
| TS-HOOK-009 | `%1` Codex panel，手工 `UserPromptSubmit`                                                                                   | HTTP 202 返回 idle，backend disposition 为 `ignored`；未执行 panel state 写入                                                                                                                   | **未复现 running 映射缺陷**；复现 A9 响应/测试契约歧义                                                                                     |
| TS-HOOK-010 | `%1` Codex panel，手工 `Stop`                                                                                               | HTTP 202 返回 idle，但 backend disposition 为 `ignored`                                                                                                                                         | **不能判通过**；与 TS-HOOK-009 同一无效前置                                                                                                |
| TS-HOOK-011 | `%0` shell panel，手工 `UserPromptSubmit`                                                                                   | backend disposition 为 `ignored`，panel 保持 shell idle                                                                                                                                         | 符合拒绝契约                                                                                                                               |

TS-API-001 的执行面还做了两组负对照：

- 在 `runweave://app` 页面直接 `fetch("/api/terminal/session/not-found/state")`，最终 URL 是 `runweave://app/api/...`，命中 Electron 静态资源协议并返回 HTML 200，不是 Backend API。
- 使用 Playwright `page.request.get("/api/terminal/session/not-found/state")` 且没有配置 HTTP `baseURL`，工具直接抛出 `Invalid URL`，不会产生 Backend HTTP 响应。

因此后续若再次观察到“400、无 body、无 header”，证据必须同时记录请求工具、最终绝对 URL、是否携带当前 connection 的 access token，以及原始 status/header/body。缺少这些字段时不能把 400 归因到 terminal state route。

## 关键修复的真实证据

### completion 跨刷新恢复

- 刷新前：[repro-latest-r4-before-reload.png](./repro-latest-r4-before-reload.png)
- 刷新后：[repro-latest-r4-after-reload.png](./repro-latest-r4-after-reload.png)
- 刷新后 DOM 仍为 `bg-emerald-400`。
- 选择 session tab 后 DOM 变为 `bg-transparent`，API 中 `completionRevision=1`、`acknowledgedCompletionRevision=1`。

### App Server 环境与离线恢复

tmux session environment 实际包含：

```text
RUNWEAVE_APP_SERVER_HOME=/private/tmp/runweave-terminal-risk-latest-20260716/app-server
RUNWEAVE_HOOK_ENDPOINT=http://127.0.0.1:5005/internal/terminal/agent-hook
RUNWEAVE_PROJECT_ID=62c0a1bb-c9a8-4c16-8589-8def133a4148
RUNWEAVE_TERMINAL_SESSION_ID=8dd62a93
```

Backend 离线时 App Server 仍记录 `UserPromptSubmit → PreToolUse → PostToolUse → Stop → agent.completion`；重启后 consumer 从最后 cursor 后继续处理，首次可见 Session 状态为 `agent_idle`。

## 最终判断

当前实现已经消除了上一版最严重的持续性状态分裂：prepare 命令身份、starting 聚合、Home 多 Pane读模型、completion 已读语义和隔离 App Server 路由均在真实现场通过。

剩下三个问题的优先级不同：

1. 先修 `R2`。它不是视觉瑕疵，而是身份信号可被普通进程伪造，会污染 tab 命名和依赖 `activeCommand` 的门禁。
2. 再决定是否修 `A7`。如果产品允许 `300ms` 内最终一致，可把它明确写成 SLA；如果启动状态不得回退，就需要为 Pane/Session/Home 引入单调 revision 或统一 snapshot，而不是继续增加局部 if 分支。
3. 修订 `A8` 的测试与诊断契约。多 Pane 下不得用 session 级 `activeCommand=null` 断言所有 Pane 都是 shell idle；验收必须绑定目标 panel，并同时检查 panel metadata 与真实进程退出。
