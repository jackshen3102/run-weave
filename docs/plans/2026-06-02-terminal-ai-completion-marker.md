# 终端 AI 任务完成绿点系统方案

## 目标

把终端 tab 右侧的小绿点定义成一个明确产品语义：

> 非当前 terminal 中，Claude Code / Codex / Trae / Coco 等 AI CLI 的一次任务已经完成，可以回去接管。

小绿点不表示普通 shell 命令结束，不表示有新输出，也不表示 terminal 进程退出。`sleep`、`pnpm build`、`git status` 等普通命令结束不应该点亮绿点。

## 当前问题

当前代码里有两类信号会点亮 `completionMarkers`：

- 显式完成事件：`/internal/terminal-completion` 写入 `TerminalCompletionEventStore`，前端轮询 `/api/terminal/completion-events` 后点亮非当前 terminal。
- 命令状态推断：`frontend/src/components/terminal/terminal-workspace.tsx` 在 `activeCommand` 从有值变成 `null` 时，也会给非当前 terminal 点亮绿点。

第一类符合目标。第二类是根因风险：它把“任何命令结束”误当成“AI 任务完成”，会让普通命令制造噪声。

## 根本方案：Completion Hook 命令总线

### 1. 统一完成信号为显式 Hook 命令

系统内只允许一种业务信号点亮绿点：某个明确的 completion hook 命令被执行，并成功写入 `TerminalCompletionEvent`。

也就是说，Runweave 不从终端输出、普通命令退出、tab 是否有 activity 里猜“任务完成”。谁知道 AI 任务完成，谁就调用统一 hook 命令：

```bash
~/.browser-viewer/bin/browser-viewer-hook-bridge --source codex --reason hook_stop
```

hook 命令负责从当前 tmux pane 环境中读取：

- `RUNWEAVE_TERMINAL_SESSION_ID`
- `RUNWEAVE_PROJECT_ID`
- `RUNWEAVE_HOOK_ENDPOINT`
- `RUNWEAVE_HOOK_TOKEN`

然后写入 backend。前端只消费 backend 的 completion events。

不再由前端根据 `activeCommand -> null` 直接设置绿点。前端只消费后端提供的 completion events。

### 2. Hook 命令接入三类来源

#### A. AI CLI 官方 hook

Claude Code / Codex / Trae / Coco 如果支持 stop、task complete、notify 等 hook，就在这些 hook 里执行 `browser-viewer-hook-bridge`。

```text
AI CLI task finishes
  -> CLI hook / notify runs browser-viewer-hook-bridge
    -> bridge reads RUNWEAVE_TERMINAL_SESSION_ID and hook token
      -> POST /internal/terminal-completion
        -> TerminalCompletionEventStore
          -> frontend polls /api/terminal/completion-events
            -> inactive matching terminal shows green dot
```

这条路径适合 Claude Code / Codex 这类长期交互式进程，因为它们的一次任务完成时进程通常不会退出。系统不能只依赖 shell command exit。

#### B. Notify 脚本

如果某个 AI CLI 的“任务完成”只稳定出现在 notify 脚本里，例如 Codex 的 turn-ended notify，则 notify 脚本在发系统通知后再调用同一个 hook 命令。

```text
AI CLI notify
  -> user notify script
    -> macOS / Feishu notification
    -> browser-viewer-hook-bridge --source codex --reason notify
```

这仍然是同一个 completion event，不另开一套协议。

#### C. 可选 wrapper / shell integration 兜底

为了覆盖“用户直接运行一次性 `codex ...` 或 `claude ...` 后进程退出”的场景，可以提供可选 wrapper。wrapper 只包 AI CLI，不包普通 shell 命令：

```bash
runweave-ai codex ...
runweave-ai claude ...
```

wrapper 执行 AI CLI，等进程退出后调用：

```bash
browser-viewer-hook-bridge --source codex --reason ai_process_exit
```

这个兜底不能替代官方 hook。长期交互式 AI CLI 的一次任务完成通常不会退出进程，所以真正可靠的主路径仍然是官方 hook / notify。

### 3. 后端只接受 AI completion event，不接受普通命令推断

为了避免普通命令制造噪声，后端和前端都不应该把“命令结束”直接当完成。

如果实现 wrapper 或后端兜底，必须先通过 AI 命令白名单判断。

