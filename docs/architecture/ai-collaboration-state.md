# AI 协作状态

说明 Runweave 内部人机协作状态的单一迁移语义。

目标只有一个：

- 路由层、AI bridge 代理层、viewer websocket 层都只发事件
- `SessionManager` 负责把事件解释成 `CollaborationState`

## 状态字段

当前协作状态由这些字段组成：

- `controlOwner`
- `aiStatus`
- `collaborationTabId`
- `aiBridgeIssuedAt`
- `aiBridgeExpiresAt`
- `aiLastAction`
- `aiLastError`

其中真正决定协作语义的是：

- `controlOwner`: `none | human | ai`
- `aiStatus`: `idle | attached | running | error`

## 事件入口

`SessionManager` 目前提供的显式事件 API：

- `onAiBridgeIssued`
- `onAiBridgeConnected`
- `onAiMessage`
- `onAiBridgeError`
- `onAiBridgeDisconnected`
- `onAiBridgeRevoked`
- `onCollaborationTabSelected`
- `onHumanInput`

## 迁移表

| 事件                                | 典型来源                            | 主要结果                                                                |
| ----------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `onAiBridgeIssued`                  | `POST /api/session/:id/ai-bridge`   | `aiStatus -> attached`，记录 `issuedAt`，可同步 `collaborationTabId`    |
| `onAiBridgeConnected`               | AI bridge websocket 上游可用        | 保持 `attached`，清理 `aiLastError`                                     |
| `onAiMessage(method)`               | AI 发送 CDP method                  | `controlOwner -> ai`，`aiStatus -> running`，记录 `aiLastAction`        |
| `onAiBridgeError(error)`            | client/upstream/setup error         | `aiStatus -> error`，记录 `aiLastError`                                 |
| `onAiBridgeDisconnected`            | AI bridge 最后一个连接断开          | `controlOwner -> none`，`aiStatus -> idle`，清空 bridge 时间字段        |
| `onAiBridgeRevoked`                 | `DELETE /api/session/:id/ai-bridge` | `controlOwner -> none`，`aiStatus -> idle`，并清理最后 action/error     |
| `onCollaborationTabSelected(tabId)` | viewer active tab 变化              | 仅更新 `collaborationTabId`                                             |
| `onHumanInput`                      | viewer 鼠标/键盘/导航输入           | 如果 AI 正在 `attached/running`，不改状态；否则 `controlOwner -> human` |

## 设计约束

这套状态机当前刻意保留两个约束：

- 人和 AI 可以同时操作，不做互斥接管
- `onHumanInput` 不会在 AI 已经 `attached/running` 时覆盖 AI 状态

这对应当前产品语义：

- viewer 不因为人的输入而断开 AI bridge
- AI 只在真正发出 CDP method 时进入 `running`

## 排查原则

如果后续出现协作状态问题，先检查：

1. 某个调用方是否绕过 `SessionManager` 直接 patch `CollaborationState`
2. 某个事件是否在错误时机触发
3. 某个断开路径是否漏发 `onAiBridgeDisconnected` 或 `onAiBridgeError`

不要在路由层或 websocket 层追加临时 patch 逻辑来“修状态”。
