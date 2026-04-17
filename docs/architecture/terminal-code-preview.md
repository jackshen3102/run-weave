# Terminal 代码预览设计

说明 Runweave Terminal 中轻量代码预览能力的产品边界、交互形态和后端协议建议。

## 背景

Terminal 现在是 Runweave 里和 AI 协作最密集的页面。用户会在终端里让 AI 生成计划、修改代码、运行测试，然后在提交前快速确认结果。

但这里需要的不是完整 IDE：

- 偶尔通过明确路径查看 AI 生成或人工维护的方案文档
- 一边看计划一边继续和 AI 对话
- 提交前快速扫一眼 staged changes 和 working changes
- 不希望展示项目文件树
- 不希望把 Terminal 变成嵌入式 VS Code

因此预览能力应定位为 Terminal 的临时辅助上下文，而不是代码工作区。

## 当前代码事实

相关代码边界：

- `frontend/src/pages/terminal-page.tsx`：Terminal 路由入口，负责把路由参数传给工作台。
- `frontend/src/components/terminal/terminal-workspace.tsx`：Terminal 工作台，负责项目、会话、顶部栏、活动 session 容器、历史抽屉。
- `frontend/src/components/terminal/terminal-surface.tsx`：xterm 渲染与输入连接，不应承载代码预览业务。
- `frontend/src/services/terminal.ts`：Terminal HTTP API client，目前没有文件读取或 git diff 能力。
- `backend/src/routes/terminal.ts`：Terminal HTTP API，目前提供 project、session、history、ws-ticket、clipboard-image。
- `packages/shared/src/terminal-protocol.ts`：Terminal 共享协议，目前没有 preview 相关类型。
- 当前 `frontend/package.json` 没有 `monaco-editor`、`@monaco-editor/react` 或 `zustand` 依赖。
- 当前 Terminal Project 只有名称、创建时间和默认项目标记，没有项目路径字段。
- 当前 Terminal Session 有 `cwd`，并且后端会通过 shell integration 尝试追踪实时 cwd；但该 cwd 依赖 shell marker 和 PTY 生命周期，不适合作为 Preview 的文件根目录。

设计结论：

- 预览面板应挂在 `TerminalWorkspace` 的内容区布局中。
- `TerminalSurface` 继续只关心 xterm 连接、渲染、搜索、设置、粘贴等终端能力。
- Terminal Project 需要新增项目路径字段，Preview 的文件搜索、文件读取和 git changes 都基于该项目路径。
- 后端需要新增挂在 terminal session 下的只读 preview API；session 只用于定位 project，Preview root 使用 project path。

## 目标

1. 在 Terminal 右侧临时预览代码、Markdown 或 diff。
2. 默认关闭，不影响终端主体验。
3. 不展示项目级文件树。
4. 不提供编辑能力。
5. 使用 `@monaco-editor/react` 承载 Monaco Editor 和 Diff Editor，只使用只读预览能力。
6. 预览基于当前 Terminal Project 的项目路径，不基于 terminal session 的 `cwd`。
7. 桌面端优先，移动端默认不开放。

## 非目标

- 不嵌入 VS Code。
- 不接入 VS Code extension host。
- 不做文件树、全局搜索、符号索引、LSP diagnostics。
- 不做代码编辑、保存、重命名、删除。
- 不做 git commit、stage、unstage 等写操作。
- 不在 v1 处理大型二进制文件或超大文件。

## 推荐方案

采用右侧 Temporary Preview Panel。

默认状态下，Terminal 保持全宽。桌面端在 Terminal session bar 右侧提供 `Preview` 按钮，位置靠近 `New Terminal`。用户点击 `Preview` 时先打开任务菜单；只有选择具体预览任务后，才打开右侧面板。

![Preview closed](assets/terminal-code-preview-closed.svg)

选择 `Open file...` 后，右侧显示 Spotlight / Cmd+P 风格的文件搜索面板。用户可以按文件名或相对路径模糊搜索当前项目路径内文件，选中后在右侧只读预览；绝对路径只能手动完整输入并打开，不参与模糊搜索。

![Open file preview](assets/terminal-code-preview-open-file.svg)

查看提交前变更时，右侧显示 Changes 面板和 Monaco Diff Editor。左侧只列本次变更文件，并按 `Staged Changes` / `Working Changes` 分组，不展示项目文件树。

![Diff preview](assets/terminal-code-preview-diff.svg)

## 信息架构

### 入口

桌面端 Terminal 第二行 session bar 的右侧操作区增加 `Preview` 入口，推荐位置：

```text
[terminal tab] [terminal tab]      Project shortcut hint   [Preview] [New Terminal]
```

如果横向空间不足，优先保留 session tabs、`Preview`、`New Terminal`：

```text
[terminal tabs scroll area]                         [Preview] [New Terminal]
```

`Preview` 不放在以下位置：

- 不放在第一行 project tabs 右侧。预览入口是当前工作流里的临时查看动作，不是 project 管理动作；真正的文件根目录由 active project 的项目路径提供。
- 不放在 `TerminalSurface` 右上角浮层。那里现在承载 xterm 设置与 terminal search，不应混入文件和 diff 预览。
- 不放在右侧常驻竖向 activity bar。该功能是偶尔使用的临时上下文，不应暗示存在完整代码工作区。

`Preview` 按钮是下拉菜单触发器，不是直接打开空面板的开关。

入口菜单：

- `Open file...`
- `Changes`
- `Close preview`

触发规则：

