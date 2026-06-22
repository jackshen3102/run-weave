# Web 端快捷指令输入计划

日期：2026-06-21

草图：`docs/plans/assets/2026-06-21-web-terminal-quick-input-sketch.png`

## 目标

在 Web terminal workspace 中增加“快捷指令”入口，让用户能快速复用最近通过 Runweave 发送给终端的命令或提示语，并能把常用输入固定成模板。

第一版只覆盖 Web 端：

- 在现有 Web terminal 顶部 toolbar 增加一个紧凑入口。
- 打开后显示一个 popover，包含搜索、固定快捷指令、最近输入列表。
- 每条记录支持“直接发送到当前 active terminal”；不含 CR/LF 的 `line` 与 `codex_slash_command` 还支持“插入到当前输入上下文但不提交”，`prompt_paste` 第一版只支持发送和复制。
- 最近输入由后端在 `POST /api/terminal/session/:id/input` 成功后记录，Web 从 API 拉取。
- 固定快捷指令第一版使用后端持久化，避免只存在某个浏览器的 `localStorage` 中。

本计划是 Level 2 结构化实施计划。执行者需要按这里的边界、数据结构、文件路径和验收标准推进，但具体组件拆分、局部命名和样式细节可以贴合现有代码调整。

## 当前代码事实

- Web terminal 主壳层在 `frontend/src/components/terminal/terminal-workspace-shell.tsx`，顶部 toolbar 已有 `Git Submit`、`Preview`、`Orchestrator`、`History`、`More` 等紧凑按钮。快捷指令入口应放在这一排，不新建页面。
- Web 端现有 `Git Submit` popover 位于 `frontend/src/components/terminal/terminal-submit-popover.tsx`，它已经能生成 prompt 并通过 `sendTerminalInput(...)` 发给 active terminal。
- Web 端终端面输入主要从 xterm `onData` 进入 `frontend/src/components/terminal/use-terminal-emulator.ts`，最终走 websocket `sendInput(data)`；这类逐字符输入不适合作为第一版“最近提示语”记录来源。
- 后端 HTTP 输入入口是 `backend/src/routes/terminal.ts` 的 `POST /api/terminal/session/:id/input`，请求体类型是 `SendTerminalInputRequest`。
- 输入模式已在 `packages/shared/src/terminal-protocol.ts` 定义为 `raw | line | codex_slash_command | prompt_paste | tmux_exit_copy_mode`。
- 后端实际发送逻辑在 `backend/src/routes/terminal-input-dispatcher.ts`，其中 `prompt_paste` 已处理 bracketed paste 和 agent running 时的 Tab 提交。
- 后端持久化层已有 terminal project/session store：`backend/src/terminal/store.ts`、`backend/src/terminal/lowdb-store.ts`。新增输入历史/快捷指令应进入独立 store 或独立数据段，不塞进 session record。
- `packages/common` 只服务 Web/App 共同复用的浏览器端代码；本计划只做 Web，不新增 `@runweave/common` 导出。

## 需求理解

这是一个 Web 端输入效率功能，不是终端历史 drawer 的替代品。

“最近输入”指 Runweave 明确通过 HTTP input API 发送的完整输入意图，例如：

- Web Git Submit 生成并发送的 prompt。
- Browser annotation 以 `prompt_paste` 发送的 prompt。
- 后续 Web 快捷指令面板发送的命令或 prompt。

第一版不尝试从 xterm 逐字符输入中还原用户手敲命令，也不读取 shell 历史文件。

## 用户可见行为

### 入口

在 Web terminal 顶部 toolbar 中，靠近 `Git Submit` / `History` 的位置新增一个图标按钮：

- 图标建议使用 lucide `Zap`、`Command` 或 `ListRestart`，以现有 toolbar 图标大小为准。
- `aria-label` 和 `title` 使用 `快捷指令`。
- active terminal 不存在时，按钮仍可打开面板查看/管理快捷指令，但“发送”动作禁用。

### Popover

点击入口打开 `快捷指令` popover：

