# Terminal Panel Split 测试计划

本文档基于 `docs/plans/2026-06-26-terminal-panel-split.md`，用于覆盖 tmux 原生 split 方案从协议、后端、CLI、事件同步到 Web 验收的测试范围。

涉及打开页面、点击、输入、截图或浏览器自动化验证时，必须使用 `$playwright-cli`。本计划不要求新增前端 Vitest、React unit test、Node test 或其它非 E2E 测试文件；浏览器自动化只放在 `frontend/tests/*.spec.ts`。

## 目标契约

- Web 仍然只有一个 `TerminalSurface`、一个 session-level terminal WebSocket、一个 `tmux attach` runtime。
- Runweave 业务层新增 `TerminalPanel`，每个 panel 绑定稳定 tmux `%pane_id`，不依赖 pane index。
- CLI、API、Orchestrator 可以通过 `panelId`、`alias` 或 `role` 定位 pane。
- 同一 terminal session 内非空 `alias` 和非空 `role` 都必须唯一；创建重复值应返回明确 409，避免后续按 role 路由时随机命中。
- 未指定 panel 的旧 input/interrupt 路径在发送前同步 tmux selected pane，再路由到 active/default panel。
- 未指定 panel 的旧 history/snapshot 路径始终读取 default panel，不跟随 selected pane。
- pty runtime 首期不支持 split，必须返回明确 409。
- Hook/Agent completion 仍按 terminal session 级聚合；`terminalPanelId` 只是可选来源 metadata。
- UI panel chips、active target 和 CLI/API 事件可以同步，但不引入 panel-level WebSocket 或多个 React terminal frame。

## 测试环境

建议使用临时配置和临时 workspace，避免污染本机项目、终端和登录态。

```bash
export RUNWEAVE_CONFIG_FILE="$(mktemp -d)/runweave-config.json"
export RUNWEAVE_BACKEND_PORT="${RUNWEAVE_BACKEND_PORT:-5001}"
export RUNWEAVE_BASE_URL="${RUNWEAVE_BASE_URL:-http://127.0.0.1:${RUNWEAVE_BACKEND_PORT}}"
export RW_BIN="node packages/runweave-cli/dist/index.js"
```

基础准备：

```bash
pnpm --filter ./packages/runweave-cli build
pnpm dev
$RW_BIN auth login --base-url "$RUNWEAVE_BASE_URL" --username admin
```

如果需要隔离 backend 状态，使用临时 Runweave state/config 目录启动后端，并在测试完成后删除临时目录。涉及真实 tmux 行为的用例必须在本机 tmux 可用时执行。

## 静态验证

| ID             | 范围     | 命令                                              | 预期                                   |
| -------------- | -------- | ------------------------------------------------- | -------------------------------------- |
| TPS-STATIC-001 | shared   | `pnpm --filter ./packages/shared typecheck`       | panel 协议和事件类型无 TS 错误         |
| TPS-STATIC-002 | backend  | `pnpm --filter ./backend typecheck`               | panel routes/store/tmux 类型无 TS 错误 |
| TPS-STATIC-003 | backend  | `pnpm --filter ./backend lint`                    | 无 lint error                          |
| TPS-STATIC-004 | frontend | `pnpm --filter ./frontend typecheck`              | panel target UI 类型无 TS 错误         |
| TPS-STATIC-005 | frontend | `pnpm --filter ./frontend lint`                   | 无 lint error                          |
| TPS-STATIC-006 | CLI      | `pnpm --filter ./packages/runweave-cli typecheck` | panel CLI 参数和 client 类型无 TS 错误 |
| TPS-STATIC-007 | CLI      | `pnpm --filter ./packages/runweave-cli lint`      | 无 lint error                          |
| TPS-STATIC-008 | 全量     | `pnpm typecheck`                                  | 跨包协议联动无 TS 错误                 |
| TPS-STATIC-009 | diff     | `git diff --check`                                | Markdown/代码无尾随空白                |

## 协议与兼容层

