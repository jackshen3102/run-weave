# Terminal activeCommand 一致性测试案例

本文档定义 `activeCommand` 的系统级测试用例。目标是验证 Runweave 展示和暴露的 `activeCommand` 与当前终端正在执行的前台命令一致，覆盖 Codex、Trae/Traex、npm/pnpm/yarn、node、sleep 等常见命令，以及命令结束、切换、Ctrl-C、刷新和 tmux 恢复场景。

涉及打开页面、点击、输入、截图或浏览器自动化时，必须使用 `$playwright-cli`，不要使用其它浏览器操作方案。

## 测试目标

- 终端进入空闲 shell 时，`activeCommand` 必须为 `null`。
- 终端执行前台命令时，`activeCommand` 必须反映当前前台命令。
- 命令结束、被 Ctrl-C 中断、session 退出后，`activeCommand` 不得继续保留旧值。
- `activeCommand` 变化最终应体现在：
  - `GET /api/terminal/session/:terminalSessionId`
  - `GET /api/terminal/session` 列表 payload
  - `GET /api/terminal/session/:terminalSessionId/history`
  - `GET /api/app/home/overview`
  - `/ws/terminal` 的 `metadata` 消息
  - Web terminal tab 标题，例如 `browser-viewer(node)`
  - App Home / App terminal detail 的标题、状态和 `terminalState` 展示
  - 后端持久化 session metadata，刷新页面后不恢复过期旧值
- `activeCommand` 对 `TerminalState` 的间接影响最终不应被旧值误导：`activeCommand=codex` 可以推动 Codex idle 状态，`activeCommand=null` 或非 Codex 不能长期让 `/ws/terminal-events` 发布或消费成 Codex 状态。
- 多 session 并行时，一个 session 的命令变化不得污染另一个 session。

## 当前代码事实

- shell integration 通过 OSC marker 上报命令：`OSC 633;BrowserViewerCommand=<command>`。
- zsh 使用 `preexec` 设置命令、`precmd` 清空命令；bash 使用 `DEBUG` trap 设置命令、`PROMPT_COMMAND` 清空命令。
- tmux-backed session 会优先读取 pane option `@runweave_command`，没有值时再读取 `pane_current_command`。
- 后端收到 metadata 后通过 `TerminalSessionManager.updateSessionMetadata()` 更新内存和 lowdb。
- Web 标题通过 `formatTerminalSessionName()` 拼接 `basename(cwd)` 和 `basename(activeCommand)`；`bash/fish/sh/zsh` 不展示在括号中。
- `GET /api/terminal/session` 和 `GET /api/terminal/session/:id/history` 都会从 terminal session payload 返回 `activeCommand`。
- App Home overview 会读取 session 的 `activeCommand` 生成移动端展示字段，同时携带后端 `TerminalState`。
- Web terminal workspace 和 App session 都消费全局 `/ws/terminal-events` 的 `terminal_state_changed`。该事件不直接携带 `activeCommand`，但 `activeCommand` 会影响后端状态服务是否发布 Codex 相关状态变化。

## 契约定义

`activeCommand` 表示 shell 当前前台命令的机器信号，而不是完整命令行、展示文案、TerminalState，也不是 AI 任务是否仍在运行的判定依据。当前首批回归契约按 shell hook / tmux 可稳定产出的 executable token 验证，例如 `npm`、`pnpm`、`node`、`codex`、`/bin/sleep`。

如果后续需要用户视角的展示优化，应新增或派生 `activeCommandLabel` / `displayCommand`，例如把 `env FOO=bar sleep 5` 展示为 `sleep`。不要在首批回归里把这类展示 normalization 混入 `activeCommand` 机器语义。

