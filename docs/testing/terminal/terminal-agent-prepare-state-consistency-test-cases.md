# Terminal Agent Prepare 状态一致性测试用例

## 范围

本文档验证 `POST /api/terminal/session/:id/agent/prepare` 启动 Agent 后，Pane、Session、Terminal state 与 App Home 在 shell metadata、Agent hook 和多 Pane 聚合下保持一致。

本次必须覆盖：

1. prepare 命令已提交后，在可信 lifecycle 到达前保持 `agent_starting`。
2. shell metadata 必须识别实际 Agent executable，不得把 `export`、环境变量赋值或用户 prompt 当作 `activeCommand`。
3. matching operation hook 推进 `agent_running/agent_idle`；stale 或缺失 operation hook 保持零副作用。
4. 单 Pane 与多 Pane的 `/state`、Home overview 和 Pane workspace 结论一致。
5. zsh 与 bash、复用 Pane 与新建 Pane、成功与启动失败路径均可恢复到正确状态。

不覆盖 backend 崩溃后的 prepare milestone 恢复，也不解决 Agent 进程退出后的 operation generation 退休策略；两者是独立生命周期问题。若本次实现改动相关协议或退休策略，必须先扩展本文件再实施。

本仓库不新增单元测试、Vitest 或 Playwright spec。后端状态机通过现有 behavior verifier 验证；真实终端与浏览器路径使用隔离 profile 和 `$toolkit:playwright-cli` 取证。

## 前提事实

- prepare 入口为 `POST /api/terminal/session/:id/agent/prepare`，成功响应包含 `operationId`、`panelId`、`tmuxPaneId`、`phase="command_submitted"` 和 `status="starting"`。
- `backend/src/terminal/application/agent-preparation.ts` 在输入被接受后将目标 Pane 写为 `agent_starting`。
- shell integration 通过 `OSC 633;RunweaveCommand=<command>` 和 tmux Pane option `@runweave_command` 提供 executable metadata。
- `ensureTmuxPanelWorkspace()` 会根据 Pane metadata 更新 `activeCommand` 和 `terminalState`；该刷新不得覆盖更强的 prepare/lifecycle 事实。
- Hook bridge 从 Agent 进程环境读取 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID`，并把它作为 `operationId` 上报。
- `processTerminalAgentHook()` 用 terminal session、Panel、tmux Pane、provider 和 operation generation 校验 hook 归属。
- `/api/terminal/session/:id/state` 和 `/api/app/home/overview` 是最终用户可见状态的权威读取入口。
- 所有真实验收必须使用临时 profile 或已声明的隔离复现场景，结束后删除临时 terminal 并确认状态恢复。

## 设计矩阵

| 维度         | 等价类 / 边界                                                 |
| ------------ | ------------------------------------------------------------- |
| Shell        | zsh、bash                                                     |
| Pane 来源    | 复用现有 Pane、新建 split Pane                                |
| Lifecycle    | 无 hook、matching operation、stale operation、缺 operation    |
| Agent 状态   | `shell_idle -> agent_starting -> agent_running -> agent_idle` |
| Session 结构 | 单 Pane、多 Pane                                              |
| 启动结果     | Agent 正常进入 TUI、启动命令快速失败                          |
| Metadata     | Agent executable、环境变量赋值、shell idle                    |
| 消费面       | Pane workspace、`/state`、Home overview、浏览器 UI/API        |

鉴权 schema、非法 body 和不存在 session 已由 `terminal-state-test-cases.md` 覆盖，本文件不重复。

## 必跑命令

按顺序执行，任一失败即停止：

```bash
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm agent-team:verify-review-checkpoints
git diff --check
```

行为命令不能由上述静态门禁替代。真实浏览器用例必须实际执行 `$toolkit:playwright-cli`。

## 用例映射

- `TAP-001`：prepare 返回后立即刷新 workspace 仍保持 Agent Starting。
- `TAP-002`：标准 Codex prepare 的 activeCommand 为 Codex executable 且不泄露 prompt。
- `TAP-003`：matching operation 的 UserPromptSubmit 推进 Agent Running。
- `TAP-004`：matching operation 的 Stop 推进 Agent Idle，metadata 刷新不降级。
- `TAP-005`：stale operation hook 对状态和 thread metadata 零副作用。
- `TAP-006`：缺失 operation 的 hook 在 retained generation 下零副作用。
- `TAP-007`：同一 Pane 并发 prepare 被拒绝且不重复提交。
- `TAP-008`：提交前失败恢复上一代 operation generation。
- `TAP-009`：zsh 与 bash 都能跳过环境变量前缀识别 Agent executable。
- `TAP-010`：复用 Pane 与新建 Pane 使用相同状态契约。
- `TAP-011`：启动命令快速失败后最终回到 Shell Idle。
- `TAP-012`：多 Pane 中一个 Agent Running 时 Session 与 Home 均保持 Running。
- `TAP-013`：多 Pane 中一个 Pane Stop、另一个仍 Running 时聚合状态不回退。
- `TAP-014`：真实 App Home/Terminal 页面在 prepare 生命周期中显示一致状态。
- `TAP-015`：activeCommand、tmux option、metadata 响应和日志不包含用户 prompt。

## 用例细则

### TAP-001 prepare 返回后立即刷新 workspace 仍保持 Agent Starting

- 设计技术：状态迁移、异步竞态。
- 验证方式：behavior verifier + `$toolkit:playwright-cli` 真实 API。
- Given：目标 Pane 为 `shell_idle`，没有正在进行的 prepare。
- When：
  1. 调用 Agent Prepare 并获得 `phase="command_submitted"`。
  2. 在 matching lifecycle 到达前立即读取 Pane workspace。
  3. 连续触发或等待至少两次真实 tmux metadata 刷新。
- Then：目标 Pane 的状态始终为 `agent_starting/<provider>`；不得出现 `shell_idle/null`。
- 失败判断：任一次 workspace/API 采样在 lifecycle 到达前降为 Shell Idle。

### TAP-002 标准 Codex prepare 只暴露 Codex executable

- 设计技术：等价类、历史缺陷回归。
- 验证方式：真实 tmux + `$toolkit:playwright-cli` API 取证。
- Given：使用默认 Codex command 和包含唯一标记的测试 prompt。
- When：执行 prepare，并读取 Pane workspace、tmux `@runweave_command` 和 shell metadata。
- Then：稳定后的 `activeCommand` 可规范化为 `codex`；不得为 `export`、`env` 或 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID=...`。
- 失败判断：等待 3 秒后仍为包装 token，或任何 activeCommand 字段包含 prompt。