| ID            | 场景                   | 步骤                                                            | 预期                                                                                                    |
| ------------- | ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| TPS-PROTO-001 | panel 类型导出         | 检查 `packages/shared/src/terminal-protocol.ts`                 | 导出 `TerminalPanelListItem`、`TerminalPanelWorkspace`、create/update/input payload 和 role suggestions |
| TPS-PROTO-002 | 可选字段兼容           | 使用旧客户端 payload 调用 session-level input/history/ws-ticket | 请求仍被接受；旧 payload 不要求携带 `panelId`                                                           |
| TPS-PROTO-003 | session list 轻量字段  | 调用 terminal session list/show                                 | 返回可选 `activePanelId`、`panelCount`、`panelAliases`；缺字段时旧客户端不崩溃                          |
| TPS-PROTO-004 | app-server event scope | 构造带 panel env 的 hook event                                  | `scope.terminalSessionId` 必有；可识别时附带 `terminalPanelId`；不可识别时仍为 session-level            |
| TPS-PROTO-005 | WebSocket 协议不扩张   | 检查 terminal WS ticket 和连接 URL                              | 仍只要求 `terminalSessionId`，不新增 `/ws/terminal?panelId=...` 主路径                                  |

## 存储、迁移与恢复

| ID            | 场景                               | 步骤                                                                     | 预期                                                                  |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| TPS-STORE-001 | 老 tmux session 生成 default panel | 使用旧数据启动 backend；调用 `GET /api/terminal/session/:id/panels`      | 返回 1 个 default panel，绑定当前 tmux 第一个/当前 pane 的 `%pane_id` |
| TPS-STORE-002 | pty session 兼容 default panel     | 创建 pty terminal；调用 panel list                                       | 返回内存兼容 default panel；不允许 split                              |
| TPS-STORE-003 | panel workspace 持久化             | 在 tmux session 内 split 两个 panel；重启 backend；调用 panel list       | panel workspace 与 `tmux list-panes` 的真实 `%pane_id` 一致           |
| TPS-STORE-004 | pane 已丢失时收敛                  | 外部执行 `tmux kill-pane -t %pane`；调用 panel list 或 selected sync     | 丢失 panel 不再作为 running 可发送目标；发出删除或 exited 事件        |
| TPS-STORE-005 | tmux session 丢失重建              | 停止/删除原 tmux session 后恢复 terminal                                 | 旧 panel metadata 不绑定到新 session；创建新的 default panel          |
| TPS-STORE-006 | 删除 session 清理 panel            | 删除 terminal session 后检查 store                                       | 同步删除该 session 的 panels 和 workspace                             |
| TPS-STORE-007 | default panel 缺失修复             | 手动制造 workspace 缺 default 但 tmux session 存在；调用 session history | 使用 `tmux list-panes` 第一个 pane 重建 default panel 后读取          |
| TPS-STORE-008 | stale `%pane_id` 不可发送          | 持久化记录指向不存在的 `%pane_id`；调用 panel input                      | 返回明确错误或先收敛状态；不得向错误 pane 发送                        |

## tmux Pane 能力

| ID           | 场景               | 步骤                                    | 预期                                                         |
| ------------ | ------------------ | --------------------------------------- | ------------------------------------------------------------ |
| TPS-TMUX-001 | list panes         | 对 tmux session 调用 list panes 能力    | 返回 `paneId`、`paneIndex`、`cwd`、`activeCommand`、`active` |
| TPS-TMUX-002 | split right        | 从 source panel 调用 `direction=right`  | 执行 tmux horizontal split，返回稳定 `%pane_id`              |
| TPS-TMUX-003 | split down         | 从 source panel 调用 `direction=down`   | 执行 tmux vertical split，返回稳定 `%pane_id`                |
| TPS-TMUX-004 | split cwd 继承     | source pane 在特定 cwd；split 不传 cwd  | 新 pane 继承 source cwd                                      |
| TPS-TMUX-005 | split 指定 command | split 时传 `command/args`               | 新 pane 执行指定命令；metadata 中 active command 可读取      |
| TPS-TMUX-006 | split 失败不写状态 | 模拟 tmux split 失败                    | API 返回 500；store 不出现半创建 panel                       |
| TPS-TMUX-007 | send to pane       | 向 tests panel 发送 `echo tests-panel`  | 只在 tests pane 出现输出                                     |
| TPS-TMUX-008 | capture pane       | 不同 pane 写入不同 marker；分别 capture | panel-level history/snapshot 只返回目标 pane 内容            |
| TPS-TMUX-009 | select pane        | focus tests panel                       | 调用 `select-pane -t %pane`；tmux selected pane 变为 tests   |
| TPS-TMUX-010 | read selected pane | 在 tmux 内切换 selected pane 后读取     | 返回当前 selected `%pane_id`                                 |
| TPS-TMUX-011 | kill pane          | close 非最后一个 panel                  | 执行 `kill-pane -t %pane`；panel list 移除或标记 exited      |
| TPS-TMUX-012 | close last panel   | 只剩 default panel 时 close             | 返回 409，提示先关闭 terminal session                        |
| TPS-TMUX-013 | pane target 格式   | 代码审查或日志检查 tmux 命令            | pane 操作都使用 `-t %pane_id`，不使用易漂移 pane index       |

