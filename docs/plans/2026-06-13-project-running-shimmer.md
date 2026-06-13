# 项目运行态 Shimmer 计划

## 目标

在 Web 终端工作区顶部项目 tab 上复用已有终端 tab 的文字 shimmer 效果：

- 当某个项目下任意一个终端的 `TerminalState.state === "agent_running"` 时，该项目名称展示与正在执行的终端 tab 相同的文字渐变效果。
- 当该项目下没有终端处于 `agent_running` 时，项目名称恢复当前普通文本样式。
- 不新增后端状态字段，不新增轮询，不改变终端运行态判定来源。

## 当前依据

- 单个终端 tab 的现有效果在 `frontend/src/components/terminal/terminal-workspace-shell.tsx` 的 `TerminalSessionTab` 中实现，判断条件是 `terminalState?.state === "agent_running"`，渲染使用 `ShimmerText`，并设置 `--shimmer-duration: 4000` 与 `--shimmer-repeat-delay: 300`。
- `TerminalWorkspace` 已维护 `terminalStateBySessionId`，初始值来自 `listTerminalSessions` 返回的 `session.terminalState`，后续通过全局 `/ws/terminal-events` 的 `terminal_state_changed` 事件更新。
- 顶部项目 tab 当前只聚合了 `bellMarkers` 与 `completionMarkers`，还没有聚合同项目下的 `agent_running` 状态。

## 范围

修改文件：

- `frontend/src/components/terminal/terminal-workspace-shell.tsx`
  - 在项目 tab 渲染时计算同项目是否存在 running agent。
  - 对 running 项目名称复用 `ShimmerText`。
  - 保留现有项目 tab 的 active、hover、dragging、bell、completion、context menu、排序行为。

不修改文件：

- `backend/**`
- `packages/shared/**`
- `packages/common/**`
- `app/**`
- 前端测试配置

## 关键实现

### 1. 计算项目运行态

在 `SortableTabs` 的 `renderTab` 内，沿用现有 `hasBell`、`hasCompletion` 的聚合方式新增：

```tsx
const isWorking = sessions.some(
  (s) =>
    s.projectId === project.projectId &&
    terminalStateBySessionId[s.terminalSessionId]?.state === "agent_running",
);
```

约束：

- 只认 `TerminalState.state === "agent_running"`。
- 不用 `session.status === "running"`、`activeCommand`、terminal name、scrollback 或其它启发式信号。
- 如果 terminal 已经从 `sessions` 中消失，现有 cleanup 会清理 `terminalStateBySessionId`，项目 tab 不需要额外兜底。

### 2. 复用已有 ShimmerText

将项目名当前的：

```tsx
<span className="max-w-[160px] truncate">{project.name}</span>
```

改为 running 时包一层 `ShimmerText`：

```tsx
{
  isWorking ? (
    <ShimmerText
      className="max-w-[160px] truncate shimmer-invert"
      style={
        {
          "--shimmer-duration": "4000",
          "--shimmer-repeat-delay": "300",
        } as CSSProperties
      }
    >
      {project.name}
    </ShimmerText>
  ) : (
    <span className="max-w-[160px] truncate">{project.name}</span>
  );
}
```

约束：

- 复用文件顶部已经存在的 `ShimmerText` 与 `CSSProperties` import，不新增组件。
- 使用与 `TerminalSessionTab` 完全一致的 shimmer 参数，保证“样式也是一样”。
- `max-w-[160px] truncate` 必须保留，避免长项目名撑开顶部栏。
- 不改变右侧 bell/completion 圆点逻辑；running shimmer 只影响项目名文本。

### 3. 交互与视觉边界

需要保持：

- active 项目 tab 背景、边框、文字色不变。
- 非 active 项目 tab hover 效果不变。
- 拖拽排序时仍保留 `sortProps.isDragging` 样式。
- `title={project.name}` 仍用于长项目名 hover 查看完整名称。
- 新建项目按钮、Submit、Preview、History 等右侧操作不受影响。

## 验证

自动验证：

```bash
pnpm typecheck
```

预期：

- 命令退出码为 0。
- 没有 `CSSProperties`、`ShimmerText` 或 JSX 类型错误。

浏览器验证必须使用 `$playwright-cli`：

1. 启动项目现有开发服务。
2. 打开 Web 终端工作区。
3. 在某个项目下创建或打开两个终端。
4. 让其中一个终端进入 `agent_running`。
5. 验证该项目 tab 的项目名出现与 running 终端 tab 一致的 shimmer 文字效果。
6. 切到其它项目，验证没有 running agent 的项目 tab 不显示 shimmer。
7. 让该终端回到非 running 状态，验证项目名恢复普通文本。

失败判断：

- 只有单个终端 tab shimmer，项目 tab 不 shimmer。
- 只要项目下有一个终端 running，项目 tab 仍未 shimmer。
- 项目下所有终端都非 running 后，项目 tab 仍 shimmer。
- 项目名因 shimmer 后失去截断，导致顶部栏宽度异常或按钮被挤压。

## 非目标

- 不为 App 首页 `ProjectGroup` 添加 shimmer。
- 不把 `ShimmerText` 或 shimmer CSS 移入 `packages/common`。
- 不新增单测或 Vitest 覆盖。
- 不新增 `projectStatus`、`hasRunningAgent` 等后端/API 字段。
- 不改 `/ws/terminal`，也不新增终端详情 socket 事件。