- 宽度约 `400px-440px`，沿用 `TerminalSubmitPopover` 的深色 popover 风格。
- 顶部包含标题 `快捷指令` 和搜索输入，placeholder 为 `搜索最近输入或模板`。
- 使用 segmented tabs：`固定`、`最近`、`全部`。
- 列表行保持紧凑，每行展示：
  - 标题或内容摘要；
  - mode chip：`line`、`prompt_paste`、`codex_slash_command`；
  - 来源/时间：例如 `2分钟前 · current project`；
  - 固定/取消固定按钮；
  - 插入按钮（仅不含 CR/LF 的 `line` 与 `codex_slash_command` 可用）；
  - 复制按钮（至少对 `prompt_paste` 可用）；
  - 发送按钮。
- 底部提供 `保存当前输入为快捷指令` 的入口。第一版如果 Web terminal 当前没有独立 composer，可先只支持“从最近输入固定”，不实现读取 xterm 当前编辑行。

### 插入与发送

- `发送`：调用现有 `sendTerminalInput(apiBase, token, activeSessionId, { data, mode })`，复用后端 input dispatch。
- `插入`：
  - 对不含 CR/LF 的 `line` 和 `codex_slash_command`：调用 `sendTerminalInput(...)`，但请求体使用 `{ data, mode: "raw" }`，只把文本写入 active terminal，不自动追加 Enter，不触发命令执行。
  - 如果 `line` 或 `codex_slash_command` 的 `data` 包含 `\r` 或 `\n`，插入按钮禁用，只保留发送和复制，避免 raw 写入换行导致命令执行。
  - 对 `prompt_paste`：插入按钮禁用，只保留发送和复制，避免把大段 prompt 逐字符塞入 shell composer 产生不可控行为。
- `复制`：复制原始 `data` 到剪贴板；至少 `prompt_paste` 必须提供复制动作。

## API 与数据结构

新增共享类型放在 `packages/shared/src/terminal-protocol.ts`。

建议类型。持久化模型使用单表 item：`pinned` 是是否固定，`hiddenAt` 是用户删除/隐藏后的软隐藏状态；不在 item 上持久化 `kind` 字段，`kind` 只作为列表查询过滤条件。

```ts
export type TerminalQuickInputListKind = "recent" | "pinned" | "all";
export type TerminalQuickInputMode =
  | "line"
  | "codex_slash_command"
  | "prompt_paste";

export interface TerminalQuickInputItem {
  id: string;
  title: string;
  data: string;
  mode: TerminalQuickInputMode;
  projectId?: string | null;
  terminalSessionId?: string | null;
  cwd?: string | null;
  source:
    | "web_terminal_quick_input"
    | "web_git_submit"
    | "web_browser_annotation"
    | "api_terminal_input";
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  hiddenAt?: string | null;
  useCount: number;
}

export interface ListTerminalQuickInputsResponse {
  items: TerminalQuickInputItem[];
}

export interface CreateTerminalQuickInputRequest {
  title: string;
  data: string;
  mode: TerminalQuickInputMode;
  projectId?: string | null;
  terminalSessionId?: string | null;
  cwd?: string | null;
}

export interface UpdateTerminalQuickInputRequest {
  title?: string;
  pinned?: boolean;
}
```

模型规则：

- `POST /api/terminal/quick-inputs` 创建固定快捷指令，默认 `pinned: true`。如果已存在同 `data + mode + projectId` 的 item，则更新该 item 的 `title`、`pinned: true`、`hiddenAt: null`，不新增重复行。
- `POST /api/terminal/quick-inputs` 的 zod schema 必须只接受 `TerminalQuickInputMode` 子集：`line`、`codex_slash_command`、`prompt_paste`；必须拒绝 `raw` 和 `tmux_exit_copy_mode`。
- `createPinned(...)` 与 `recordRecentInput(...)` 共用同一套持久化过滤规则：拒绝空文本、超过 64 KiB 的文本、明显敏感内容，以及非 `TerminalQuickInputMode` 的 mode。
- `recordRecentInput(...)` 也按 `data + mode + projectId` 去重。命中已有 item 时只更新 `lastUsedAt/useCount/terminalSessionId/cwd/updatedAt` 并清除 `hiddenAt`；已有 `pinned: true` 必须保留，不降级为未固定。
- 列表 `kind=recent` 返回 `hiddenAt == null && pinned == false` 的 item；`kind=pinned` 返回 `hiddenAt == null && pinned == true` 的 item；`kind=all` 返回 `hiddenAt == null` 的 item。
- `PATCH pinned: false` 只取消固定，不隐藏 item；取消后该 item 出现在最近列表中。
- `DELETE` 对任意 item 都执行软隐藏：设置 `hiddenAt`，并把 `pinned` 置为 `false`。同一 `data + mode + projectId` 后续再次发送时，`recordRecentInput(...)` 清除 `hiddenAt`，该 item 重新出现在最近列表中。
- retention 只裁剪 `hiddenAt == null && pinned == false` 的最近输入，最多保留 200 条；裁剪不得删除 `pinned: true` 的 item。