- 第一次点击 `Preview`：只打开菜单。
- 选择 `Open file...`：打开右侧面板，并在面板内显示文件搜索输入框。
- 选择 `Changes`：打开右侧 Changes 面板，左侧按 `Staged Changes` / `Working Changes` 分组展示文件，右侧显示当前文件 diff。
- 面板已打开时，`Preview` 按钮显示激活态，例如 `Preview: File` 或 `Preview: Changes`。
- 面板已打开时再次点击 `Preview`：仍打开菜单，不直接关闭面板。
- 关闭动作放在菜单的 `Close preview` 和右侧面板 Header 的 `Close` 按钮中。
- `Close preview` 在面板关闭时置灰或隐藏。

`Preview` 入口只在 desktop client mode 展示。mobile client mode 继续保持轻量 monitor 定位。

### 辅助入口

面板打开后，中间分隔线可以提供拖拽 handle，用于调整宽度。

面板关闭时，不建议保留右侧边缘竖条作为主入口。主入口仍是 session bar 里的 `Preview` 按钮，避免界面看起来像 IDE activity bar。

从 terminal 输出中点击文件路径打开预览可作为 v2 能力，不进入 v1。原因：

- xterm 里的选择、复制、链接点击容易冲突。
- 路径识别需要处理相对路径、绝对路径、行号、历史输出等边界。
- v1 的重点是轻量任务菜单和只读预览面板。

如果后续支持，可考虑 `Cmd/Ctrl + click` terminal 中的文件路径，在右侧 Preview 打开对应文件。

### 面板

右侧面板由三层组成：

1. Header
   - 当前模式：`Preview` / `Open file` / `Changes`
   - 状态 badge：`Read only`、文件数、加载中、错误
   - 操作：Refresh、Copy path、Close
   - 更新时间：例如 `Updated 12s ago`

2. Context bar
   - 当前路径
   - `Open another...`

3. Body
   - `file-picker`：文件搜索结果列表；选中文件后进入 file preview
   - `file`：Monaco readonly editor
   - `changes`：Staged / Working 分组文件索引 + Monaco diff editor
   - `empty/error`：轻量空状态或错误状态

### 尺寸

桌面端建议：

- 默认宽度：40%
- 最小宽度：320px
- 最大宽度：60%
- 可拖拽调整宽度
- 关闭后释放全部空间给 Terminal

布局上应避免 iframe 或卡片化预览。它是 Terminal 工作台的一块辅助面板，不是嵌入外部应用。

### Header 操作

#### Refresh

`Refresh` 手动重新读取当前 preview 数据，不改变当前模式和选择。

不同模式下的行为：

| 当前模式       | Refresh 行为                               |
| -------------- | ------------------------------------------ |
| Open file 搜索 | 重新加载当前项目路径的文件候选索引         |
| Open file 预览 | 重新读取当前路径内容                       |
| Changes        | 重新加载 staged changes 和 working changes |
| 空状态         | 不展示或置灰                               |

v1 不做自动实时刷新。原因：

- 文件和 git diff 变化可能很频繁。
- 自动刷新可能打断用户阅读位置。
- git diff 扫描有成本。
- 轻量预览更适合用户主动刷新。

刷新后如果当前文件不存在，显示明确空状态：

```text
File no longer exists

[Open file...] [Changes]
```

#### Copy path

`Copy path` 复制当前预览对象的路径引用，不复制正文或完整 diff。

不同模式下的行为：

| 当前模式       | Copy path 行为                 |
| -------------- | ------------------------------ |
| Open file 搜索 | 置灰或隐藏                     |
| Open file 预览 | 复制当前文件相对项目路径的路径 |
| Changes        | 复制当前选中变更文件路径       |
| 空状态         | 置灰或隐藏                     |

v1 不提供复制全文和复制完整 diff。后续如果需要，可把 `Copy path` 扩展为菜单：

```text
Copy
├─ Copy path
├─ Copy content
└─ Copy diff
```

但默认动作仍应保持为 `Copy path`，避免误复制大文件或大 diff。

## Project Path

Preview 的文件根目录是 Terminal Project Path，而不是 terminal session 的 `cwd`。

原因：

- 同一个 project 下通常会开多个 terminal，它们可能分别 `cd frontend`、`cd backend` 或临时进入其他目录。
- session `cwd` 依赖 shell integration 上报，适合展示 terminal 标签，但不适合作为代码预览的权限和搜索边界。
- PTY 进程退出后，session 记录仍可能存在；只要所属 project path 有效，Preview 仍应能查看项目文件和 git changes。

项目数据模型需要增加：

```ts
interface TerminalProjectListItem {
  projectId: string;
  name: string;
  path: string | null;
  createdAt: string;
  isDefault: boolean;
}
```

创建和编辑 project 时：

- 新建 project 时 `Project Path` 可选。用户只想分组管理 terminal 时，可以只填项目名称。
- 如果新建 project 时填写了 `Project Path`，需要校验该路径存在且是目录。
- 编辑 project 时允许修改名称和路径，因此 UI 文案建议从 `Rename Project` 调整为 `Edit Project`。
- 新建 project 未填写 path 或旧项目迁移后，`path` 可以为 `null`，不自动用 session `cwd` 兜底。
- 如果当前 project 没有 path，Preview 显示空状态：

```text
Set a project path to use Preview

[Set project path]
```

这个空状态不阻止 terminal 使用；它只说明 Preview 需要先给当前 project 设置路径。用户点击 `Set project path` 后进入 project 编辑弹窗，设置路径后即可使用 `Open file...` 和 `Changes`。

Terminal 行为保持宽松：

- 新建 terminal 时，如果所属 project 有 path，默认 `cwd` 使用 project path。
- 如果用户显式传入 `cwd`，或从某个 terminal 继承 `cwd`，仍然保留现有行为。
- 用户在 terminal 中 `cd` 到任何目录都不受限制。
- terminal session 的 `cwd` 继续用于 terminal 标签、历史记录和 session metadata，不用于 Preview 文件解析。

