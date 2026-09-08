# Runtime Status 架构

Runtime Status 是当前运行依赖的只读状态协议。每个运行时只判断自己拥有的生命周期，Backend 负责
把报告绑定到当前节点并转发给受认证客户端，不从日志或端口重新推导其他 owner 的健康状态。

## 协议与状态流

跨运行时 DTO 和纯聚合规则由 `@runweave/shared/runtime-status` 提供。报告包含协议版本、目标节点、
来源、观察时间、有效期和稳定状态项。状态项只能携带脱敏的 `address`、`port`、`text`、`time`
fact，以及应用内绝对导航路径。

```text
App Server GET /runtime-status ─┐
                               ├─ Backend registry ─ GET /api/runtime-status
Feishu Bridge authenticated PUT┘

Electron lifecycle ─ narrow preload IPC ─ renderer
```

Backend 自身报告 process、Activity store、App Server event consumer、Agent Team watchdog、
Evolution maintenance 与 Workspace Services。App Server 报告 process、Event Center、Cloud Sync 和
Thread reconciler。Feishu Bridge 报告配置、单实例 lease、Lark WebSocket 和 Backend auth。Electron
报告主进程、packaged Backend、LAN 地址、CDP Proxy、Companion 和各 Browser Profile 的 Whistle。

## 过期与恢复

- owner 依据既有重试、宽限和新鲜度窗口产出 `healthy`、`recovering` 或 `unhealthy`。
- Backend 启动时未能连接 App Server，若存在连接配置、安装记录或发现记录，事件消费者必须报告
  `unhealthy`；只有没有配置时才报告 `unconfigured`，显式禁用报告 `disabled`。不能用消费者实例
  缺失推断“未配置”。
- Backend 使用服务端接收时间和 `validForMs` 判断外部报告过期，不信任客户端时钟。
- 来源过期时保留最后已知子项，增加一个来源级 `unhealthy` 根因，并把子项标记为 `blocked`。
- `dependsOn` 的异常或受阻状态会传递为 `blocked`，避免连锁故障重复计数。
- Workspace Service 直接投影既有 `stopped/starting/ready/stopping/failed`，不创建第二套进程探测。
- 周期任务按自己最近完成时间判断；Evolution 有活动 run 时改用 lease heartbeat 判断。

右上角入口在存在异常能力域时显示红色“异常”和数量；首次加载已有异常也会提示，同一异常持续期间
不重复弹出。原因和影响在状态面板中查看。

## 安全边界

- `GET /api/runtime-status` 和 `PUT /api/runtime-status/reports/feishu-bridge` 使用 Backend 现有
  Bearer Token。PUT 只允许 `feishu-bridge` 来源、最多 32 项和 64 KiB body，并限制枚举、字符串、
  TTL 与导航路径。
- App Server `GET /runtime-status` 使用 App Server 自己的 Bearer Token。
- Electron `getRuntimeStatusReport` 和系统通知 IPC 只接受主窗口 renderer；通知内容有长度和 URL/路径
  限制，前台窗口不产生系统通知。
- 报告不包含凭证、聊天或 Terminal 内容、完整命令、cwd、环境变量和错误 stack。
- 状态检查不发送飞书消息、不写 Terminal，也不启动、停止或重启业务服务。

扩展状态项时，先在真实 owner 中复用已有生命周期证据，再返回共享 DTO；不要在消费者中复制状态机。

## 客户端消费与入口

[RuntimeStatusEntry](../../frontend/src/components/runtime-status-entry.tsx) 展示整体状态与异常能力域数量，点击打开状态面板。
当前入口不直接显示连接 URL；地址从面板的节点信息查看和复制。组件布局不放入领域词汇表。

- 本机与当前连接用相同的节点/能力域模型；同节点身份优先按 `serviceInstanceId` 合并，URL 仅作缺失身份时的回退。
- Frontend 自己的 HTTP、Terminal WS 与事件连接状态也是报告来源；当前报告及面板状态见
  [Frontend registry](../../frontend/src/features/runtime-status/registry.ts) 和 [Provider](../../frontend/src/features/runtime-status/provider.tsx)。
- HTTP 404、缺少旧版本 IPC 或不支持的协议能力应表达为 `unsupported`，不因诊断能力缺失中断业务。
- 后台页面的轮询不承诺硬实时；重新可见时刷新。失败持续时间与连接重建次数不同，
  重建连接不能代替真实成功证据清除故障窗口。
- CPU/内存由 System Monitor 展示，不参与运行状态异常计数。地址可复制不等于对另一台设备可达；
  无可用 LAN 地址时不能把 loopback 宣称为手机连接入口。

设计取舍保留在 [ADR-0001](../adr/0001-owner-reported-runtime-status.md) 和
[ADR-0002](../adr/0002-runtime-status-registry.md)。验收合同为
[Providers](../testing/platform/runtime-status-providers.testplan.yaml) 与
[状态面板](../testing/runbooks/runtime-status-panel.testplan.yaml)；本轮文档整理未重跑历史验收。