## 后端 Panel API

| ID          | 场景                | 请求/步骤                                                 | 预期                                                           |
| ----------- | ------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| TPS-API-001 | list panels         | `GET /api/terminal/session/:id/panels`                    | 200，返回 workspace、activePanelId、panels                     |
| TPS-API-002 | session 不存在      | 对 missing session 调用 panel list/create                 | 404                                                            |
| TPS-API-003 | create right        | `POST /panels { "direction": "right", "alias": "tests" }` | 201/200，返回新 panel 和 workspace                             |
| TPS-API-004 | create down         | `POST /panels { "direction": "down", "role": "server" }`  | 新 panel role 为 server                                        |
| TPS-API-005 | alias 唯一          | 同一 session 内创建重复 alias                             | 409，错误可读                                                  |
| TPS-API-006 | role 唯一            | 同一 session 内创建重复 role                              | 409，错误可读                                                  |
| TPS-API-007 | focus panel         | `PATCH /panels/:panelId { "focus": true }`                | activePanelId 更新；tmux selected pane 同步                    |
| TPS-API-008 | close panel         | `DELETE /panels/:panelId`                                 | panel 删除；active panel 被删时切到 workspace 新 activePanelId |
| TPS-API-009 | panel input         | `POST /panels/:panelId/input`                             | 输入只进入目标 pane                                            |
| TPS-API-010 | panel interrupt     | 目标 pane 运行长命令；`POST /panels/:panelId/interrupt`   | 只中断目标 pane                                                |
| TPS-API-011 | panel history       | `GET /panels/:panelId/history?tail=120`                   | 只读取目标 pane capture                                        |
| TPS-API-012 | pty split           | pty runtime 调用 create panel                             | 409，message 包含 `Panel split requires tmux runtime`          |
| TPS-API-013 | tmux 操作失败       | 模拟 send/capture/kill 失败                               | 返回 500；错误不伪装成功                                       |
| TPS-API-014 | invalid payload     | direction 缺失/非法、alias 空字符串、未知字段             | 400 或按 schema 明确处理；不得写入状态                         |

## 默认路由与旧接口兼容

| ID             | 场景                          | 步骤                                                                            | 预期                                          |
| -------------- | ----------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| TPS-COMPAT-001 | 旧 input 同步 selected pane   | 在 tmux 内切到 tests pane；调用 session-level input 不传 panel                  | 先同步 selected pane，再发送到 tests pane     |
| TPS-COMPAT-002 | selected sync 失败回退 active | 模拟 `readSelectedPane` 失败；activePanelId 为 server                           | 旧 input 发送到 server panel                  |
| TPS-COMPAT-003 | 无 active 回退 default        | selected sync 失败且没有 activePanelId                                          | 旧 input 发送到 default panel                 |
| TPS-COMPAT-004 | 旧 interrupt 同步 selected    | tests pane 跑长命令；tmux selected 为 tests；session-level interrupt            | 只中断 tests pane                             |
| TPS-COMPAT-005 | 旧 history 固定 default       | selected pane 是 tests；default/tests 分别写 marker；调用 session-level history | 返回 default marker，不返回 tests-only marker |
| TPS-COMPAT-006 | 旧 snapshot 固定 default      | selected pane 是 tests；调用 `rw terminal snapshot <session>`                   | 读取 default panel                            |
| TPS-COMPAT-007 | panelId 优先级最高            | body 同时传 `panelId` 和 `panelAlias/role`                                      | 按 `panelId` 路由                             |
| TPS-COMPAT-008 | alias 优先于 role             | body 传 `panelAlias` 和 `role`                                                  | 按 alias 路由                                 |
| TPS-COMPAT-009 | missing panel target          | 指定不存在的 panelId/alias/role                                                 | 404 或明确 target not found                   |
| TPS-COMPAT-010 | ws-ticket 旧路径              | 获取并连接 session-level ws ticket                                              | 成功连接同一个 terminal attach surface        |

