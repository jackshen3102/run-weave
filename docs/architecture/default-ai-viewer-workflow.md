# 默认 AI Viewer 工作流

说明当前项目里“默认 AI viewer + AI bridge + 外部自动化工具附着”的产品语义与调用顺序。

## 目标

这条链路解决两个问题：

1. 不要每次都新建一个 viewer 会话给 AI 用
2. 让外部工具复用 viewer 创建的浏览器，而不是自己再起一个独立 Playwright 浏览器

## 核心对象

### 1. Default AI Viewer

默认 AI viewer 是一个会被后台优先复用的浏览器会话。

当前约束：

- 只允许 `launch` 会话承担
- 必须是可恢复的持久会话
- 同一时间最多一个

这意味着：

- `connect-cdp` 会话可以被手动打开和调试
- 但不能被标记成默认 AI viewer

### 2. AI Bridge

AI bridge 是一个 session 级 CDP bridge。

用途：

- 把 viewer 创建的浏览器暴露给外部工具
- 典型消费者是 `playwright-cli` 或直接使用 `chromium.connectOverCDP(...)` 的脚本

## 标准顺序

### 1. 登录后端

```http
POST /api/auth/login
```

拿到 `accessToken`。

### 2. 获取默认 AI viewer

优先查：

```http
GET /api/session/ai-default
Authorization: Bearer <accessToken>
```

如果不存在：

```http
POST /api/session/ai-default/ensure
Authorization: Bearer <accessToken>
Content-Type: application/json
```

这个接口会：

- 复用现有默认 AI viewer，如果已经存在
- 否则创建一个新的 `launch` 会话并标记为默认

### 3. 申请 AI bridge

```http
POST /api/session/:id/ai-bridge
Authorization: Bearer <accessToken>
Content-Type: application/json
```

返回：

```json
{
  "bridgeUrl": "ws://127.0.0.1:5003/ws/ai-bridge?sessionId=<session-id>"
}
```

### 4. 外部工具附着

后续页面操作不属于 `browser-viewer` API，而属于 CDP 消费方。

例如：

- `playwright-cli`
- Playwright 脚本
- 其他 CDP 工具

Playwright 代码形态：

```ts
const browser = await chromium.connectOverCDP(bridgeUrl);
```

## Viewer UI 对应关系

首页当前有三类入口：

1. `Open Default AI Viewer`
   - 直接走 `ensure`，然后进入默认 session 的 viewer 页面

2. `Default AI Viewer`
   - 只对 `launch` 会话可见
   - 用于设置或取消默认 AI viewer

3. `Set Default AI Viewer / Unset Default AI Viewer`
   - 当前只出现在 `launch` 会话卡片上

## 协作语义

默认 AI viewer 只是“优先复用哪个 session”。

它不等于：

- 独占控制权
- 自动接管 viewer
- 自动创建 AI bridge

AI 真正开始操作，要等：

1. session 已存在
2. `ai-bridge` 已申请
3. 外部工具已通过 bridge 附着

协作状态迁移规则见：

- `architecture/ai-collaboration-state.md`

## 当前限制

- 默认 AI viewer 只支持持久 `launch` 会话
- `connect-cdp` 会话不能设为默认
- `/ws/ai-bridge` 当前没有短时 ticket 约束，桥接授权由前置 HTTP API 决定

## 推荐使用场景

- E2E 测试要和 viewer 共用同一个浏览器
- 疑难问题排查时，需要一边看 viewer 一边让外部工具操作
- 明确要求“不要自己起一个 Playwright 浏览器”的任务

## 不推荐的理解

不要把“默认 AI viewer”理解成：

- 全局永远绑定某个 CDP 浏览器
- 任何时候都自动存在 bridge
- 一切 AI 操作都通过 viewer websocket 完成

当前实现里，它只是一个稳定的 session 复用入口。