| 输入命令                            | 目标 `activeCommand`                       | UI 标题片段          | 说明                                                       |
| ----------------------------------- | ------------------------------------------ | -------------------- | ---------------------------------------------------------- |
| `sleep 5`                           | `sleep`                                    | `(sleep)`            | 只取前台命令名，不包含参数                                 |
| `/bin/sleep 5`                      | `/bin/sleep` 或规范化后 `sleep`            | `(sleep)`            | API 可保留路径；UI 应展示 basename                         |
| `node -e "setTimeout(()=>{}, 5e3)"` | `node`                                     | `(node)`             | 当前截图里的 `browser-viewer(node)` 属于这类命令           |
| `npm run dev`                       | `npm`                                      | `(npm)`              | 不应被 tmux `pane_current_command=node` 覆盖成 `node`      |
| `pnpm dev`                          | `pnpm`                                     | `(pnpm)`             | 同上                                                       |
| `yarn dev`                          | `yarn`                                     | `(yarn)`             | 同上                                                       |
| `codex`                             | `codex`                                    | `(codex)`            | 只表示 Codex CLI 在前台，不代表模型正在执行                |
| `traex`                             | `traex`                                    | `(traex)`            | 若本机未安装，系统测试记录为 skipped，不能改用其它命令替代 |
| `VAR=1 sleep 5`                     | 当前实现可为 `VAR=1`；增强展示可为 `sleep` | 当前可显示 `(VAR=1)` | 展示 normalization 新契约，不作为首批阻塞回归              |
| `env FOO=bar sleep 5`               | 当前实现可为 `env`；增强展示可为 `sleep`   | 当前可显示 `(env)`   | 展示 normalization 新契约，不作为首批阻塞回归              |
| `time sleep 5`                      | 当前实现可为 `time`；增强展示可为 `sleep`  | 当前可显示 `(time)`  | 展示 normalization 新契约，不作为首批阻塞回归              |
| 空闲 zsh/bash/fish/sh               | `null`                                     | 无括号               | 交互 shell 本身不视为 active command                       |

如果实现团队决定新增 `activeCommandLine` 或 `displayCommand`，应把完整命令行和展示优化放到新字段或 display helper 中测试；`activeCommand` 仍保持机器可读、可匹配的当前前台命令信号。

## 观测点

每个系统用例优先检查下面核心观测点；若某个链路短暂不同步，按一致性窗口重试：

1. API：`GET /api/terminal/session/:terminalSessionId` 返回的 `activeCommand`。
2. WebSocket：当前 terminal 的 `/ws/terminal` 收到对应 `metadata.activeCommand`。
3. UI：Web terminal tab 或标题展示的 basename 与 `activeCommand` 一致。

系统完整性抽样用例再检查下面扩展观测点：

4. List API：`GET /api/terminal/session` 中目标 session 的 `activeCommand`。
5. History API：`GET /api/terminal/session/:terminalSessionId/history` 中目标 session 的 `activeCommand`，以及 history drawer 标题。
6. App Home：`GET /api/app/home/overview` 中目标 session 的标题、状态和 `terminalState`。
7. Global terminal events：`/ws/terminal-events` 中 `terminal_state_changed` 的 `next` 状态。这里不是直接读取 `activeCommand`，而是验证 stale `activeCommand=codex` 不会在等待窗口后继续误导 Web/App 消费成 Codex Agent 状态。

tmux-backed session 额外记录诊断观测点：

```sh
tmux display-message -p -t <tmuxSessionName> '#{@runweave_command}|#{pane_current_command}|#{pane_current_path}'
```

系统判定以 Runweave API/WS/UI 为准；tmux 命令只用于定位失败原因。

## 一致性窗口

`/ws/terminal` 的 detail UI 可能先于 detail/list/history/App Home API 看到 active command 变化。系统测试不要要求同一轮采样强一致；只要求后端 session metadata 和各消费面在等待窗口内最终一致。

- 命令开始：WS/UI 先显示 active command 后，detail/list/history/App Home API 允许短暂仍为旧值或 `null`。
- 命令结束：tmux/shell 已回到 idle 后，detail/list/history/App Home API 允许短暂仍保留旧 active command。
- 建议等待窗口：本地自动化用 3 秒；慢机器或 CI 可放宽到 5 秒。
- 超过等待窗口仍不一致，才判定为失败。

## 测试环境

- 使用新的临时 profile，避免旧 lowdb metadata 干扰：

```sh
export BROWSER_PROFILE_DIR="$(mktemp -d)"
```

- 分别覆盖 zsh 和 bash。fish/sh 可作为扩展矩阵，不作为首批阻塞项。
- 若测试 UI，必须使用 `$playwright-cli` 打开 Web 页面并输入命令。
- 若测试 API/WS，可通过后端测试工具或 CLI 创建 terminal，但仍应复用真实后端、真实 pty/tmux、真实 shell hook。
- `codex`、`traex` 等本机可能未安装的命令需要先探测 `command -v`。未安装时标记 skipped，并记录原因；不要用 alias 或其它命令冒充。

## 系统测试用例

