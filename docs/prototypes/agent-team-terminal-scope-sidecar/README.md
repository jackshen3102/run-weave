# Agent Team Terminal Scope Sidecar

Agent Team Sidecar 的最小可运行 HTML 原型，用于冻结当前 Terminal / Run 身份行的呈现。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/agent-team-terminal-scope-sidecar
```

打开 `http://127.0.0.1:6188/`。

## 原型简报

- 目标：切换 Sidecar 工具时持续显示当前 Terminal，并在 Agent Team 工具内显示该 Terminal 的当前 Run 与生命周期状态。
- 用户动作：在 Preview、Browser、Agent Team 间切换。
- 主要用户：在 Terminal Workspace 中观察 Agent Team Run 的开发者。
- 影响模块：`frontend/src/components/terminal/terminal-agent-team-panel.tsx`。
- 关键状态：当前 Terminal、当前 Run、Run 执行状态。
- 非目标：不修改 Preview、Browser、普通 Panel、用户 pane 或后端协议。

## 验证点

- Agent Team 首屏可见当前 Terminal、Run 和“执行中”状态。
- 切到 Preview / Browser 再返回时，Terminal / Run 身份不变化。
- 页面不包含原型辅助控件。

## 功能分类

### 产品核心功能

| 元素 / 行为           | 最终产品是否需要 | 产品价值                          | 备注                         |
| --------------------- | ---------------- | --------------------------------- | ---------------------------- |
| Terminal / Run 身份行 | 是               | 让 Sidecar 的数据作用域可直接核对 | 使用既有前端属性，不新增协议 |
| 生命周期状态徽标      | 是               | 显示当前 Run 控制状态             | 复用现有状态展示             |

### 原型辅助功能

无。

## 冻结记录

- 最终采用的交互：Agent Team 内容头部显示 `Terminal <short id> · Run <short id>`，完整值放在 title 与 DOM data 属性中。
- 放弃的方向：不在全局 Sidecar 工具栏重复 Run 身份，避免影响 Preview / Browser。
- 产品核心功能清单是否已确认：是。
- 原型辅助功能清单是否已确认：是，无辅助功能。
- 最终截图：`prototype-preview.png`。
- 冻结时间：2026-07-19。

## 边界

- 原型不连接真实 API，不证明异步请求已经正确隔离。
- 原型不导入生产源码；真实实现必须额外阻止旧 Terminal 请求覆盖当前状态。

## 实施计划衔接

- 产品行为：Sidecar 只提交当前 scope 的异步结果，并显式呈现 scope。
- 前端落点：`terminal-agent-team-panel.tsx`。
- 协议 / 后端变化：无。
- 验收：typecheck、lint；真实页面切换由 behavior_verify worker 使用 Playwright 验证。