Preview API 仍挂在 session 下，但 session 只用于定位 active project 和鉴权上下文：

```text
terminalSessionId -> session.projectId -> project.path -> previewRoot
```

如果 session 已退出，只要 session 记录存在、project 仍存在且 project path 有效，Preview API 仍可工作；不需要 PTY runtime 存活。

## 切换行为

Preview 的状态分三层：

- 面板开关状态：`TerminalWorkspace` 级。
- 预览内容状态：Terminal Project 级。
- 文件搜索、文件读取、git changes 上下文：active project 的 project path。
- terminal session 只用于确定当前 active project。

这意味着 Preview 面板打开后，切换 project 或 terminal tab 不会自动关闭面板。右侧内容跟随 active project，而不是跟随 terminal 的实时 `cwd`。

### 切换 Terminal Tab

推荐规则：

1. Preview 面板保持打开。
2. 如果目标 terminal 属于同一个 project，Preview 内容保持不变。
3. 如果目标 terminal 属于另一个 project，Preview 切换到该 project 自己的 preview state。
4. 如果目标 project 之前打开过 preview，恢复它上次的 mode、path、open file query 或 changes selection。
5. 如果目标 project 没有 preview state，面板显示空状态：

```text
No preview for this project

[Open file...] [Changes]
```

6. 如果目标 project 没有配置 project path，面板显示设置路径的空状态。
7. Header 始终显示当前绑定的 project 和上下文，例如：

```text
Preview: File
project: browser-viewer
root: /repo
terminal: codex-agent
```

这样可以避免左侧已经切到新 project，但右侧仍显示旧 project diff 的误判；同一 project 内多个 terminal 则共享同一个 preview root 和 preview state。

### 切换 Project

Project 切换本质上会切换 active terminal session，因此沿用 terminal tab 切换规则：

- 面板保持打开。
- 右侧内容切到新 active project。
- 如果该 project 没有 preview state，显示空状态和快捷入口。
- 如果该 project 有历史 preview，恢复该 project 的 preview state。
- 如果该 project 没有配置 project path，显示 `Set a project path to use Preview`。

### 同 Project 的保留策略

如果切换前后两个 terminal 属于同一个 project，Preview 保持当前内容，不需要因为 terminal `cwd` 改变而重置。

例如：

- Project path: `/repo`
- Terminal A `cwd`: `/repo`
- Terminal B `cwd`: `/repo/frontend`

此时正在预览 `docs/architecture/terminal-code-preview.md`，切换 terminal 后继续显示同一路径，因为 Preview root 仍是 project path `/repo`。

不同 preview 类型的切换策略：

| 当前 Preview 内容  | 切换到同 project                                       | 切换到不同 project                 |
| ------------------ | ------------------------------------------------------ | ---------------------------------- |
| Open file 手动路径 | 保留当前文件；Refresh 时按 project path 重新读取       | 切到新 project state，若无则空状态 |
| Changes            | 保留当前 selection；Refresh 时按 project path 重新加载 | 切到新 project state，若无则空状态 |

Changes 预览不跨 project 沿用旧内容。切换 project 后必须重新加载或显示新 project 的 changes 空状态。

### Pin 行为

v1 不提供 Pin。

原因：

- Pin 会让右侧预览和左侧 active terminal 脱钩，增加误判风险。
- Pin 需要额外展示绑定 terminal、切回 follow active、关闭绑定等状态。
- 当前目标是轻量预览，不是多上下文工作区。

后续如果需要，可在 v1.1 或 v2 增加：

```text
Pin preview to this terminal
```

Pin 后 Header 必须明确显示：

```text
Pinned to project browser-viewer
root: /repo
[Follow active terminal]
```

## 用户流程

### 打开任意文件

1. 用户点击 `Preview`。
2. 选择 `Open file...`。
3. 右侧面板进入 `Open file` 模式，显示文件搜索输入框。
4. 用户输入文件名或相对路径片段，例如 `term work`、`network topology`、`docs arch`。
5. 前端请求当前 project path 内的文件搜索结果，展示 top results。
6. 用户点击结果或按 `Enter` 选择当前高亮结果。
7. 右侧显示只读 Monaco Editor。

绝对路径可以允许，但必须由用户显式输入并按 `Enter` 打开。绝对路径不进入候选列表，不做模糊搜索，不进入最近列表。v1 中绝对路径必须解析到当前 project path 内；跨项目或项目外路径不进入 Preview。

路径输入规则：

- 输入框 placeholder 使用当前上下文提示，例如 `Search file or paste absolute path...`。
- 普通输入作为当前 project path 内相对路径候选的 fuzzy query。
- 输入包含 `/` 时，仍可搜索相对路径，例如 `docs arch term` 或 `docs/arch`.
- 输入以 `/` 开头时，视为绝对路径输入，不展示模糊候选。
- 相对路径按 project path 搜索和解析。
- 绝对路径必须由用户完整输入，不通过 picker、候选项或建议项暴露。
- 绝对路径解析后必须位于 project path 内，否则展示 `Path is outside the project path`。
- `~` 展开可作为 v1.1 能力，v1 可不支持。
- 支持粘贴路径。
- 支持 `Enter` 打开当前高亮候选；没有候选时，按当前输入作为路径打开。
- 支持 `Esc` 回到空状态或关闭当前输入。
- 不提供目录树。

搜索请求策略：

