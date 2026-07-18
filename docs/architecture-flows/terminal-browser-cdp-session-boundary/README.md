# Terminal Browser Scoped CDP Control Boundary

这份架构说明回答一个问题：**在不把 Terminal Browser CDP Proxy 扩展成完整 Chromium CDP 的前提下，Agent 如何安全地控制某个 Tab 的 displayScale？**

## 结论

- “一条连接内，一个 target 只有一个 primary proxy session”是有意限制，不是待修的通用 CDP 缺口。
- Agent displayScale 使用 scoped root connection 上的 `Target.attachToTarget`，再用返回的 primary target session 调用 `Runweave.*DisplayScale`。
- Playwright 连接负责页面、DOM、viewport、输入和截图；独立 raw CDP connection 负责 Runweave custom domain。两者连接同一个 scoped endpoint，但不共享逻辑 session 身份。
- 不支持 Playwright `browserContext.newCDPSession(page)`，也不在 browser session 内创建第二个 target session。
- Browser group scoped endpoint 是可见性边界；custom command 自身不接受 `targetId`，避免 attach 后再次声明目标。

## 启动

```bash
python3 -m http.server 6196 --directory docs/architecture-flows/terminal-browser-cdp-session-boundary
```

打开 `http://127.0.0.1:6196/`。

## 支持链路

```text
Dev Session terminal-browser scoped endpoint
  ├─ Playwright connection
  │    └─ page API: DOM / viewport / input / screenshot
  │
  └─ raw CDP root connection
       ├─ Target.getTargets
       ├─ Target.attachToTarget(targetId) -> primary sessionId
       └─ sessionId + Runweave.get/set/resetDisplayScale
```

每条 WebSocket connection 都有独立 `CdpSessionManager`：

```text
connection A: target A -> primary session A1
connection B: target A -> primary session A2
physical layer: target A -> shared webContents.debugger attachment
```

限制针对的是“同一 connection、同一 target 不创建第二个 logical session”，不是禁止多个受控 connection 共享物理 debugger。

## 权限边界

1. scoped endpoint 的 `groupId` 决定 `Target.getTargets` 能看到哪些 target。
2. root `Target.attachToTarget` 只能附着当前 scoped group 的 target。
3. 同 connection 重复 attach 同 target 返回相同 primary sessionId。
4. `Runweave.*DisplayScale` 只接受 target sessionId；root/browser session 调用失败。
5. command params 不接受 `targetId`；非法 factor、额外字段、未知 session 和关闭 target 均 fail closed。
6. connection close、target close 或显式 detach 释放该 connection 的 target attachment。

## Playwright 分工

Playwright public page API 继续作为产品行为验收面，但不承担 Runweave custom domain 的 session 创建：

- 使用：`attach --cdp=<scoped endpoint>`、page 选择、DOM、evaluate、locator、mouse、scroll、screenshot。
- 不使用：`page.context().newCDPSession(page)`。
- displayScale 改变由独立 raw primary target session 发起；随后回到 Playwright/desktop UI 验证实际页面结果。

## 测试映射

| Case    | 主要入口                                        | 关键边界                                   |
| ------- | ----------------------------------------------- | ------------------------------------------ |
| TBZ-001 | desktop 原生菜单                                | per-tab 状态与新 Tab 默认值                |
| TBZ-002 | raw scoped primary session + Playwright/UI      | attach 幂等、A/B 映射、跨 group 与非法调用 |
| TBZ-003 | raw displayScale + Playwright viewport          | 显示比例不改变逻辑 viewport                |
| TBZ-004 | raw displayScale + Playwright input             | CSS 坐标不补偿                             |
| TBZ-005 | raw displayScale + Playwright screenshot        | 自动化截图不包含显示缩放                   |
| TBZ-006 | raw connection 重建 + Playwright/device/desktop | 导航、重连、关闭与重启生命周期             |

## 代码源

- `electron/src/terminal-browser-cdp-proxy.ts`
- `electron/src/terminal-browser-cdp-proxy-messages.ts`
- `electron/src/terminal-browser-cdp-proxy-session.ts`
- `electron/src/terminal-browser-cdp-proxy-session-messages.ts`
- `electron/src/terminal-browser-display-scale.ts`
- `docs/plans/2026-07-18-terminal-browser-per-tab-display-scale.md`
- `docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`

## 边界

- 本页说明受支持架构，不证明测试已经全部通过。
- 不把 unsupported nested CDPSession 当作产品缺陷，也不为它扩大 CDP 权限。
- 任何未来要求同 target 多 session 的需求，都必须作为独立 CDP Proxy 能力评审，不能从 displayScale 功能顺带引入。