## Terminal Events 与 Hook

| ID          | 场景                  | 步骤                                                  | 预期                                                                     |
| ----------- | --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| TPS-EVT-001 | panel created event   | API/CLI split panel                                   | 记录 `terminal_panel_created`，payload 含 panel 和 workspace             |
| TPS-EVT-002 | panel focused event   | UI/API/CLI focus panel                                | 记录 `terminal_panel_focused`，source 分别为 `ui`/`api`/`cli`            |
| TPS-EVT-003 | tmux sync focus event | 旧 input 前 selected sync 改变 activePanelId          | 记录 `terminal_panel_focused(source: "tmux")`                            |
| TPS-EVT-004 | panel deleted event   | close panel 或外部 kill 后收敛                        | 记录 `terminal_panel_deleted` 或 exited update                           |
| TPS-EVT-005 | panel input event     | panel-level input                                     | 记录 `terminal_panel_input_sent`，不包含敏感超长输入正文或按现有策略裁剪 |
| TPS-EVT-006 | catchup               | 断开 terminal-events WS；期间 split/focus/close；重连 | catchup 后 UI workspace 与 backend 一致                                  |
| TPS-EVT-007 | live delivery         | 浏览器打开时 CLI split/focus/close                    | UI 无刷新更新 chips 和 active target                                     |
| TPS-EVT-008 | CLI 不抢当前 tab      | 当前浏览器在 session A；CLI focus session B panel     | session B 状态更新，但浏览器不自动切到 B                                 |
| TPS-EVT-009 | hook panel env        | 新 panel 内触发 Codex/Hook 事件                       | 能识别 env 时 app-server/backend scope 附带 `terminalPanelId`            |
| TPS-EVT-010 | hook 降级             | 历史 pane 或无 panel env 触发 hook                    | 仍产生 session-level notification，不因缺 panel 失败                     |
| TPS-EVT-011 | completion 聚合       | tests panel 触发 completion                           | terminal notification 仍按 session 展示；panel 信息只作为详情/metadata   |

## CLI 控制面

| ID          | 场景                | 命令/步骤                                                                                                     | 预期                                                     |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| TPS-CLI-001 | panel list JSON     | `$RW_BIN terminal panel list "$TERMINAL_ID" --json`                                                           | 输出 workspace JSON                                      |
| TPS-CLI-002 | split alias         | `$RW_BIN terminal panel split "$TERMINAL_ID" --from main --direction right --alias tests --role tests --json` | 返回 tests panel                                         |
| TPS-CLI-003 | split from panel id | 使用 panel id 作为 `--from`                                                                                   | 从指定 pane split                                        |
| TPS-CLI-004 | focus alias         | `$RW_BIN terminal panel focus "$TERMINAL_ID" tests --json`                                                    | activePanelId 为 tests panel                             |
| TPS-CLI-005 | close alias         | `$RW_BIN terminal panel close "$TERMINAL_ID" tests --json`                                                    | tests panel 被关闭                                       |
| TPS-CLI-006 | send panel alias    | `$RW_BIN terminal send "$TERMINAL_ID" --panel tests --text "echo tests" --enter --json`                       | 只进入 tests pane                                        |
| TPS-CLI-007 | send role           | `$RW_BIN terminal send "$TERMINAL_ID" --role server --text "echo server" --enter --json`                      | 只进入 server role pane                                  |
| TPS-CLI-008 | panel 优先 role     | 同时传 `--panel tests --role server`                                                                          | 发送到 tests                                             |
| TPS-CLI-009 | role 重复           | 已存在 worker role；再次 split `--role worker`                                                                | exit code 4，stderr 保留 409 role 重复错误                |
| TPS-CLI-010 | snapshot panel      | `$RW_BIN terminal snapshot "$TERMINAL_ID" --panel tests --tail 120 --plain`                                   | 只返回 tests pane 内容                                   |
| TPS-CLI-011 | interrupt panel     | `$RW_BIN terminal interrupt "$TERMINAL_ID" --panel tests --json`                                              | 只中断 tests pane                                        |
| TPS-CLI-012 | handoff panel 信息  | `$RW_BIN terminal handoff "$TERMINAL_ID" --json`                                                              | 输出 `panels`、`activePanelId`、`suggestedPanelCommands` |
| TPS-CLI-013 | pty split           | 对 pty terminal 执行 panel split                                                                              | exit code 非 0；stderr 保留 409 message                  |
| TPS-CLI-014 | missing panel       | 指定不存在 alias                                                                                              | exit code 4；不伪装成功                                  |
| TPS-CLI-015 | no panel 兼容 send  | `$RW_BIN terminal send "$TERMINAL_ID" --text "echo default" --enter --json`                                   | 走 selected pane sync 兼容路径                           |