- 前端对普通相对路径 query 做 200-300ms debounce 后再请求 `files/search`。
- debounce 期间保留当前结果和 loading 状态，不清空列表，避免输入时闪烁。
- 如果用户继续输入，取消或忽略上一轮未完成请求，避免乱序响应覆盖最新结果。
- 输入为空时不请求搜索接口。
- 输入以 `/` 开头的绝对路径时不请求搜索接口，只在用户按 `Enter` 后调用 file preview。
- `Enter` 打开当前高亮候选不等待 debounce；如果当前没有候选，则按当前输入作为路径打开。

搜索结果展示：

- query 为空时，v1 可以只显示空状态：`Type to search files or paste an absolute path`。
- query 非空时，展示 `Search results`，默认最多 50 条。
- 每条结果单行展示：basename、相对 dirname、git status badge。
- 不默认展示 match reason。match reason 可作为调试 tooltip 或开发辅助，不进入常规 UI。
- 高亮第一条结果，`Enter` 打开。
- 没有结果时仍允许按 `Enter` 以当前输入作为路径打开。

后续可增强的候选组：

- `Changed files`：working/staged changes 中的文件，尤其是新增或修改的 Markdown。
- `Recent`：当前 project 最近打开过的文件。
- `Suggested`：少量高价值根文档，例如 `README.md`、`AGENTS.md`。

这些候选组不进入 v1 的硬要求，避免第一版又退化成文档列表或文件浏览器。

打开后的显示：

- Header 显示 `Open file`、`Read only`、`Updated ... ago`、`Refresh`、`Copy path`、`Close`。
- Context bar 显示当前相对 project path 的路径，不常驻展示 project path 或 terminal `cwd`。
- Body 使用 Monaco readonly editor。
- 如果文件语言可从扩展名推断，使用对应 language；否则使用 plaintext。

错误状态：

| 场景           | 展示                                 |
| -------------- | ------------------------------------ |
| 路径为空       | `Enter a file path`                  |
| 路径指向目录   | `Directories are not supported`      |
| 文件不存在     | `File not found`，保留输入框方便修改 |
| 文件过大       | `File exceeds preview limit`         |
| 二进制文件     | `Binary files cannot be previewed`   |
| 项目未设置路径 | `Set a project path to use Preview`  |
| 路径不允许     | `Path is outside the project path`   |

错误状态不关闭面板，也不清空用户输入。

### 查看 Changes

1. 用户点击 `Preview`。
2. 选择 `Changes`。
3. 后端在当前 project path 下解析 git repository。
4. 返回 staged changes 和 working changes 两组文件索引，不返回文件正文或 diff content。
5. 右侧面板左栏按组展示文件。
6. 前端自动选中第一个 staged 文件；如果没有 staged 文件，则选中第一个 working 文件。
7. 前端请求当前选中文件的 diff content。
8. 右侧显示当前选中文件的 Monaco Diff Editor。

文件索引只代表本次变更文件，不扩展成项目树。

左栏参考 VS Code Source Control 的紧凑结构：

```text
Staged Changes
  terminal-code-preview.md

Working Changes
  terminal-code-preview-open-file.svg
  terminal-code-preview-diff.svg
```

左栏不显示新增/删除行数。文件项只展示：

- basename
- 相对 dirname 或短路径
- git status badge，例如 `M`、`A`、`D`、`R`

选择文件时：

- 初次进入 Changes 模式时，自动选中第一个 staged 文件；如果 staged 为空，则自动选中第一个 working 文件。
- 自动选中后立即请求该文件的 `file-diff`，避免右侧 diff 区域为空。
- 来自 `Staged Changes` 的文件请求 staged diff。
- 来自 `Working Changes` 的文件请求 working tree diff。
- diff content 按文件懒加载；切换文件时只加载当前选中文件的 old/new content。
- 已加载的单文件 diff 可以在当前 project preview state 中短时缓存；`Refresh` 清空缓存并重新加载 changes index。
- 如果两组都为空，展示 `No changes`。

## Open File 搜索设计

`Open file...` 的目标是轻量文件定位，不是文件浏览器。它采用更接近 VS Code `Cmd+P` 的紧凑交互：顶部一个输入框，下方直接显示结果列表，选中后打开只读预览。

不常驻展示 project path。project path 只作为搜索和解析边界存在；如果用户需要确认上下文，可放在 tooltip、错误信息或调试信息里。常规 UI 只展示相对路径。

### 搜索范围

- 只搜索当前 project path 内的相对路径。
- project path 是唯一搜索根目录，不从 terminal `cwd` 推断。
- 如果当前 project 没有 path，搜索接口返回明确错误，不 fallback 到 session `cwd`。
- 绝对路径不参与搜索，只能完整输入后打开，并且必须位于当前 project path 内。
- 搜索接口不返回绝对路径候选。

### 技术选型

v1 明确采用后端搜索和排序，前端只负责 command palette 交互和结果展示。

前端使用 `cmdk` 承载 command palette 交互：

- `Command.Input` 负责输入。
- `Command.List` / `Command.Item` 负责键盘选择和点击选择。
- 使用 `shouldFilter={false}`，禁用 cmdk 内置过滤。
- 前端不使用 `match-sorter`、Fuse.js 或其他 fuzzy 算法做二次过滤和排序。
- 前端只展示后端返回的 items 顺序，保证键盘高亮、点击选择和 Enter 打开行为稳定。
- 后续如果文件候选量很大，再加虚拟列表或服务端分页。

后端负责：

- 扫描 project path 内的文件候选。
- 执行 fuzzy match。
- 计算 score / rank。
- 叠加 git changed/staged bonus、recent bonus 等业务权重。
- 按最终排序返回最多 `limit` 条结果。
- 可使用 `match-sorter` / `@tanstack/match-sorter-utils` 实现排序，也可以先用后端自定义 scorer；这是后端实现细节。

