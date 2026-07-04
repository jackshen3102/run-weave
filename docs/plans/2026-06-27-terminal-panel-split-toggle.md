# 终端拆分 Panel 默认关闭与右键启用方案

## 目标

默认不显示终端拆分 panel 控制条，节省终端区域顶部一行高度。用户需要拆分能力时，可以在终端区域右键菜单中手动启用；启用后显示现有 panel 目标条，继续支持 Split Right、Split Down、切换 panel、关闭 panel。

## 非目标

- 不改后端 panel API、tmux panel 模型、workspace 存储和事件协议。
- 不改 App / mobile 终端页面，当前首期只作用于 Web desktop 终端。
- 不删除现有已经创建的 panel。禁用只是隐藏控制条和入口，不销毁后端 workspace。
- 不新增单测。该仓库当前约束是非 E2E 测试不新增，UI 行为用 Playwright 验收。

## 当前代码现状

- `frontend/src/components/terminal/terminal-workspace-shell.tsx` 在 desktop 且有 active session 时无条件渲染 `TerminalPanelTargetBar`。
- `frontend/src/components/terminal/terminal-workspace-shell.tsx` 在 active session 变化后无条件调用 `listTerminalPanels(...)`，用于加载 `panelWorkspaceBySessionId`。
- `frontend/src/components/terminal/terminal-panel-target-bar.tsx` 已包含现有 split/focus/close 行为，应该复用，不重写 panel 操作。
- `frontend/src/components/terminal/terminal-surface.tsx` / `terminal-surface-layout.tsx` 不需要新增终端内容区右键菜单；入口复用 terminal tab 右键菜单。
- `frontend/src/components/ui/context-menu.tsx` 已有 `ContextMenuItem`，适合追加一个带 icon 的普通菜单项。
- `frontend/src/features/terminal/preferences.ts` 当前只有默认终端偏好常量，需要补一个窄范围的 panel split 本地读写 helper。

## 用户可见行为

1. 默认进入 `/terminal/:terminalSessionId` 时，不显示 panel 目标条，终端高度增加一行。
2. 用户在终端 tab 上右键，和 `Rename Alias` 同一个菜单中出现菜单项：`Enable Panel Split` / `Disable Panel Split`，左侧带 icon。
3. 默认文案为 `Enable Panel Split`。
4. 点击 `Enable Panel Split` 后：
   - 偏好写入本地；
   - 当前页面立刻显示 `TerminalPanelTargetBar`；
   - 若当前 session 尚未加载 panel workspace，立即调用 `listTerminalPanels(...)` 补齐 workspace。
5. 再次右键取消勾选后：
   - 偏好写入本地；
   - `TerminalPanelTargetBar` 立即隐藏；
   - 已存在的后端 panel 不被关闭。
6. 如果当前终端 tab 已经有多个 panel，`Disable Panel Split` 禁用，不允许隐藏 panel 目标条；禁用原因通过 tooltip 展示。
7. 用户刷新页面后，保留上次选择。

## 状态与存储设计

Panel Split 开关是 terminal session 的服务端状态，不是浏览器本地偏好：

- `TerminalSessionListItem.panelSplitEnabled: boolean` 表示该 session 是否展示和启用 panel workspace UI。
- 新建 session 默认 `panelSplitEnabled=false`。
- `PATCH /api/terminal/session/:id` 支持 `{ "panelSplitEnabled": true | false }`，写入后端 session metadata，并随 session list 返回。
- 前端不使用 localStorage 作为权威来源；刷新页面、换浏览器或桌面端重连时，以服务端 session metadata 为准。

读取规则：

- session list 返回 `panelSplitEnabled` 时直接使用该值。
- 老数据没有该字段时，后端迁移/构造记录默认补 `false`。
- 写入失败时前端保留原服务端状态并显示请求错误，不做本地覆盖。

## 组件设计

### 1. `terminal-workspace-shell.tsx`

状态来源：

```ts
const panelSplitEnabled = activeSession?.panelSplitEnabled ?? false;
```

新增 setter：

```ts
const setPanelSplitEnabled = (terminalSessionId: string, enabled: boolean) => {
  updateTerminalSession(apiBase, token, terminalSessionId, {
    panelSplitEnabled: enabled,
  });
};
```