| ID         | 场景                       | 步骤                                                                                                                                         | 预期                                                                                                                                         |
| ---------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-SYS-001 | 新 zsh terminal 空闲       | 创建 `/bin/zsh` terminal，等待 prompt 出现                                                                                                   | API `activeCommand=null`；WS 最新 metadata 为 `null`；UI 标题只显示 cwd basename，不显示 `(zsh)`                                             |
| AC-SYS-002 | 新 bash terminal 空闲      | 创建 `/bin/bash` terminal，等待 prompt 出现                                                                                                  | API `activeCommand=null`；UI 不显示 `(bash)`                                                                                                 |
| AC-SYS-003 | 普通短命令运行中           | 在 zsh terminal 输入 `sleep 5`，立即等待 metadata                                                                                            | 运行期间 `activeCommand="sleep"`；UI 显示 `(sleep)`；命令结束后恢复 `null`                                                                   |
| AC-SYS-004 | 普通命令切换               | 依次执行 `sleep 2`、`node -e "setTimeout(()=>{}, 3000)"`                                                                                     | metadata 顺序出现 `sleep -> null -> node -> null`；不得跳过 `null` 或保留旧命令                                                              |
| AC-SYS-005 | Ctrl-C 清空                | 执行 `sleep 30`，确认 `activeCommand="sleep"` 后发送 Ctrl-C                                                                                  | prompt 返回后 `activeCommand=null`；UI 括号消失；lowdb 不保留 `sleep` 作为当前值                                                             |
| AC-SYS-006 | node 命令                  | 执行 `node -e "setTimeout(()=>{}, 3000)"`                                                                                                    | 运行期间 API 为 `node`，UI 为 `(node)`；结束后为 `null`                                                                                      |
| AC-SYS-007 | npm 包装命令               | 在含 `package.json` 的项目目录执行 `npm run <long-running-script>`，脚本内部实际启动 node                                                    | 运行期间 `activeCommand="npm"`；tmux `pane_current_command` 即使为 `node`，也不得覆盖 API/WS/UI 的 `npm`                                     |
| AC-SYS-008 | pnpm 包装命令              | 执行 `pnpm <long-running-script>` 或 `pnpm exec node -e "setTimeout(()=>{}, 3000)"`                                                          | 运行期间 `activeCommand="pnpm"`；结束后为 `null`                                                                                             |
| AC-SYS-009 | yarn 包装命令              | 若本机安装 yarn，执行 `yarn <long-running-script>`                                                                                           | 运行期间 `activeCommand="yarn"`；未安装则 skipped                                                                                            |
| AC-SYS-010 | Codex CLI 前台             | 若本机安装 codex，执行 `codex`，等待 Codex 交互界面或 prompt                                                                                 | `activeCommand="codex"`；退出 Codex 后恢复 `null`；不要把 `activeCommand=codex` 当成 `agent_running`                                         |
| AC-SYS-011 | Traex CLI 前台             | 若本机安装 traex，执行 `traex`，等待交互界面或 prompt                                                                                        | `activeCommand="traex"`；退出后恢复 `null`；未安装则 skipped                                                                                 |
| AC-SYS-012 | Trae CLI 兼容名            | 若本机安装 `trae` 或 `traecli`，分别执行并退出                                                                                               | activeCommand 分别为 `trae` / `traecli`；退出后恢复 `null`                                                                                   |
| AC-SYS-013 | 绝对路径命令               | 执行 `/bin/sleep 5`                                                                                                                          | API 可为 `/bin/sleep` 或规范化后的 `sleep`，但 UI 必须显示 `(sleep)`；结束后为 `null`                                                        |
| AC-SYS-014 | 环境变量前缀               | 执行 `FOO=bar sleep 5`                                                                                                                       | 当前回归只记录 `activeCommand` 实际值，不阻塞；若实现 `displayCommand`，展示增强契约为 `sleep`                                               |
| AC-SYS-015 | `env` 包装器               | 执行 `env FOO=bar sleep 5`                                                                                                                   | 当前回归只记录 `activeCommand` 实际值，不阻塞；若实现 `displayCommand`，展示增强契约为 `sleep`                                               |
| AC-SYS-016 | shell keyword 包装         | 执行 `time sleep 5`                                                                                                                          | 当前回归只记录 `activeCommand` 实际值，不阻塞；若实现 `displayCommand`，展示增强契约为 `sleep`                                               |
| AC-SYS-017 | cd 只更新 cwd              | 执行 `cd /tmp`                                                                                                                               | cwd metadata 更新；`activeCommand` 最终仍为 `null`；UI 标题变为新 cwd basename                                                               |
| AC-SYS-018 | 快速命令不残留             | 连续执行 `pwd`、`echo ok`、`true`                                                                                                            | 可以因为命令太快没有稳定展示 active command，但 prompt 返回后必须为 `null`；不得残留 `pwd` / `echo` / `true`                                 |
| AC-SYS-019 | 页面刷新恢复               | 执行 `sleep 10`，确认 UI 显示 `(sleep)` 后刷新页面                                                                                           | 刷新后列表/API 仍显示 `sleep`；命令结束后再次刷新，显示恢复为无括号                                                                          |
| AC-SYS-020 | 后端持久化不过期           | 执行 `sleep 2` 等待结束，读取 `terminal-session-store.json` 或重启后端再读 API                                                               | session running 且 shell idle 时，持久化和 API 都是 `activeCommand=null`                                                                     |
| AC-SYS-021 | session 退出清空           | 创建非交互命令 terminal，例如 `sleep 2` 作为启动命令，等待进程退出                                                                           | session `status="exited"` 后，目标契约为 `activeCommand=null`；不得在列表长期显示 `(sleep)`                                                  |
| AC-SYS-022 | 多 session 隔离            | 同时打开 A、B 两个 terminal；A 执行 `sleep 5`，B 保持空闲                                                                                    | A 为 `sleep`，B 为 `null`；B 的 UI 标题不出现 `(sleep)`                                                                                      |
| AC-SYS-023 | 多 session 不同命令        | A 执行 `sleep 5`，B 执行 `node -e "setTimeout(()=>{}, 5000)"`                                                                                | A 为 `sleep`，B 为 `node`；两路 WS metadata 不串线                                                                                           |
| AC-SYS-024 | tmux pane 兜底             | 在 tmux-backed session 中临时禁用或绕过 shell marker，仅让 tmux 返回 `pane_current_command`                                                  | API/WS 能同步非 shell 命令；但 shell marker 存在时，`@runweave_command` 优先级高于 `pane_current_command`                                    |
| AC-SYS-025 | tmux option 清空           | 执行 `sleep 2`，命令结束后读取 tmux `@runweave_command`                                                                                      | tmux option 为空；API/WS/UI 均为 `null`                                                                                                      |
| AC-SYS-026 | list API 同步              | 执行 `sleep 5`，分别在运行中和结束后读取 `GET /api/terminal/session`                                                                         | 运行中目标 session 的 `activeCommand="sleep"`；结束后为 `null`；Web workspace 列表标题与 list payload 一致                                   |
| AC-SYS-027 | history payload 同步       | 执行 `sleep 5`，运行中打开 history drawer 或读取 `/history`；命令结束后再读取一次                                                            | history payload 和 drawer 标题运行中反映 `sleep`；结束后不保留过期 active command                                                            |
| AC-SYS-028 | App Home overview 最终一致 | 执行 `node -e "setTimeout(()=>{}, 5000)"`，先允许 Web tab 通过 WS 显示 `node`，再在等待窗口内轮询 `GET /api/app/home/overview` 和 detail API | 等待窗口内 overview/detail 收敛到 `activeCommand=node`；命令结束后在等待窗口内恢复空闲展示，不继续显示 `node`                                |
| AC-SYS-029 | stale Codex 状态清空       | 在同一 terminal 中进入 `codex`，确认产生 Codex `terminal_state_changed` 后退出到 shell，再执行 `node -e "setTimeout(()=>{}, 5000)"`          | `activeCommand` 变为 `node` 后，`/ws/terminal-events` 不应继续发布或保留 Codex `agent_idle/agent_running`；Web/App 消费状态应回到 shell idle |
| AC-SYS-030 | Codex 清空后 App 状态      | 在 App Home 或 App terminal detail 打开 Codex session，退出 Codex 或切到普通命令后等待全局事件/兜底刷新                                      | App Home 和 detail 不继续展示 Agent Idle/Running；Stop 不因 stale `activeCommand=codex` 保留                                                 |