不采用“后端返回全量文件列表，前端本地 fuzzy 搜索”的原因：

- 大仓库文件列表可能很大，会增加首轮传输和前端内存压力。
- project path 下的排除规则、git status bonus、权限校验更适合后端统一处理。
- 后续如果要做短时索引或缓存，也应放在后端 preview search service 中。

### 排序规则

后端排序不只看 fuzzy 分数，应叠加文件路径语义：

1. basename 精确匹配。
2. basename 前缀匹配。
3. basename fuzzy 匹配。
4. path segment 匹配。
5. full relative path fuzzy 匹配。
6. git changed/staged bonus。
7. recently opened bonus。
8. shorter path bonus。
9. path 字母序兜底。

示例：输入 `term work` 时，`frontend/src/components/terminal/terminal-workspace.tsx` 应排在只在目录中弱命中的文件前面。

### 输入分流

| 输入                                         | 行为                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| `term work`                                  | 搜索 project path 内相对路径                                                      |
| `docs arch`                                  | 搜索 project path 内相对路径                                                      |
| `docs/architecture/terminal-code-preview.md` | 搜索并优先匹配该相对路径；按 Enter 可直接打开                                     |
| `/Users/me/repo/README.md`                   | 视为绝对路径输入，不展示搜索结果；如果位于当前 project path 内，按 Enter 直接打开 |
| `~/repo/README.md`                           | v1 可提示不支持；v1.1 可支持 `~` 展开                                             |

### 空状态

query 为空时，v1 不展示所有文件。

默认空状态：

```text
Type to search files or paste an absolute path
```

这样可以避免文件列表退化成项目树。Changed / Recent / Suggested 候选可以作为后续增强。

## 前端设计

建议新增模块：

- `frontend/src/components/terminal/terminal-preview-panel.tsx`
- `frontend/src/components/terminal/terminal-preview-menu.tsx`
- `frontend/src/components/terminal/terminal-open-file-command.tsx`
- `frontend/src/components/terminal/terminal-monaco-viewer.tsx`
- `frontend/src/features/terminal/preview-store.ts`
- `frontend/src/services/terminal-preview.ts`

### 状态管理

引入 `zustand` 作为 Preview 专用轻量状态管理。

原因：

- 当前 `TerminalWorkspace` 已经承担 project、session、activity marker、bell marker、history drawer、dialog 等大量局部状态。
- Preview 需要 UI 级 open/width，又需要按 project 恢复 mode、query、selected file、selected change。
- 用 `useState<Map<projectId, PreviewProjectState>>` 可以实现，但会继续加重 `TerminalWorkspace`，并让子组件通过 props 层层传递。
- Preview 的状态是独立 UI chrome 状态，适合用一个小 store 管理，不需要引入更重的全局架构。

依赖：

- 在 `frontend/package.json` dependencies 增加 `zustand`。
- 只为 Preview 引入，不借机重构现有 terminal project/session 状态。

状态归属：

- `preview-store.ts` 持有 preview open/closed、width 和 per-project preview state。
- 每个 terminal project 在 store 中有自己的 preview mode、path、open file query、selected file path、selected change。
- `TerminalWorkspace` 负责把 active terminal session id、active project id 和 active project 数据传给 Preview 组件，并调用 store action。
- project path 来自 active project 数据，不写入 preview store，避免 project path 更新时出现双数据源同步问题。
- `TerminalSurface` 不感知 preview。
- 预览状态按 active project 生效，但不需要持久化到后端。
- v1 不使用 localStorage/sessionStorage 持久化 Preview 状态；刷新页面后丢失是可以接受的。
- 后续如果需要记忆 width 或最近打开文件，再单独评估 `zustand/middleware` 的 `persist`，不要默认打开持久化。

建议状态模型：

```ts
import { create } from "zustand";

type TerminalPreviewMode = "file" | "changes";

interface TerminalPreviewUiState {
  open: boolean;
  widthPx?: number;
}

interface TerminalPreviewProjectState {
  mode: TerminalPreviewMode | null;
  path?: string;
  openFileQuery?: string;
  selectedFilePath?: string;
  selectedChangePath?: string;
  selectedChangeKind?: "staged" | "working";
}

interface TerminalPreviewStore {
  ui: TerminalPreviewUiState;
  projects: Record<string, TerminalPreviewProjectState>;
  openPreview: (projectId: string, mode?: TerminalPreviewMode) => void;
  closePreview: () => void;
  setWidth: (widthPx: number) => void;
  updateProjectPreview: (
    projectId: string,
    updates: Partial<TerminalPreviewProjectState>,
  ) => void;
  removeProjectPreview: (projectId: string) => void;
}
```

实现边界：

- `TerminalWorkspace` 不再新增多个 preview 相关 `useState`。
- `TerminalPreviewPanel`、`TerminalPreviewMenu`、`TerminalOpenFileCommand` 直接通过 store selector 读取所需状态。
- selector 应尽量细，避免 terminal 输出或 session list 变化导致 Preview 子树不必要重渲染。
- 删除 terminal session 时不需要清理 project preview state，除非该 session 是 project 删除的一部分。
- 删除 project 时调用 `removeProjectPreview(projectId)` 清理该 project 的 preview state。
- store 文件限制在 `features/terminal` 下，不放到应用级全局 store，避免扩大状态管理范围。

### 编辑器加载与依赖策略

Monaco 是重量级依赖，不能进入 Terminal 的默认首屏 bundle。v1 明确采用懒加载，并使用 React wrapper。

依赖选择：