### TAP-003 matching operation 推进 Agent Running

- 设计技术：状态迁移、判定表。
- 验证方式：behavior verifier + 真实 hook。
- Given：Pane 为 `agent_starting`，服务端 retained generation 与 hook `operationId` 相同。
- When：上报 `UserPromptSubmit`。
- Then：hook 返回 recorded；Pane 为 `agent_running`；单 Pane `/state` 和 Home 为 Agent Running。
- 失败判断：hook ignored，或任何消费面保持 Starting/Shell Idle。

### TAP-004 matching Stop 后保持 Agent Idle

- 设计技术：状态迁移、异步竞态。
- 验证方式：behavior verifier + 真实 hook/API。
- Given：目标 Pane 为 `agent_running`，operation identity 匹配。
- When：上报 `Stop`，随后再次刷新 tmux workspace。
- Then：Pane、单 Pane `/state` 和 Home 收敛为 `agent_idle`；metadata 刷新不得降为 Shell Idle。
- 失败判断：Stop 被忽略，或 hook 后刷新覆盖 Agent Idle。

### TAP-005 stale operation hook 零副作用

- 设计技术：无效等价类、并发隔离。
- 验证方式：behavior verifier。
- Given：Pane retained generation 为 operation B，状态和 thread metadata 已记录快照。
- When：operation A 上报 UserPromptSubmit 或 Stop。
- Then：返回 ignored；状态、thread、lastThread、事件数量和 callback 数量均不变化。
- 失败判断：任一字段变化或发布状态事件。

### TAP-006 缺失 operation hook 零副作用

- 设计技术：空值、判定表。
- 验证方式：behavior verifier。
- Given：Pane 存在 retained generation，且没有独立可信 current-thread identity。
- When：不携带 operationId 上报非 SessionStart hook。
- Then：返回 ignored，状态和 metadata 零副作用。
- 失败判断：缺 operation hook 推进状态或覆盖 thread。

### TAP-007 同 Pane 并发 prepare 不重复提交

- 设计技术：并发、幂等。
- 验证方式：behavior verifier。
- Given：同一 Pane 的 prepare A 尚未完成提交。
- When：并发发起 prepare B。
- Then：B 返回 409；Pane 只收到 A 的一条 launch command；A 的 operation generation 保持有效。
- 失败判断：两条 Agent command 被提交，或 B 覆盖 A generation。

### TAP-008 提交前失败恢复上一代 generation

- 设计技术：异常流、状态回滚。
- 验证方式：`pnpm agent-team:verify-review-checkpoints`。
- Given：Pane 已保留成功 operation A。
- When：prepare B 在命令提交前失败。
- Then：B 返回可定位错误；operation A generation 恢复；A 的 stale 防护规则不变。
- 失败判断：generation 丢失、变成 B，或 stale hook 被接受。

### TAP-009 zsh 与 bash 都识别环境变量后的 executable