API 路径建议挂在 terminal router 下：

- `GET /api/terminal/quick-inputs?projectId=<id>&q=<query>&kind=recent|pinned|all&limit=50`
- `POST /api/terminal/quick-inputs`：保存固定快捷指令。
- `PATCH /api/terminal/quick-inputs/:id`：改标题、固定/取消固定。
- `DELETE /api/terminal/quick-inputs/:id`：按上面的软隐藏规则隐藏该 item。
- `POST /api/terminal/quick-inputs/:id/used`：仅用于“插入”或“复制”这类不会产生可记录 recent 的动作成功后更新 `lastUsedAt/useCount`；快捷指令“发送”不得再调用 `/used`，避免和 input 成功记录路径重复计数。

权限：复用现有 terminal routes 的认证中间件；不新增匿名访问。

## 记录规则

后端在 `POST /api/terminal/session/:id/input` 成功并返回 `inputAccepted: true` 后记录 recent。

记录条件：

- 只记录 `mode` 为 `line`、`codex_slash_command`、`prompt_paste` 的输入。
- 不记录 `raw`，避免保存 xterm 逐字符输入、方向键、tmux 滚动、控制序列。
- 不记录 `tmux_exit_copy_mode`。
- `data.trim()` 为空不记录。
- `data` 超过 64 KiB 不记录完整内容；第一版可直接不记录超长输入，并在诊断日志中记录 skipped reason。
- 按 `data + mode + projectId` 去重：重复输入更新 `lastUsedAt/useCount`，不新增重复行；如果命中被隐藏 item，则清除 `hiddenAt` 使其重新进入最近列表。
- 最近输入最多保留 200 条；超过后删除最旧且未 pinned 的记录。

敏感内容处理：

- 不自动记录 `raw` 是第一层保护。
- 对所有会持久化的输入模式（`line`、`codex_slash_command`、`prompt_paste`），若命中明显敏感模式则跳过：包含 `password=`, `token=`, `api_key=`, `secret=`, `Authorization:`。
- 不做复杂语义识别，不把“可能敏感”内容上传到外部服务。

来源标注：

- `TerminalSubmitPopover` 发送时传递 `source: "web_git_submit"`。如果第一版不扩展 `SendTerminalInputRequest`，后端默认记为 `api_terminal_input`，Web 列表仍可用。
- Browser annotation 发送可标为 `web_browser_annotation`。
- 快捷指令 popover 自己发送标为 `web_terminal_quick_input`。

如果要扩展 `SendTerminalInputRequest` 增加 `quickInputSource?: ...`，必须同步更新后端 zod schema，并保持字段可选，避免旧客户端破坏兼容。

## 文件范围

### 共享协议

- `packages/shared/src/terminal-protocol.ts`
  - 新增 quick input 类型、request/response 类型。
  - 如果扩展 `SendTerminalInputRequest`，只加可选字段。

### 后端

- `backend/src/terminal/quick-input-store.ts`
  - 定义 store interface 和基础内存/文件 store 需要的参数类型。
- `backend/src/terminal/quick-input-lowdb-store.ts`
  - 使用 lowdb 或现有 JSON 文件模式持久化 quick inputs。
  - 建议独立文件，例如 runtime data 目录下 `terminal-quick-inputs.json`。
- `backend/src/terminal/quick-input-service.ts`
  - 负责去重、过滤、敏感模式跳过、limit 裁剪、useCount 更新。
- `backend/src/routes/terminal-quick-input-routes.ts`
  - 注册 quick input CRUD/list routes。