- 使用 `@monaco-editor/react`，不直接手写 `monaco-editor` 初始化。
- 在 `frontend/package.json` dependencies 增加 `@monaco-editor/react` 和 `monaco-editor`。即使 wrapper 可能间接依赖 Monaco，也建议显式锁定 `monaco-editor`，避免 pnpm 解析和 worker 配置依赖隐式传递。
- 只有 wrapper 无法满足 worker、model 生命周期或 diff editor 行为时，才在局部封装里接触底层 `monaco-editor` API。

懒加载策略：

- `TerminalPreviewPanel` 由 `TerminalWorkspace` 通过 `React.lazy` / dynamic import 加载。
- 只有 preview store 的 `ui.open === true` 时，才渲染 lazy panel。
- `TerminalMonacoViewer` 再单独做一层 lazy boundary；打开 `Open file` 或 `Changes` 且需要 editor/diff editor 时，才下载 `@monaco-editor/react` 和 `monaco-editor` chunk。
- `Open file...` 的搜索输入和结果列表不依赖 Monaco。用户只打开文件搜索但还没选中文件时，不应下载 Monaco。
- lazy fallback 使用轻量 skeleton 或 `Loading preview...`，不要阻塞 Terminal 输入和输出。

建议拆包边界：

```text
TerminalWorkspace
  └─ lazy TerminalPreviewPanel
       ├─ TerminalOpenFileCommand
       ├─ ChangesFileList
       └─ lazy TerminalMonacoViewer
            ├─ @monaco-editor/react Editor
            └─ @monaco-editor/react DiffEditor
```

打包体积影响：

- Web 端：Monaco 相关代码必须进入独立 lazy chunk；验收时检查生产构建产物，确认 Terminal 初始 chunk 不包含 Monaco。
- Electron 端：懒加载不能减少最终安装包体积，但可以减少窗口首屏加载成本、JS parse/execute 成本和内存占用。
- Electron 打包体积会增加，v1 接受该成本，但需要在 PR 中记录 `pnpm build` / Electron renderer 产物变化；如体积不可接受，再评估只加载基础语言、进一步拆 worker 或改用更轻量 viewer。
- 不为降低体积改成手写代码高亮。预览 diff 和大文件滚动稳定性优先。

Web Worker 配置：

- Monaco 需要 worker 支持 editor、JSON、CSS、HTML、TypeScript/JavaScript 等语言能力。
- 在 Vite 环境中应显式配置 `self.MonacoEnvironment.getWorker`，使用 `monaco-editor/esm/vs/.../*.worker?worker` 这类 worker import，避免开发环境可用但生产或 Electron renderer 失效。
- v1 至少配置 editor worker 和 TypeScript/JavaScript worker；JSON/CSS/HTML worker 可按预览语言支持范围加入。
- worker 配置放在 `TerminalMonacoViewer` 附近的独立模块中，例如 `frontend/src/components/terminal/monaco-workers.ts`，并只被 lazy Monaco viewer import。
- 不启用 LSP、项目级 diagnostics 或全仓库语义索引。worker 只服务当前打开的只读 model 和 diff model。

Monaco 使用边界：

- `readOnly: true`
- `minimap.enabled: false`
- `wordWrap: "on"` 可按文件类型调整
- diff editor 关闭编辑侧写入
- 不注册 LSP
- 不注册项目级 workspace model
- 文件内容按需创建 model，关闭面板时释放

## 后端协议建议

Terminal Project API 需要增加 `path`：

```http
POST /api/terminal/project
PATCH /api/terminal/project/:id
GET /api/terminal/project
```

建议语义：

- `POST /project` 新建 project 时只要求 `name`，`path` 可选。
- `PATCH /project/:id` 支持同时更新 `name` 和 `path`。
- `GET /project` 返回 `path: string | null`，用于兼容旧数据。
- 如果请求包含非空 path，后端校验 path 必须存在、是目录、可读。
- 如果请求 path 为空、空白或未提供，后端保存为 `null`。
- 旧数据迁移不猜测 path，不从历史 session `cwd` 自动填充。

示例：

```json
{
  "projectId": "project-1",
  "name": "browser-viewer",
  "path": "/Users/bytedance/Desktop/vscode/browser-hub/browser-viewer",
  "createdAt": "2026-04-17T00:00:00.000Z",
  "isDefault": false
}
```

新增 API 挂在 Terminal session 下：

```http
GET /api/terminal/session/:id/preview/files/search?q=<query>&limit=50
Authorization: Bearer <accessToken>
```

语义：

- session id 只用于确认 session 存在、读取 `session.projectId`，并定位对应 project path。
- 如果 session 已退出但记录仍存在，且 project path 有效，接口仍可工作。
- 如果 project path 为空或无效，返回需要设置 project path 的错误。
- 只返回 project path 内相对路径候选。
- `q` 是相对路径 fuzzy query。
- 如果 `q` 是绝对路径输入，返回 `absoluteInput: true` 和空候选。
- 默认 `limit` 为 50。
- 后端可使用 `rg --files` 或受限 Node 遍历生成候选。
- 后端负责 fuzzy match 和最终排序；前端不得对返回 items 做二次 fuzzy 排序。
- 可做 project path 维度的短时文件索引缓存，避免每次 query 都重新执行完整扫描。
- `Refresh` 清理或重建缓存。

返回：

```json
{
  "kind": "file-search",
  "projectId": "project-1",
  "projectPath": "/Users/.../browser-viewer",
  "query": "term work",
  "absoluteInput": false,
  "items": [
    {
      "path": "frontend/src/components/terminal/terminal-workspace.tsx",
      "basename": "terminal-workspace.tsx",
      "dirname": "frontend/src/components/terminal",
      "gitStatus": "modified",
      "reason": "basename fuzzy match",
      "score": 0.93
    }
  ]
}
```