建议白名单先收敛到明确 AI CLI：

- `codex`
- `claude`
- `claude-code`
- `coco`
- `trae`

判断位置放在 hook bridge 或后端写入层，而不是前端 UI 层。原因是完成事件应该在进入系统时被归一化，前端只负责展示“这个 terminal 有 completion event”。

### 4. 明确事件字段分层

`TerminalCompletionEvent` 需要区分“规范化业务语义”和“上游原始事件”。小绿点逻辑只依赖规范化字段，不依赖上游 hook 的原始字符串。

```ts
completionReason: "hook_stop" | "notify" | "ai_process_exit" | "manual";
commandName: string | null;
rawHookEvent: string | null;
```

字段语义：

- `completionReason` 是唯一标准化完成原因，用于产品逻辑、诊断展示和后续统计。
- `source` 继续表示来源产品：`claude`、`codex`、`trae`、`unknown`。
- `commandName` 表示触发 completion 的命令名，无法确定时为 `null`。
- `rawHookEvent` 只保存上游原始 hook 事件名，例如 `Stop`、`SubagentStop`，用于排障，不参与绿点判断。

现有 `hookEvent: string` 与 `completionReason` 语义重叠，不能继续作为业务字段。实施时采用迁移策略：

- 内部新模型使用 `rawHookEvent: string | null`。
- `/internal/terminal-completion` 可继续接受旧请求里的 `hookEvent`，但写入时映射到 `rawHookEvent`。
- `/api/terminal/completion-events` 如果需要短期兼容旧前端，可以临时返回 deprecated `hookEvent`，其值来自 `rawHookEvent ?? completionReason`。
- 新代码不得根据 `hookEvent` 判断是否点亮绿点；只允许根据 event 是否存在，以及 `completionReason` 做诊断展示。
- 兼容窗口结束后删除 `hookEvent` 字段。

这可以区分：

- Codex hook 明确上报完成。
- Codex notify 脚本间接上报完成。
- `codex` wrapper 进程结束后，Runweave 兜底生成完成事件。
- 人工或诊断命令手动写入完成事件。

### 5. 增加诊断面板或调试接口

用户反馈“AI 完成了但没亮”时，现在排查链路太隐式。需要一个低成本诊断入口，至少能看到：

- 当前 terminal 是否是 tmux-backed。
- 当前 pane 是否有 `RUNWEAVE_TERMINAL_SESSION_ID`、`RUNWEAVE_HOOK_ENDPOINT`。
- 当前 backend 是否配置了 `RUNWEAVE_HOOK_TOKEN`。
- 最近一条 completion event 的 source、reason、terminalSessionId、createdAt。
- Codex / Claude hook bridge 是否已安装到用户配置。

这不改变绿点逻辑，但能把问题从“感觉没亮”变成可定位的断点。

## 文件范围

- `packages/shared/src/terminal-protocol.ts`
  - 扩展 `TerminalCompletionEvent` 类型。
  - 将 `hookEvent` 标记为 deprecated 兼容字段，新增 `rawHookEvent` 和 `completionReason`。

- `backend/src/terminal/completion-events.ts`
  - 支持记录 `completionReason`、`commandName` 和 `rawHookEvent`。
  - 不再把 `hookEvent` 作为内部核心字段。

- `backend/src/routes/terminal-completion.ts`
  - 接收 hook / notify 写入时填充 `completionReason`。
  - 兼容旧请求的 `hookEvent` 字段，并映射为 `rawHookEvent`。

- `electron/src/hooks/hook-installer.ts`
  - 让 launcher 支持 `--reason`、`--command-name`。
  - 安装 Claude / Codex / Trae hook 时传入明确 reason。

- `packages/runweave-cli/src/commands/terminal.ts`
  - 可选增加诊断或手动 completion 命令，用于验证某个 terminal 的绿点链路。

- `backend/src/ws/terminal-server.ts`
  - 不再承担前端绿点语义判断。
  - 如保留 activeCommand metadata，只用于 tab 命名和状态展示。

- `backend/src/terminal/shell-integration.ts`
  - 继续负责发出 active command metadata，不直接决定绿点。
  - 可选提供 AI wrapper 所需的环境上下文，但不包普通命令。