- 设计技术：等价类、兼容性。
- 验证方式：真实 shell behavior verifier。
- Given：分别启动带 Runweave shell integration 的 zsh 和 bash。
- When：执行 `RUNWEAVE_TERMINAL_AGENT_OPERATION_ID=<id> codex ...` 等价命令。
- Then：两种 shell 都只上报 `codex`；赋值本身不得清空或替代 Agent command。
- 失败判断：任一 shell 上报赋值 token、`export`、完整命令或 prompt。

### TAP-010 复用与新建 Pane 遵循相同契约

- 设计技术：等价类、场景法。
- 验证方式：behavior verifier + 真实 API 抽样。
- Given：一条用例指定已有 `panelId`，另一条不指定并创建 split Pane。
- When：分别执行 prepare。
- Then：都只提交一次 command，并经历 Starting -> Running -> Idle；Panel/tmux Pane identity 不串线。
- 失败判断：任一路径跳过 Starting、重复发送或更新错误 Pane。

### TAP-011 启动命令快速失败后回到 Shell Idle

- 设计技术：异常流、状态终止。
- 验证方式：隔离真实 tmux/API。
- Given：使用确定返回非零的测试 command，且不启动后台进程。
- When：prepare 返回 command_submitted 后等待命令退出和 shell prompt 恢复。
- Then：3 秒一致性窗口内 Pane `activeCommand=null`、`terminalState=shell_idle/null`；不得残留 Running/Starting。
- 失败判断：超时后仍保留 Agent 状态或包装命令。

### TAP-012 多 Pane 中任一 Agent Running 时聚合为 Running

- 设计技术：判定表、多实例隔离。
- 验证方式：真实多 Pane + `$toolkit:playwright-cli`。
- Given：同一 Session 有两个 running Pane，一个 idle、一个 Agent Running。
- When：读取 Pane workspace、`/state` 和 Home overview。
- Then：Pane 各自状态保持独立；Session 与 Home 聚合为 Agent Running。
- 失败判断：idle Pane 被改成 running，或 Session/Home 返回 Idle。

### TAP-013 一个 Pane Stop 不得覆盖另一个 Running Pane

- 设计技术：状态迁移、并发。
- 验证方式：真实多 Pane hook + `$toolkit:playwright-cli`。
- Given：同一 Session 两个 Pane 都为 Agent Running。
- When：仅对 Pane A 上报 matching Stop。
- Then：Pane A 为 Agent Idle、Pane B 仍 Running；hook 响应、`/state` 和 Home 均保持 Running。
- 失败判断：Session/Home 因 Pane A Stop 回退为 Idle。

### TAP-014 App Home 与 Terminal 页面实时一致

- 设计技术：端到端场景。
- 验证方式：`$toolkit:playwright-cli` 真实浏览器。
- Given：隔离 profile 已运行 Web/App 页面，目标 Session 可见。
- When：
  1. 通过真实 API 发起 prepare。
  2. 在 Starting、Running、Idle 三个阶段读取页面 DOM和对应 API。
- Then：Home 与 Terminal 对同一 Session 的显示状态一致；Running 阶段显示 Agent Running，Idle 阶段不显示 Stop。
- 失败判断：页面间状态分裂超过 3 秒，或 UI 与 API 结论相反。

### TAP-015 metadata 与日志不得泄露用户 prompt

- 设计技术：安全、错误猜测。
- 验证方式：真实 prepare 后搜索隔离 profile 的 API 响应、tmux option 和 backend metadata 日志。
- Given：prompt 含唯一无敏感含义的 canary 标记。
- When：完成一次 prepare 生命周期并采集 activeCommand 相关证据。
- Then：canary 只允许出现在明确承载 query/prompt 的受控 hook/activity 字段；不得出现在 activeCommand、tmux `@runweave_command`、metadata event 或 session title。
- 失败判断：任一命令识别或展示字段包含 canary/完整 prompt。

## 执行顺序

1. 在修复前执行 `TAP-001`、`TAP-002`，保存失败证据。
2. 完成最小实现修改。
3. 执行全部必跑命令。
4. 严格按 `TAP-001` 至 `TAP-015` 顺序执行；实现失败时修实现并重跑当前用例，不修改本文档。
5. 验收结束后删除临时 terminal、停止本次临时服务或恢复复现场景原状态。

## 验收通过标准

必须同时满足：

- 必跑命令全部通过。
- `TAP-001` 至 `TAP-015` 全部通过或按前置条件明确记录非阻塞 skipped；核心用例 `TAP-001` 至 `TAP-006`、`TAP-009`、`TAP-012` 至 `TAP-015` 不允许 skipped。
- 浏览器用例包含 `$toolkit:playwright-cli` 命令与关键 API/DOM 证据。
- 真实环境结束后无临时 terminal、running Agent 或被修改的用户 Pane。
- 最终 diff 不包含与本需求无关的格式化、重构或测试文件。