绝对路径输入返回：

```json
{
  "kind": "file-search",
  "projectId": "project-1",
  "projectPath": "/Users/.../browser-viewer",
  "query": "/Users/me/repo/README.md",
  "absoluteInput": true,
  "items": []
}
```

```http
GET /api/terminal/session/:id/preview/file?path=<path>
Authorization: Bearer <accessToken>
```

语义：

- session id 只用于定位 project path。
- `path` 可以是相对 project path 的路径，也可以是显式绝对路径。
- 相对路径按 project path 解析。
- 显式绝对路径必须位于 project path 内。
- 后端返回 normalized path、absolute path、解析基准和只读内容。
- 该接口不接受目录，不返回目录列表。

返回：

```json
{
  "kind": "file",
  "projectId": "project-1",
  "path": "docs/architecture/network-topology.md",
  "absolutePath": "/Users/.../docs/architecture/network-topology.md",
  "base": "project",
  "projectPath": "/Users/.../browser-viewer",
  "language": "markdown",
  "content": "...",
  "sizeBytes": 12345,
  "readonly": true
}
```

```http
GET /api/terminal/session/:id/preview/git-changes
Authorization: Bearer <accessToken>
```

语义：

- session id 只用于定位 project path。
- 后端以 project path 作为 git working directory。
- 如果 project path 位于 git repo 子目录内，v1 只返回 project path 下的 changes；如果用户想看整个 repo，应把 project path 设置为 repo root。
- 如果 project path 不在 git repo 内，返回明确错误。
- 只返回 changes 文件索引，不返回 `oldContent` / `newContent`。
- 文件索引用于左侧列表和默认选中第一项；具体 diff content 由 `file-diff` 接口按需加载。

返回：

```json
{
  "kind": "git-changes",
  "projectId": "project-1",
  "projectPath": "/Users/.../browser-viewer",
  "repoRoot": "/Users/.../browser-viewer",
  "staged": [
    {
      "path": "docs/architecture/terminal-code-preview.md",
      "status": "modified"
    }
  ],
  "working": [
    {
      "path": "docs/README.md",
      "status": "modified"
    }
  ]
}
```

```http
GET /api/terminal/session/:id/preview/file-diff?path=<path>&kind=<staged|working>
Authorization: Bearer <accessToken>
```

语义：

- session id 只用于定位 project path。
- `path` 必须是 project path 内的相对路径。
- `kind=staged` 返回 index 对 HEAD 的 diff。
- `kind=working` 返回 working tree 对 index 的 diff。
- 只返回单个文件的 `oldContent` / `newContent`，用于 Monaco Diff Editor。
- 对 deleted、added、renamed 文件要明确返回 `status`，缺失一侧内容用空字符串表示。
- 设置单文件大小上限和超时，避免大文件 diff 压垮响应。

返回：

```json
{
  "kind": "file-diff",
  "projectId": "project-1",
  "projectPath": "/Users/.../browser-viewer",
  "repoRoot": "/Users/.../browser-viewer",
  "changeKind": "working",
  "path": "docs/README.md",
  "status": "modified",
  "oldContent": "...",
  "newContent": "...",
  "readonly": true
}
```

## 安全与限制

文件读取限制：

- 默认基于 Terminal Project Path 解析相对路径。
- 绝对路径只在用户显式输入时允许，并且必须位于当前 project path 内。
- 不从 terminal session `cwd` 推断 preview root。
- 不接受目录读取。
- 最大文件大小建议 1 MiB，后续可配置到 2 MiB。
- 二进制文件不返回内容。
- 拒绝特殊设备路径、socket、FIFO。
- 错误信息不暴露不必要的系统细节。

文件搜索限制：

- 只返回 project path 内相对路径。
- 绝对路径输入不做搜索，不返回候选。
- project path 缺失或无效时返回明确错误，不 fallback 到 session `cwd`。
- 默认排除 `.git`、`node_modules`、`dist`、`build`、`coverage`、`.next`、`playwright-report`、`test-results`、cache/vendor/generated 类目录。
- 设置扫描超时，例如 2-3 秒。
- 默认最多返回 50 条结果。
- 不读取文件正文。
- 不返回目录树。

git diff 限制：

- 只读 git 命令。
- 设置超时，例如 5 秒。
- 限制最大 diff 文件数，例如 100。
- `git-changes` 只返回文件索引，不返回正文。
- `file-diff` 只返回当前选中文件的 old/new content。
- 限制单文件 diff 内容大小。
- git working directory 使用 project path，不使用 session `cwd`。
- 如果 project path 位于 git repo 子目录内，只展示 project path 下的 changes。
- 不执行 stage、checkout、commit、reset 等写操作。

鉴权：

- 复用现有 Terminal HTTP bearer token。
- Preview API 必须确认 session 存在。
- 后续如引入 capability，可把 preview 标记为 readonly terminal capability。

## 移动端边界

移动端 Terminal 当前定位是轻量 monitor 加受限输入。代码预览不进入 v1 移动端。

原因：

- 手机屏幕不适合 terminal + Monaco 并排。
- 文件和 diff 预览容易引入复杂手势与误操作。
- 当前移动端原则是不下放完整桌面工作台能力。

后续如果需要移动端预览，可以单独设计为只读底部抽屉，并且仍然不展示文件树。

## 分阶段实施

### v1