- `backend/src/routes/terminal.ts`
  - 注入 quick input service。
  - 在 input 成功后调用 `recordRecentInput(...)`。
  - 注册 quick input routes。
- `backend/src/index.ts`
  - 创建并注入 quick input store/service，跟随现有 terminal service 初始化/释放流程。

### Web 服务层

- `frontend/src/services/terminal.ts`
  - 新增 `listTerminalQuickInputs`、`createTerminalQuickInput`、`updateTerminalQuickInput`、`deleteTerminalQuickInput`、`markTerminalQuickInputUsed`。
  - 保持 `sendTerminalInput` 现有调用兼容。

### Web UI

- `frontend/src/components/terminal/terminal-quick-input-popover.tsx`
  - 新增 popover 主组件。
  - 管理搜索、tab、loading、error、发送/插入/固定动作。
- `frontend/src/components/terminal/terminal-quick-input-list.tsx`
  - 可选拆分：列表行、空态、mode chip。
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
  - 在顶部 toolbar 加入口。
  - 向 popover 传入 `apiBase`、`token`、`activeProject`、`activeSession`。
- `frontend/src/components/terminal/terminal-submit-popover.tsx`
  - 发送 Git Submit prompt 时，优先改为 `mode: "prompt_paste"`，不要继续把多行 prompt 压成一行。
  - 如果扩展 `quickInputSource`，这里传 `web_git_submit`。

Web 实现约束：

- 不从 `react` 导入 `useCallback`，也不写 `React.useCallback`。
- 需要稳定函数引用时使用 `ahooks` 的 `useMemoizedFn`，贴合现有 terminal workspace 写法。
- 不新增 `frontend/src` 下的 Vitest 或组件单测；浏览器验收只用 Playwright E2E 或 `$playwright-cli` 手工验证。

## 实施步骤

### 1. 定义协议与后端服务

- 在 shared 中新增 quick input 类型。
- 新增后端 quick input store/service。
- 服务层实现：
  - `list({ projectId, q, kind, limit })`
  - `createPinned(input)`
  - `update(id, patch)`
  - `delete(id)`
  - `recordRecentInput(context)`
  - `markUsed(id)`
- 输入过滤、去重、软隐藏恢复、retention 裁剪和敏感模式跳过逻辑必须集中在 service，不分散到 route 中。
- 定义 `TerminalQuickInputMode` 为 `line | codex_slash_command | prompt_paste`，所有 quick input item、create request、后端 zod schema 和 store 记录都使用该子集，不允许把 `raw` 或 `tmux_exit_copy_mode` 持久化。

验收：

- TypeScript 能编译。
- `recordRecentInput` 不记录 `raw`、空文本、控制输入、超长输入。
- `createPinned` 对 `raw`、`tmux_exit_copy_mode`、空文本、超长文本和明显敏感内容返回 400，不产生持久化记录。
- 相同 `data/mode/projectId` 重复发送只更新原记录。
- 被 `DELETE` 软隐藏的 item 在同一 `data/mode/projectId` 再次发送后会清除 `hiddenAt` 并重新出现在最近列表。

### 2. 接入 terminal input 成功路径

- 修改 `POST /api/terminal/session/:id/input`。
- `sendInputToSession(...)` 成功后再记录，失败不记录。
- 记录上下文包含 `projectId`、`terminalSessionId`、`cwd`、`mode`、`data`、`acceptedAt`。
- 记录失败不能影响终端输入发送结果；只打 warning log。

验收：

- 发送输入成功，即使 quick input 记录失败，API 仍返回原本的 `SendTerminalInputResponse`。
- 发送失败时不会产生 recent。

### 3. 增加 quick input API

- 在 terminal router 中注册 `GET/POST/PATCH/DELETE/used` routes。
- query/body 用 zod 校验。
- `POST /api/terminal/quick-inputs` 的 body schema 使用 `TerminalQuickInputMode` 子集，并复用 service 层过滤；不允许 fixed template API 绕过 recent 记录过滤。
- `kind` 默认 `all`，`limit` 默认 50，最大 100。
- `q` 搜索匹配 `title` 和 `data`，大小写不敏感。
- `DELETE` 只做软隐藏，不物理删除；后续同内容发送会恢复为 recent。

验收：