## 展示增强契约

下面用例不是首批阻塞回归，只有在实现 `activeCommandLabel`、`displayCommand` 或等价 display helper 后才升级为必过项：

| ID          | 场景               | 输入                  | `activeCommand` 当前可接受值 | 增强展示期望 |
| ----------- | ------------------ | --------------------- | ---------------------------- | ------------ |
| AC-DISP-001 | 环境变量前缀       | `FOO=bar sleep 5`     | `FOO=bar`                    | `sleep`      |
| AC-DISP-002 | `env` 包装器       | `env FOO=bar sleep 5` | `env`                        | `sleep`      |
| AC-DISP-003 | shell keyword 包装 | `time sleep 5`        | `time`                       | `sleep`      |
| AC-DISP-004 | 绝对路径展示       | `/bin/sleep 5`        | `/bin/sleep`                 | `sleep`      |

这些用例不应改变 Codex/Traex/Completion gate 对 `activeCommand` 的机器匹配语义。若新增完整命令行字段，建议单独验证 `activeCommandLine`，不要用它替代 `activeCommand`。

## 验证落点

| 层级             | 入口                                                                | 覆盖重点                                                                                                                            |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Web E2E          | `frontend/tests/terminal.spec.ts`                                   | UI tab、workspace list、history drawer 与 API activeCommand 一致；输入命令、刷新、结束、Ctrl-C；必须通过 `$playwright-cli` 验收路径 |
| App 验收         | App dev/simulator + `$playwright-cli` 或手工回归                    | App Home / terminal detail 不被 stale activeCommand 或 stale terminal_state_changed 误导                                            |
| backend 静态检查 | `pnpm --filter ./backend typecheck && pnpm --filter ./backend lint` | activeCommand / terminal state 相关代码无 TS 或 lint 错误                                                                           |
| shared 静态检查  | `pnpm --filter ./packages/shared typecheck`                         | 协议类型变更可被跨端消费                                                                                                            |