- Terminal Project 增加可选 `Project Path`；未设置 path 的 project 可以正常使用 terminal，但不能使用 Preview。
- 新建 terminal 在未显式指定 `cwd` 时，默认从所属 project path 启动。
- 引入 `zustand`，仅用于 Preview 状态。
- 引入 `@monaco-editor/react` 和 `monaco-editor`，仅在 Preview 打开并进入 editor/diff viewer 时懒加载。
- 右侧可折叠 preview panel。
- `Open file...` command palette。
- project path 内相对路径 fuzzy search。
- 绝对路径手动输入打开，不参与搜索，并且必须位于 project path 内。
- `Changes`
- Changes 左栏按 `Staged Changes` / `Working Changes` 分组。
- Changes 左栏不显示新增/删除行数。
- readonly Monaco Editor。
- Monaco Diff Editor。
- Vite / Electron renderer 下显式配置 Monaco web workers。
- 后端只读 file-search、file、git-changes 和 file-diff API。

### v1.1

- 面板宽度本地记忆。
- 当前 project 维度保留最近打开路径。
- 复制文件路径、复制 diff。
- `Open file...` 可增加轻量候选组，例如最近打开的 Markdown、当前 working/staged changes 中的 Markdown、最近变更文件。
- `Open file...` 可增加路径补全，但只补当前 project path 内候选，不做项目文件树。

### v2

- Open file 的 Markdown rendered mode 切换。
- AI artifact 显式注册，例如 plan、测试报告、review notes。
- 预览入口可由 AI 输出主动提示，但仍需用户点击打开。

## 验收标准

桌面端：

- Preview 默认关闭，Terminal 初始保持完整宽度。
- Preview 关闭时，Terminal 初始 JS chunk 不包含 Monaco；未选中文件的 `Open file...` 搜索状态也不加载 Monaco。
- 打开 Preview 后，左侧 Terminal 仍可输入、搜索、接收输出。
- Preview 状态由 `zustand` store 管理，`TerminalWorkspace` 不新增 per-project preview `useState` / `Map` 状态。
- 切换 project 或 terminal tab 不关闭 Preview 面板。
- 同一 project 内切换 terminal 时，Preview 保持当前内容，不受 terminal `cwd` 影响。
- 切换 project 时，Preview 内容切到新 project 的 preview state，并显示当前 project/root/terminal 上下文。
- 当前 project 没有 project path 时，Preview 显示 `Set a project path to use Preview`，不 fallback 到 session `cwd`。
- Changes 预览在切换 project 后重新加载当前 project path 下的 staged / working changes 文件索引，不沿用旧 project changes。
- Changes 进入后自动选中第一个 staged 文件；没有 staged 文件时选中第一个 working 文件，并加载该文件 diff。
- `Open file...` 展示 command palette，支持按文件名和相对路径 fuzzy search。
- `Open file...` 输入搜索有 200-300ms debounce，不对每个 keystroke 立即请求后端。
- `Open file...` 搜索结果只包含 project path 内相对路径。
- `Open file...` 绝对路径只允许完整输入后打开，不参与 fuzzy search，且必须位于 project path 内。
- `Open file...` 错误状态不关闭面板，也不清空用户输入。
- `Changes` 能看到 staged / working 两组变更文件；选中文件后按需加载并展示当前文件 diff。
- Changes 左侧文件索引不扩展成项目文件树。
- Changes 左侧文件项不显示新增/删除行数。
- 生产构建和 Electron renderer 中 Monaco worker 正常加载，Editor / Diff Editor 不出现 worker fallback 或语法服务加载错误。
- PR 需要记录引入 Monaco 后的构建产物变化，确认体积增长来自 lazy chunk，而不是 Terminal 首屏 chunk。
- 面板关闭后释放空间。
- xterm 连接和 renderer 行为不受影响。

移动端：

- 不展示 Preview 入口。
- Terminal monitor 与受限输入能力保持原样。

后端：

- Project API 支持可选 path 字段；新旧 project path 为空时返回 `null`。
- 大文件被拒绝或提示超限。
- 二进制文件不返回正文。
- 目录路径不返回列表。
- 文件搜索不返回绝对路径候选，不读取正文，有超时和结果数量上限。
- `git-changes` 不返回文件正文或 diff content，只返回 staged / working 文件索引。
- `file-diff` 只返回单个选中文件的 old/new content，并有单文件大小限制。
- Preview API 不依赖 PTY runtime 存活；exited session 只要记录和 project path 有效即可使用。
- Preview API 不使用 session `cwd` 推断 root。
- git changes 超时、project path 缺失或非 git repo 时有明确错误。

## 待确认点

1. v1 是否完全只读。建议只读。
2. 是否允许绝对路径读取。建议允许显式输入，但必须限制在 project path 内。
3. Preview width 是否需要持久化。建议 v1 不持久化，后续再考虑 `zustand/middleware` persist。
4. Monaco v1 支持哪些语言 worker。建议先覆盖 editor、TypeScript/JavaScript、JSON、CSS、HTML，其余语言回退 plaintext 或基础 tokenization。

## 参考

- `cmdk`：React command menu 组件，支持自定义 filter、`shouldFilter={false}` 和 Radix Dialog 组合。https://github.com/pacocoursey/cmdk
- `match-sorter`：后端 fuzzy ranking 可选实现。https://github.com/kentcdodds/match-sorter
- TanStack `match-sorter-utils`：后端 fuzzy ranking 可选实现，可保留 ranking meta。https://tanstack.com/table/v8/docs/guide/fuzzy-filtering
- Fuse.js：后端 fuzzy search 备选，适合 weighted keys / token search。https://www.fusejs.io/
- uFuzzy：后端高性能 fuzzy search 备选。https://github.com/leeoniya/uFuzzy
- `@monaco-editor/react`：React Monaco Editor wrapper，提供 `Editor` 和 `DiffEditor`。https://github.com/suren-atoyan/monaco-react
- Monaco Editor：编辑器和 worker 源依赖。https://github.com/microsoft/monaco-editor
