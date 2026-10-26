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

Backend 自身报告 process、Activity store、App Server event consumer、
Evolution maintenance 与 Workspace Services。App Server 报告 process、Event Center、Cloud Sync 和
Thread reconciler。Feishu Bridge 报告配置、单实例 lease、Lark WebSocket 和 Backend auth。Electron
报告主进程、packaged Backend、LAN 地址、CDP Proxy、Companion 和各 Browser Profile 的 Whistle。

Desktop、快照分享 Host、推送网关和随记由各自 owner 每 5 秒将报告原子写入当前实例的私有
`runtime-status/` 目录，Backend 只读聚合，因此 CLI 无需依赖 renderer 存活。正常关闭发布停用快照；
异常退出、停止上报超过有效期会保留最后已知子项并明确来源过期。RemoteDesk 原生 Host 使用同用户
私有目录独立上报监听、权限和产物身份，不暴露配对凭据，也不启动屏幕采集。旧版尚未上报时明确提示缺失，
不把它当作正常。独立服务的监听/存储检查不能代替 APNs 收取、云端访问或手机控制验收。

Research MCP 报告本机进程与发布身份、隧道客户端/控制面状态、真实鉴权 Activity 读取及最近成功工具调用。它由用户级 launchd 独立管理，不属于 Backend/Electron 子进程；Backend 按当前实例安装身份从 loopback 状态接口取得报告。已启用而来源不可达先进入 30 秒恢复窗口，之后作为关键异常；保留最后子项并阻断，未安装和显式停用分别表达。仅同一 Backend 进程实例的 Activity 报告绑定 Backend/Activity store 依赖。隧道 ready 不能代替实际云端工具调用，最近工具调用也不假定来自云端。

## 过期与恢复