- 未登录请求仍按现有 auth 策略拒绝。
- `GET` 能按 kind/project/query 返回稳定排序：pinned 在固定 tab 按 `updatedAt desc`，recent 按 `lastUsedAt/createdAt desc`。
- `POST /api/terminal/quick-inputs/:id/used` 只在插入/复制成功后调用；发送快捷指令只依赖 `POST /api/terminal/session/:id/input` 成功路径更新 `lastUsedAt/useCount`。

### 4. Web 服务层封装

- 在 `frontend/src/services/terminal.ts` 增加 quick input API 方法。
- 所有新方法都使用现有 `requestJson/requestVoid` 和 Authorization header 风格。
- 不把 API 调用直接写进组件内部的 `fetch`。

验收：

- typecheck 能发现 request/response 类型不匹配。

### 5. Web popover UI

- 新建 `TerminalQuickInputPopover`。
- 复用现有 `Popover`、`Button`、`Input` 等组件风格。
- 入口按钮放到 Web toolbar，移动 monitor 模式不显示。
- popover 打开时加载 quick inputs；搜索输入 debounce 200-300ms。
- 每条 item：
  - 显示 `title || data preview`；
  - `data` preview 最多两行，长文本 truncate；
  - mode chip 小而低对比；
  - action icon 包括 pin、copy、send；`line` 与 `codex_slash_command` 且 `data` 不含 CR/LF 时额外显示 enabled insert，`prompt_paste` 或包含 CR/LF 的 item 的 insert disabled。
- 发送成功后刷新列表或按 input 成功记录结果更新本地状态，不调用 `markTerminalQuickInputUsed(id)`。
- 插入或复制成功后调用 `markTerminalQuickInputUsed(id)`，并刷新列表或本地更新 `lastUsedAt/useCount`。

验收：

- 没有 active terminal 时，发送/插入按钮禁用，列表仍可浏览。
- loading/error/empty 状态完整。
- 长 prompt 不撑破 popover。
- popover 不遮挡 terminal tab row 的基础操作。
- 快捷指令发送一次只让 `useCount` 增加一次，不发生 input 记录和 `/used` 双重计数。
- 含 `\r` 或 `\n` 的 item 不允许 raw 插入，只能发送或复制。

### 6. 插入动作第一版边界

第一版必须实现受限插入：

- `line`：仅当 `data` 不含 `\r` 和 `\n` 时，插入才可用；插入时调用 `sendTerminalInput(...)`，请求体使用 `{ data, mode: "raw" }` 写入 active terminal，不附加 Enter。
- `codex_slash_command`：仅当 `data` 不含 `\r` 和 `\n` 时，插入才可用；插入时同样使用 `{ data, mode: "raw" }` 写入原始 slash command，不提交。
- 多行 `line` 或 `codex_slash_command` 禁用插入，tooltip 说明 `包含换行的输入请直接发送或复制`。
- `prompt_paste`：插入按钮禁用，tooltip 说明 `长提示语请直接发送或复制`。
- raw 插入成功后调用 `/api/terminal/quick-inputs/:id/used`；因为 `raw` 不会被 recent 记录，所以这里不会产生双重计数。

验收：

- 插入动作不会触发命令执行。
- `line` 和 `codex_slash_command` 插入后，文本出现在 active terminal 输入上下文中，但不会自动提交。
- 包含 CR/LF 的 `line` 或 `codex_slash_command` 不会被 raw 插入。
- `prompt_paste` 不会被错误地逐字符塞入 shell。

### 7. Git Submit 发送模式修正

当前 Git Submit 会用 `buildTerminalSubmitInput(prompt)` 把多行 prompt 压成一行再发送。快捷指令体系落地时，应顺手修正为：

- 发送 `data: prompt`
- 使用 `mode: "prompt_paste"`
- source 标为 `web_git_submit`，如果协议已支持 source 字段。

验收：

- Git Submit 仍能发送到 active terminal。
- 发送后的 prompt 出现在最近输入列表中。
- prompt 保留原始多行结构，列表 preview 正常截断。

## 非目标