## Orchestrator 路由

| ID           | 场景                        | 步骤                                           | 预期                                                       |
| ------------ | --------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| TPS-ORCH-001 | new binding 创建 role panel | worker binding `mode: "new"`，role 为 reviewer | 创建或复用 session 后 split reviewer panel，alias 默认可用 |
| TPS-ORCH-002 | reuse by panelId            | binding 指定 existing session + panelId        | worker direct send 路由到目标 panel                        |
| TPS-ORCH-003 | reuse by alias              | binding 指定 alias tests                       | 路由到 tests panel                                         |
| TPS-ORCH-004 | reuse by role               | binding 指定 role planner                      | 路由到 planner panel                                       |
| TPS-ORCH-005 | target 不存在               | binding 指向 missing panel                     | 返回 human-readable error，不静默创建错误 panel            |
| TPS-ORCH-006 | timeline target             | Orchestrator direct send                       | timeline 包含 `terminalPanelId` 和 `panelAlias`            |
| TPS-ORCH-007 | role 已占用                  | new binding 尝试创建已存在 role 的 panel        | 返回明确冲突；需要复用时必须改用 existing binding / role 路由 |

## Web UI 与 `$playwright-cli` 验收

建议新增或扩展 Playwright E2E：`frontend/tests/terminal-panels.spec.ts`。只覆盖用户可见 split、focus、CLI/API event sync、单 surface 约束和 preview resize，不新增前端 unit test。

| ID          | 场景                             | 步骤                                                        | 预期                                                                      |
| ----------- | -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| TPS-WEB-001 | 单 TerminalSurface               | 使用 `$playwright-cli` 打开 `/terminal` 并创建 tmux session | DOM/截图中只有一个 terminal surface；没有多个 React terminal frame/header |
| TPS-WEB-002 | UI split right                   | 点击 Split Right                                            | 同一个 xterm 内出现 tmux 原生 split；panel chips 增加新目标               |
| TPS-WEB-003 | UI split down                    | 点击 Split Down                                             | 同一个 xterm 内出现第三个 tmux pane                                       |
| TPS-WEB-004 | chip focus                       | 点击 tests chip                                             | active target breadcrumb 更新；tmux selected pane 同步到 tests            |
| TPS-WEB-005 | xterm 输入                       | focus tests pane 后在 xterm 输入 marker                     | marker 出现在当前 selected pane                                           |
| TPS-WEB-006 | CLI split live sync              | 浏览器保持打开；CLI 执行 panel split                        | UI 无刷新增加 chip；xterm 内出现新 pane                                   |
| TPS-WEB-007 | CLI focus live sync              | CLI focus server panel                                      | active target 更新，但不切换浏览器当前 session tab                        |
| TPS-WEB-008 | CLI close live sync              | CLI close tests panel                                       | chip 移除；active target 按 workspace 更新                                |
| TPS-WEB-009 | selected pane sync               | 在 tmux 内切换 pane；执行无 `--panel` CLI send              | 输出进入当前 selected pane；UI 收到 sync event 后更新 active target       |
| TPS-WEB-010 | default snapshot 不跟随 selected | selected 为 tests；执行无 panel snapshot/history            | 结果仍来自 default panel                                                  |
| TPS-WEB-011 | preview sidecar resize           | 打开/关闭 preview sidecar                                   | 仍是单 terminal surface resize；tmux layout 不重叠、不出现空白 terminal   |
| TPS-WEB-012 | session notification             | panel 内触发 completion                                     | terminal session 级 notification 正常展示；chip 不承担独立 readiness 状态 |
| TPS-WEB-013 | reconnect catchup                | 断开/刷新页面前执行 split/focus                             | 页面恢复后 chips、active target 和 backend workspace 一致                 |
| TPS-WEB-014 | mobile/App 非目标                | 检查首期 Web 实现范围                                       | 不要求 Ionic App 提供 panel split UI；不破坏现有 App terminal 页面        |