- `frontend/src/components/terminal/terminal-workspace.tsx`
  - 删除 `activeCommand -> null` 直接设置 `completionMarkers` 的逻辑。
  - 继续通过 `/api/terminal/completion-events` 点亮绿点。

- `docs/architecture/terminal-completion-hooks.md`
  - 更新文档，说明绿点只来自 AI completion event，普通命令结束不触发。

## 非目标

- 不解析 Claude / Codex 的终端输出文本来判断完成。
- 不让所有命令结束都点亮绿点。
- 不把当前 active terminal 的完成事件点亮成绿点。
- 不要求前端为 `src/*.ts` 或 React hooks 新增 Vitest 单测。
- 不改变黄色 bell marker 的含义和优先级。

## 实施步骤

1. 定义 AI completion event 合约
   - 扩展 shared 类型。
   - 后端 record API 接收 `completionReason`、`commandName`、`rawHookEvent`。
   - 明确 `hookEvent` 只作为 deprecated 兼容字段，不再用于业务判断。
   - 验证：backend typecheck 通过。

2. 把 hook bridge 明确设计成 completion hook 命令
   - 支持 `--source`、`--reason`、`--command-name`。
   - 从 `RUNWEAVE_*` 环境读取 terminal 身份和内部写入 token。
   - 非 stop / completion 类事件直接忽略。
   - 验证：在带 `RUNWEAVE_*` 的环境中手动执行 hook 命令，backend 记录 completion event。

3. 安装 AI CLI hook / notify
   - Codex / Claude / Trae 配置中写入统一 hook bridge 命令。
   - 如果使用 notify 路径，notify 脚本执行完原通知后调用 hook bridge。
   - 验证：模拟 stop payload 能写入 `hook_stop` 或 `notify` event。

4. 前端只消费 completion event
   - 删除前端 `handleSessionMetadata` 里直接设置 `completionMarkers` 的分支。
   - 保留 polling、非当前 tab 点亮、切 tab 清除、session 删除清理。
   - 验证：Playwright E2E 里普通 `sleep` 结束后不出现绿点。

5. 可选增加 AI wrapper 兜底
   - 提供 `runweave-ai <command> ...` 或等价脚本。
   - 只允许白名单 AI CLI。
   - AI 进程退出后调用 hook bridge，reason 为 `ai_process_exit`。
   - 验证：`runweave-ai codex --version` 这类一次性命令可以生成 completion event；`runweave-ai sleep 1` 被拒绝或不生成 event。

6. 文档和诊断
   - 更新架构文档和排障顺序。
   - 可选新增诊断接口或 UI，显示当前 terminal 的 hook 健康状态。
   - 验证：按文档能定位 hook 未安装、旧 pane 缺 env、当前 active tab 不亮这三类问题。

## 验收标准

- 非当前 tab 中的 Codex / Claude / Trae / Coco completion event 会点亮绿点。
- 当前正在看的 tab 收到 completion event 不点亮绿点。
- 切回有绿点的 tab 后，绿点消失。
- 普通命令结束不会点亮绿点。
- 手动执行统一 hook 命令可以点亮目标 terminal，用于验证链路。
- 后端重启或旧 pane 缺少 hook env 时，不伪造完成事件，诊断信息能指出断点。
- `TerminalCompletionEvent` 中能看出事件来源和原因。

## 验证命令

遵守本仓库前端测试约束，不新增前端 Vitest 单测。

```bash
pnpm typecheck
pnpm lint
pnpm --filter ./backend test -- terminal-completion terminal-server
pnpm --filter ./frontend exec playwright test tests/terminal.spec.ts --grep "completion"
```

如果 E2E 中需要真实 tmux 行为，使用现有 Playwright 配置启动后端，不复用开发机上的长期 tmux socket。

## 风险与取舍

- hook / notify 是最准确的完成信号，但依赖用户配置和 AI CLI 实际触发 hook。
- AI command exit 只能作为 wrapper 兜底，因为长期交互式 AI CLI 的任务完成不等于进程退出。
- 白名单过宽会重新引入噪声；白名单过窄会漏掉新的 AI CLI。新增命令必须显式加入。
- event store 仍是内存态，backend 重启后不保留历史绿点；这是可接受的，因为绿点是实时提醒，不是审计记录。