Activity worker 在首次初始化成功后发生退出、错误或请求超时，Backend 会拒绝该轮请求，
等待旧 worker 退出后在同一 store 上重建；失败按 1–30 秒指数退避，稳定运行 30 秒后重置。
恢复期间 Activity 状态为 `unhealthy`，ready 成功后恢复 `healthy`；结果不确定的请求不自动重放。
首次初始化失败不启动后台重建，关闭会取消重建。生命周期细则见
[Backend 规则](../../backend/AGENTS.md#验证)，故障验证见
[恢复验证入口](../../scripts/verify/recovery/README.md)。

- owner 依据既有重试、宽限和新鲜度窗口产出 `healthy`、`recovering` 或 `unhealthy`。
- Backend 启动时未能连接 App Server，若存在连接配置、安装记录或发现记录，事件消费者必须报告
  `unhealthy`；只有没有配置时才报告 `unconfigured`，显式禁用报告 `disabled`。不能用消费者实例
  缺失推断“未配置”。
- Backend 使用服务端接收时间和 `validForMs` 判断外部报告过期，不信任客户端时钟。
- 来源过期时保留最后已知子项，增加一个来源级 `unhealthy` 根因，并把子项标记为 `blocked`。
- `dependsOn` 的异常或受阻状态会传递为 `blocked`，避免连锁故障重复计数。
- Workspace Service 直接投影既有 `stopped/starting/ready/stopping/failed`，不创建第二套进程探测。
- 周期任务按自己最近完成时间判断；Evolution 有活动 run 时改用 lease heartbeat 判断。

右上角入口按关注级别显示：关键能力故障显示红色“异常”，飞书这类可选能力故障、
已启用能力的配置缺失、状态未上报或版本不支持显示黄色 `Warning`。异常和 Warning 分别计数，
同时出现时红色优先；能力域内部分项目正常也不能掩盖其他已启用项目的配置缺失。
先按实际启用意图决定是否检查：没有部署配置的独立服务、未安装启用的调查 MCP、未启用的调查隧道、
未启用的飞书、未开启的 RemoteDesk 共享均报告 `disabled`，不计为 Warning。独立服务已有部分配置但不完整时
仍视为需要检查，不能用缺少必填字段掩盖错误。RemoteDesk 仅安装 App 不表示启用共享；键鼠控制未授权给设备时，
辅助功能权限不参与告警。已停用的项不受上游异常或报告过期影响；重新启用后恢复原有检查、失联和过期告警。
首次加载已有关键异常也会提示，同一异常持续期间不重复弹出；
Warning 仅在入口和面板展示，不发送系统错误通知。原因和影响在状态面板中查看。

Web 的运行异常与隧道提示在左下角同一区域纵向排列，超出可用高度时可滚动，
各提示保持独立操作入口。提示区域参与终端遮挡检测，避免点击提示时把输入焦点抢回终端。

Backend 已启用飞书但未收到 Bridge 报告时表达“尚未收到状态、无法判断”；未启用时忽略其历史报告。
关注级别独立于 owner 上报的生命周期状态，不修改协议状态枚举。

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

## Agent 消费

`GET /api/runtime-status` 在原始快照上附加 management，复用共享能力聚合并提供候选配置关联与只读诊断操作。
`rw status --json` 与 Research MCP 可消费该接口；来源覆盖、配置生效及业务验证边界见
[服务管理](../cli/service-management.md)。新增字段为兼容性扩展，不修改 owner 报告或健康判断。

## 客户端消费与入口

[RuntimeStatusEntry](../../frontend/src/components/runtime-status-entry.tsx) 展示整体状态与异常能力域数量，点击打开状态面板。
当前入口不直接显示连接 URL；地址从面板的节点信息查看和复制。组件布局不放入领域词汇表。

面板的「组件版本」集中展示 Backend、App Server、Desktop、CLI、飞书 Bridge 和调查 MCP；
当前 Web 页面版本单独展示，避免与远端节点混淆。版本信息通过既有 fact 合同的
`runtime-version.*` 标识上报，包含产品版本、构建标识、源码提交、未提交改动标记和构建时间。
旧服务没有上报时显示「未上报」；过期来源保留的版本只代表最近上报，不证明进程仍在运行。
源码直接运行的服务可显示 `-dev` 版本，缺失的构建信息不从当前 checkout 推测。

构建入口通过 [构建身份工具](../../scripts/lib/build-info.mjs) 固化版本信息；CLI 沿用不可变发布目录内的
元数据，避免构建时间改变可执行内容哈希。Backend 查询本机 PATH 中 `rw version --json` 的版本，
最多缓存 60 秒；启动时安装的实例绑定 CLI 会优先进入该进程的 PATH，并设置 `RUNWEAVE_CLI_BIN`。
绑定安装同时保留可执行文件旁的发布/构建元数据，不能用当前源码目录替代运行版本。
该结果属于 Backend 所在节点，不是远程客户端的 CLI。
版本读取失败不影响服务健康计数。各 owner 还通过 `runtime-installation.*` fact 比较当前运行身份和对应
已安装产物；不一致时独立提示需要重启，不覆盖运行健康事实。比较优先使用产物内容摘要，其次构建 ID，
身份缺失或来源失效时无法确认。不可变发布目录按该 owner 的 current 指针比较，不能拿当前 checkout 或
其他分支的最新构建代替安装目标。本能力不比较源码差异、不判断云端是否最新，也不自动更新组件。

原生 iOS 从“设置 → 组件版本”或当前电脑的连接详情进入，使用同一受认证接口读取当前节点版本，
手机 App 的安装版本单独从本机 Bundle 与 `BuildIdentity.json` 展示，不推测远端 Web/Desktop 版本。
仅打开页面、回到前台或手动刷新时查询；切换连接或退出登录清除原节点快照，旧 Backend 不支持时明确提示。

### 版本递增规则

Backend、App Server、Web、Desktop 和随包 CLI、Research MCP 的构建入口使用
[产物版本工具](../../scripts/release/component-artifact.mjs)：成功构建后按组件和产物内容分配版本。
相同产物重建复用原版本，运行代码、资源或依赖变化时递增次版本（例如 `0.1.0 → 0.2.0`）；
回退到曾发布的相同产物时恢复其原版本。只改构建时间、源码提交或调试 sourcemap 不递增。
构建标识仍记录本次构建，版本号不代表是否包含最新源码；未发布的源码编辑、进程重启不会分配版本。
运行中显示的版本来自已安装并启动的产物，构建完成不等于服务已更新。

分配记录保存在构建机器的 `~/.runweave/component-releases/`，跨 worktree 共用文件锁和追加历史；
Stable/Beta Web、完整 Desktop App、Electron/Node 运行时分别记账。
`RUNWEAVE_COMPONENT_RELEASE_REGISTRY` 可指定持久化发布目录，用于隔离验证或固定发布机。
发布记录必须随构建环境保留；不同机器的独立目录不提供全局唯一版本保证。
源码 `package.json` 是初始版本下限，不在每次构建时修改或自动提交。后续安装失败可能留下版本间隔。

全局 CLI 沿用 npm prefix 下已有的不可变发布目录和安装锁；飞书 Bridge 随所属 CLI 发布。
完整 Desktop App 的版本覆盖随包运行时，runtime 热更新只改变对应组件版本，不改变已安装 App 版本。
iOS 沿用独立更新入口的产品版本和构建号递增规则。

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