- 不覆盖 App 端 composer 和 `TerminalShortcutBar`。
- 不改 CLI `rw terminal send`。
- 不从 shell preexec 捕获完整原始命令。
- 不读取用户 shell history 文件。
- 不尝试从 xterm `raw` 字符流还原命令。
- 不新增 `packages/common` 导出。
- 不新增 Vitest、Node test、coverage 或非 E2E 测试文件。
- 不重新设计 terminal history drawer。

## 测试与验证

### 静态验证

```bash
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm typecheck
```

如修改 lint 覆盖范围内代码：

```bash
pnpm lint
```

### 后端验证

本仓库当前约束是不新增单元测试、Vitest、Node test 或 coverage 门槛；本计划不要求新增或更新后端单测。后端信心来源以 typecheck、lint、构建和手工/脚本化 API 冒烟为主。

最低手工/脚本化冒烟：

1. 启动 `pnpm dev`。
2. 创建或选择一个 running terminal。
3. 调用 `POST /api/terminal/session/:id/input` 发送 `{ data: "pnpm typecheck", mode: "line" }`。
4. 调用 `GET /api/terminal/quick-inputs?kind=recent`，确认返回包含 `pnpm typecheck`。
5. 发送 `{ data: "\\u001b[A" }` 或 raw 控制输入，确认不产生 recent。
6. 重复发送同一条 `line`，确认没有重复行，`useCount/lastUsedAt` 更新。

### 浏览器验收

浏览器操作必须使用 `$playwright-cli`。

1. 启动 `pnpm dev`。
2. 打开 Web terminal workspace。
3. 点击顶部 `快捷指令` 图标，确认 popover 打开。
4. 发送一条 `line` 输入后重新打开 popover，确认出现在 `最近`。
5. 把该 recent 固定，确认出现在 `固定`。
6. 搜索关键字，确认列表过滤。
7. 点击发送，确认 active terminal 收到输入，且该 item 的 `useCount` 只增加一次。
8. 对不含 CR/LF 的 `line` 或 `codex_slash_command` 点击插入，确认文本写入 active terminal 但没有自动执行。
9. 对 `prompt_paste` 确认插入 disabled，复制可用。
10. 没有 active terminal 时，确认发送/插入按钮 disabled，但列表可浏览。
11. 删除一条 recent 后确认列表隐藏；再次发送同内容后确认它重新出现在最近列表。
12. 用 Git Submit 发送一次，确认最近输入中出现对应 prompt。

## 风险与处理

- 风险：记录敏感信息。
  - 处理：第一版不记录 `raw`，并对所有会持久化的 mode 跳过明显敏感模式；后续如要更强保护，再增加用户级关闭开关或 per-project ignore。
- 风险：把逐字符 terminal 输入误当成命令历史。
  - 处理：只记录 HTTP input 中有明确 mode 的完整输入，不从 xterm raw 流还原。
- 风险：新增 store 影响 terminal session 持久化稳定性。
  - 处理：quick input 使用独立 store 文件，不修改 session record schema。
- 风险：popover 状态和 active session 切换不同步。
  - 处理：发送前读取当前 `activeSession`，没有 session 时禁用发送；发送错误显示在 popover 内。
- 风险：`prompt_paste` 插入语义不清。
  - 处理：第一版对长 prompt 禁用插入或只支持复制，发送继续走后端 `prompt_paste`。

## 完成标准

- Web toolbar 有 `快捷指令` 入口，desktop 模式可用，mobile monitor 模式不显示。
- 后端能持久化并查询最近输入和固定快捷指令。
- `POST /api/terminal/session/:id/input` 成功后按规则记录 recent，失败或 raw/control 输入不记录。
- Popover 支持 `固定`、`最近`、`全部`、搜索、固定/取消固定、删除/隐藏、复制、发送。
- 不含 CR/LF 的 `line` 与 `codex_slash_command` 支持 raw 插入且不自动提交；包含 CR/LF 的 item 与 `prompt_paste` 插入禁用，只支持发送/复制。
- 快捷指令发送只通过 input 成功路径更新使用统计；插入/复制才调用 `/used`，不存在双重计数。
- Git Submit 使用 `prompt_paste` 发送，并进入最近输入列表。
- 长文本、无 active terminal、API error、空列表都有明确 UI 状态。
- `pnpm typecheck` 通过。
- Web 浏览器验收已通过 `$playwright-cli` 执行并记录结果。