本仓库不新增或维护 backend/shared/Electron/CLI 单测；UI 行为通过 E2E 或手工回归覆盖。

## 建议命令矩阵

首批阻塞命令：

```sh
sleep 5
node -e "setTimeout(()=>{}, 5000)"
npm run <long-running-script>
pnpm exec node -e "setTimeout(()=>{}, 5000)"
codex
traex
```

扩展命令：

```sh
/bin/sleep 5
FOO=bar sleep 5
env FOO=bar sleep 5
time sleep 5
yarn <long-running-script>
trae
traecli
vim
top
python3 -c "import time; time.sleep(5)"
```

`vim`、`top` 这类全屏 TUI 命令只要求 activeCommand 进入和退出正确，不要求根据内部状态变化改变 activeCommand。

## 失败判定

出现下面任一情况应判定失败：

- 命令正在运行且超过等待窗口后，API/WS/UI 关键观测点仍为 `null`。
- 命令已回到 shell prompt 且超过等待窗口后，API/WS/UI 关键观测点仍保留旧命令。
- `npm` / `pnpm` / `yarn` 场景被 tmux fallback 改写成内部 child process，例如 `node`。
- A session 的命令变化出现在 B session。
- 页面刷新或后端重启后恢复了已经结束的旧 `activeCommand`。
- session 已退出但列表继续显示旧 active command。
- 在未实现 display normalization 前，把 `FOO=bar`、`env`、`time` 这类 wrapper/env 前缀用例作为首批阻塞失败。
- detail API 已收敛后，list API、history API、App Home overview 或对应 UI 超过等待窗口仍显示旧 active command。
- `activeCommand` 已切到 `node`、`sleep` 或 `null`，且超过等待窗口后 `/ws/terminal-events` 仍让 Web/App 维持 Codex Agent Idle/Running。
- 超过等待窗口后，App Home 和 App terminal detail 对同一 session 的展示状态仍不一致。

## 测试报告模板

```md
# activeCommand 一致性测试报告

测试时间：
测试环境：
后端模式：pty / tmux
shell：zsh / bash
profile：临时 / 复用

| Case ID    | 命令    | Detail API    | List API      | History       | App Home        | WS metadata   | terminal-events | UI                                      | 等待窗口 | tmux 诊断                 | 结果 | 备注 |
| ---------- | ------- | ------------- | ------------- | ------------- | --------------- | ------------- | --------------- | --------------------------------------- | -------- | ------------------------- | ---- | ---- |
| AC-SYS-003 | sleep 5 | sleep -> null | sleep -> null | sleep -> null | Running -> Idle | sleep -> null | shell_idle only | browser-viewer(sleep) -> browser-viewer | 3s       | @runweave_command cleared | PASS |      |

失败结论：

后续修复建议：
```