调整 panel workspace 加载 effect：

- 当 `panelSplitEnabled === false` 时，不主动调用 `listTerminalPanels(...)`。
- 当用户切到 `true`，并且 active session 存在时，调用 `listTerminalPanels(...)`。

调整渲染：

```tsx
{activeSession && !isMobileMonitor && panelSplitEnabled ? (
  <TerminalPanelTargetBar ... />
) : null}
```

同时把 `panelSplitEnabled`、当前 active session 的 `panelCount`、`onPanelSplitEnabledChange` 传给 `TerminalSessionTab`，在终端 tab 右键菜单中加入同一个 panel split toggle item。

### 2. `TerminalSessionTab`

在已有 tab 右键菜单里追加 toggle item：

```tsx
<ContextMenuItem
  onSelect={() => {
    onPanelSplitEnabledChange(!panelSplitEnabled);
  }}
>
  <PanelsTopLeft className="h-4 w-4" />
  {panelSplitEnabled ? "Disable Panel Split" : "Enable Panel Split"}
</ContextMenuItem>
```

注意点：

- 复用当前终端 tab 的 `ContextMenu`，不要再给终端内容区额外挂右键菜单。
- 当 `panelSplitEnabled === true && panelCount > 1` 时，`Disable Panel Split` 使用 `aria-disabled`、灰色样式和 `title` tooltip 提示原因，并在 `onSelect` 中阻止执行。
- mobile mode 继续不显示该菜单。

## 文件范围

- `frontend/src/features/terminal/preferences.ts`
  - 不保存 panel split 开关；该状态归后端 terminal session metadata。
- `packages/shared/src/terminal-protocol.ts`
  - `TerminalSessionListItem` 和 `UpdateTerminalSessionRequest` 增加 `panelSplitEnabled`。
- `backend/src/terminal/*`、`backend/src/routes/terminal.ts`
  - 持久化 session 级 `panelSplitEnabled`，并通过 session list / PATCH 暴露。
- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
  - 从 active session 读取 panel split 状态；
  - 按 `panelSplitEnabled` 控制 `listTerminalPanels` 和 `TerminalPanelTargetBar`；
  - 在 `TerminalSessionTab` 右键菜单中加入 panel split toggle item。

## 验收标准

1. 默认刷新终端页后，顶部不显示 `main / tests / panel-*` 的 panel 目标条。
2. 默认刷新终端页后，DOM 中不出现 `Split terminal right`、`Split terminal down`、`Close terminal panel`。
3. 右键终端 tab，菜单出现 `Enable Panel Split`，默认关闭且左侧有 icon。
4. 启用后，panel 目标条出现，Split / Close 按钮可见。
5. 只有一个 panel 时，点击 `Disable Panel Split` 后 panel 目标条隐藏，终端内容区域高度恢复。
6. 当前终端 tab 有多个 panel 时，`Disable Panel Split` 禁用，hover/focus 时通过 tooltip 提示需要先关闭多余 panel。
7. 刷新后保持上次选择。
8. mobile mode 不受影响。

## 验证方式

命令验证：

```bash
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

浏览器验收使用 `$playwright-cli`：

1. 打开 `http://localhost:5173/terminal/<active-session-id>`。
2. 确认 session list 中 `panelSplitEnabled=false`。
3. 截取 DOM/snapshot，确认 panel 目标条不存在。
4. 右键 terminal tab，点击 `Enable Panel Split`。
5. 确认 panel 目标条出现，且 `Split terminal right` / `Split terminal down` / `Close terminal panel` 存在。
6. 刷新页面或重新打开另一个浏览器会话，确认启用状态按服务端 session metadata 保留。
7. 再次右键取消，确认目标条隐藏。

## 风险点

- 如果用户已经有多个 panel，默认隐藏目标条会让这些 panel 不可见；但右键启用后可以恢复管理入口。该行为符合“默认不占空间、按需启用”的目标。
- 如果只在隐藏目标条时跳过 `listTerminalPanels`，事件推送仍可能更新 `panelWorkspaceBySessionId`。这不影响 UI，因为目标条由 `panelSplitEnabled` 控制。
- 入口在 tab 右键菜单中，用户需要知道右键终端 tab 才能发现；若后续仍觉得难找，可再评估是否加入显式设置面板。