## 原型验证

原型只验证交互方向，不验证真实 backend、tmux 或 WebSocket。

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-panel-split
```

| ID                | 场景            | 步骤                                 | 预期                                         |
| ----------------- | --------------- | ------------------------------------ | -------------------------------------------- |
| TPS-PROTOTYPE-001 | 单 surface 暗示 | 打开 `http://127.0.0.1:6188/`        | 页面主体只有一个 `tmux attach surface`       |
| TPS-PROTOTYPE-002 | 模拟 split      | 点击 Split Right / Split Down        | 在同一个模拟 surface 内增加 pane             |
| TPS-PROTOTYPE-003 | 模拟 CLI event  | 点击 Simulate CLI split              | chips 和 active target 通过模拟事件更新      |
| TPS-PROTOTYPE-004 | 非产品脚手架    | 检查 event feed、toast、CLI simulate | 明确只作为验证脚手架，不直接移植到产品主界面 |

## 负向与边界测试

| ID          | 场景                  | 步骤                                | 预期                                      |
| ----------- | --------------------- | ----------------------------------- | ----------------------------------------- |
| TPS-NEG-001 | 非 tmux runtime split | pty session 调 panel create         | 409，错误文案明确                         |
| TPS-NEG-002 | 关闭最后 panel        | 只剩一个 panel 时 close             | 409，提示关闭 terminal session            |
| TPS-NEG-003 | alias 空值            | 创建 alias 为空字符串或全空白       | 400 或归一为 null；不得形成不可寻址 alias |
| TPS-NEG-004 | alias 重复            | 同 session 重复 alias               | 409                                       |
| TPS-NEG-005 | role 重复             | 同 session 重复 role                | 409                                       |
| TPS-NEG-006 | pane 被外部删除       | 删除 tmux pane 后发送 input         | 不写入错误目标；先收敛或返回明确错误      |
| TPS-NEG-007 | terminal exited       | exited session 调 panel input/split | 非 0/4xx，错误可读                        |
| TPS-NEG-008 | tmux 不可用           | tmux 命令不可用时创建 tmux split    | 返回明确后端错误；不写半状态              |
| TPS-NEG-009 | 超大 input            | panel input 发送超过现有限制的内容  | 按现有输入限制拒绝或截断策略处理          |
| TPS-NEG-010 | command args 转义     | split 指定包含空格/`--` 的 args     | args 不被 shell/CLI parser 错误拆分       |

## 发布前回归清单

1. 跑完静态验证命令。
2. 手动或脚本化完成 tmux API、存储恢复、CLI 控制面用例中的 P0 路径：create/list/split/focus/send/snapshot/close/restart。
3. 使用 `$playwright-cli` 完成 Web 主路径验收：UI split、CLI live sync、selected pane sync、preview resize。
4. 确认代码搜索中不存在 panel-level terminal WebSocket 主路径、多个 React `TerminalSurface` cache、pane index 作为业务 target。
5. 确认旧 session-level input/history/snapshot/ws-ticket 路径仍可用。
6. 确认 Hook/Agent notification 仍按 terminal session 级展示，panel metadata 缺失时可降级。

## 覆盖映射

| 计划范围                                 | 覆盖用例                                                |
| ---------------------------------------- | ------------------------------------------------------- |
| 阶段 1 协议、存储和 default panel 兼容层 | TPS-PROTO、TPS-STORE、TPS-COMPAT                        |
| 阶段 2 tmux pane 能力和 panel API        | TPS-TMUX、TPS-API、TPS-NEG                              |
| 阶段 3 Hook 和事件同步                   | TPS-EVT、TPS-WEB-006 至 TPS-WEB-013                     |
| 阶段 4 Web tmux-native Panel UI          | TPS-WEB、TPS-PROTOTYPE                                  |
| 阶段 5 CLI 和 Orchestrator 路由          | TPS-CLI、TPS-ORCH                                       |
| 非目标约束                               | TPS-PROTO-005、TPS-WEB-001、TPS-WEB-014、发布前回归清单 |
