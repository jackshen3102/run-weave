# 随记架构与交付状态

随记采用独立单人服务，Swift App 与 Web/Runweave 桌面直接访问相同 HTTP API。
随记账号与 Runweave 节点身份分离，记录保存不依赖 Terminal、Backend、App Server 或模型。
AI 回顾使用已登录 Codex CLI；正式服务可配置独立的持久登录目录，运行与登录见部署入口。
云端回顾的实际部署与手机验收仍需单独取证。

```mermaid
flowchart LR
  I[Suiji SwiftUI App] --> H[独立 HTTP API]
  W[Web / Runweave 终端随记抽屉] --> H
  H --> S[记录 / 身份 / 附件业务服务]
  A[外部 Agent] --> M[独立凭据的十工具 MCP]
  M --> S
  H --> R[手动创建回顾任务]
  R --> C[本地已登录 Codex CLI]
  C --> O[每任务只读 MCP / 固定身份与范围]
  O --> S
  S --> P[(PostgreSQL 18)]
  S --> F[不可变附件存储]
  K[shared/suiji 协议] -.-> I
  K -.-> W
  K -.-> H
```

| 归属                   | 入口与约束                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP / 数据 / AI / MCP | [suiji-server](../../packages/suiji-server/README.md)，事务、版本、独立认证、模型进程生命周期                                                        |
| 原生 UI / 草稿         | [suiji-ios](../../packages/suiji-ios/README.md)，Swift Package + 薄宿主，Keychain 与原子草稿                                                         |
| Web UI / 草稿          | [页面](../../frontend/src/features/suiji/connection.tsx)、[客户端](../../frontend/src/services/suiji.ts)，终端抽屉、环境隔离、IndexedDB 与 Web Locks |
| 共享协议               | [shared/suiji](../../packages/shared/src/suiji/index.ts)，纯 TS 合同与限额，无运行时驱动                                                             |
| 部署与恢复             | [deploy/suiji](../../deploy/suiji/README.md)，独立产物、追加迁移、停写备份、空目标恢复                                                               |

## 桌面交互与账户

桌面只从终端右上角打开[随记抽屉](../../frontend/src/features/suiji/drawer.tsx)，不创建独立窗口。
记录、待办、回收站、AI 与手机保持相同结构；详情、编辑和附件在抽屉内导航。
关闭抽屉保留当前页面和草稿，终端切换不重建随记会话。原生内嵌浏览器在抽屉打开时隐藏，关闭后恢复。

列表与详情正文的普通链接点击通过[浏览器装配层](../../frontend/src/features/suiji/browser-navigation.ts)
收起抽屉，在当前 Browser Profile 新建分组标签并激活面板；重新打开随记仍保留原页面。
页面不注入随记凭据，网站身份沿用所选 Browser Profile。失败显示主动重试/外部打开入口，
迟到结果不抢占已切换的账户或界面。纯 Web 保留原生新标签行为；缺少创建标签能力的旧桌面壳走外部打开。

账户固定为正式和开发两套，切换不注销另一环境。桌面通过窄 IPC 访问
[主进程安全存储](../../electron/src/desktop/suiji-storage.ts)：账号、密码和会话一起由 Electron
异步 safeStorage 加密，密文以原子替换方式写入稳定 userData 目录，不依赖 renderer origin 或构建目录。
桌面更新须保持应用身份、签名和 userData 稳定。Web 只保存非敏感账户配置，令牌仍限当前标签页，不持久保存密码。

打开时恢复会话，访问令牌过期后续期；刷新令牌失效时以保存的密码重新认证，并核验原 server/owner 身份。
网络故障保留凭据；主动退出先取消旧请求，再清除当前环境密码和会话，草稿保留。
开发草稿额外按环境隔离；正式草稿沿用旧的 endpoint/serverId/ownerId 键。
认证恢复不自动重发业务写操作，保存结果未知时仍由用户手动确认。

## 一致性边界

- 正文与当前附件通过一个 PATCH 提交。记录、关系、完整修订及幂等结果共用同一 pg client 事务。
- 幂等键按 owner 唯一，摘要包含操作、目标和完整输入。成功重放返回原结果；失败事务整体回滚。
- 待办支持 open → done 或 archived，以及 done → open 撤销完成；状态变化保留记录身份、正文和附件。archived 不可恢复，再次想做新建独立记录。
- 文件先落盘同步与原子改名，再登记元数据。首次绑定后不能被其他记录复用；历史引用保留。
- 草稿按端点及 server/owner 身份隔离。本机落盘与远端保存分别反馈；未知结果冻结并手动重试。
- 业务写操作没有联网、前台或登录自动重发；只读请求最多一次认证恢复重试。
- 回顾没有写工具，引用必须匹配本次读取版本和逐字原文。用户手动保存回答才创建新记录，已有草稿不被预填覆盖。
- 当前 AI 以模型扩展关键词检索，不含 embedding/pgvector、附件全文索引、外链采集或跨会话聊天存储。

## 当前验证范围

以下为 2026-09-07 的本地分层验收证据，云端生产范围尚未完成。

| 范围             | 结果与合同                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 服务数据         | [20 条](../testing/suiji/service-records.testplan.yaml)通过，真实 PostgreSQL 18.6、HTTP、文件与受控故障                                               |
| 外部 MCP         | [13 条](../testing/suiji/mcp-agent.testplan.yaml)通过，含真实 Codex CLI 读改写与独立 HTTP 读回                                                        |
| Web / 桌面录入   | [12 条](../testing/suiji/web-capture.testplan.yaml)通过，实际 Beta 独立窗口和同一构建的 HTTP 页面，含附件、断线、草稿、冲突、身份、多标签页及窗口重开 |
| 本地 AI          | [12 条](../testing/suiji/ai-review.testplan.yaml)通过，真实 Codex 发问、追问、范围与只读验证；非法引用、慢进程等使用明确的故障注入                    |
| Swift 构建 / DTO | Debug、Release Simulator 构建通过；Debug 已签名安装并启动于 iPhone 17；真实 HTTP 的 63 条记录及已完成 AI 回答通过生产 Codable 字段回编码核对          |
| 原生体验         | [16 条本地用例](../testing/suiji/ios-capture.testplan.yaml)通过，含草稿、附件、记录与状态幂等、冲突、身份、键盘与大字号；015 云端独立网络延期         |
| 独立部署         | [前 3 条](../testing/suiji/deployment-recovery.testplan.yaml)通过；异机备份及后续恢复未执行，云部署与恢复按用户要求延期                               |
| 静态门禁         | 服务与前端 typecheck/lint、服务 build、shared typecheck、架构边界通过；不能替代上述 UI 验收                                                           |

类型切换按钮和完成后自动关窗目前仅通过静态检查，尚未进行新一轮 Web UI 验收。

脱敏执行结果、CLI 工具事件与构建日志放根 `.runweave/suiji/`，本地流程在 `local-flow/`，真机准备在 `physical/`；
不将运行凭据、数据库、正文、附件或一次性截图加入 Git。
具体运行方式以包入口为准；后续交付边界见下文，不沿用旧计划中已被本地原生验收覆盖的阻塞结论。

## 后续交付边界

- 云端独立网络的手机验收、异机备份、空目标恢复与正式发布仍待取证，沿用上表现有测试计划。
  首次发布前需明确目标主机、域名/TLS、异机备份位置、RPO/RTO 与允许停写窗口；
  配置和发布预检以[部署入口](../../deploy/suiji/README.md)为准。
- embedding/pgvector、中文召回评测、聊天持久化与私有文档连接器尚未交付；当前关键词回顾不代表这些能力。
- 原生、Web 和云端分别报告验收结果。本地通过不能替代云端发布与恢复演练，后续 UI 改动也不继承旧构建的通过状态。

## 回收站

记录通过 `deleted_at` 保留删除标记，删除和恢复使用既有版本与幂等事务，不改变待办状态。
Web 与原生 iOS 提供回收站列表、删除确认和恢复入口；普通列表与 Agent/AI 检索排除回收站。
正文、附件和历史修订保留，不提供永久清空或定时清理。回收站最初引入于 schema 3；当前部署需迁移至 schema 6，见[部署入口](../../deploy/suiji/README.md#跟进版本迁移)。

## 跟进与外部 Agent 成果

记录保留原始正文，跟进独立追加到 record_followups；父记录版本和完成状态不随追加改变。原文与跟进附件分别关联同一个父记录的不可变对象。HTTP 和 MCP 复用 FollowupService 与既有幂等事务；多 Agent 追加保留各自成果，不引入调度、审批或执行状态。

Web/桌面与 iOS 提供跟进、成果阅读、复制交接；[随记 Skill](../../plugins/toolkit/skills/suiji/SKILL.md) 可在其他电脑读写同一服务，只有最终成功成果回写，用户确认后才由 Agent 完成待办。跟进里的用户补充不会触发 Agent。

服务接口与版本合同以 [服务 README](../../packages/suiji-server/README.md#跟进与最终成果) 为准；当前实现需要 schema 6，线上启用情况及行为通过范围需要独立验证。

### 验收入口与保留缺口

跟进按 [服务](../testing/suiji/followups-service.testplan.yaml)、[客户端](../testing/suiji/followups-clients.testplan.yaml)
和 [Agent](../testing/suiji/followups-agent.testplan.yaml) 分层取证。迁移的 2026-09-22 历史记录仍有两项
环境阻塞：SUIJIFUA-011 需要第二台实际电脑与 HTTPS 配置；SUIJIFUS-020 需要完整异机部署恢复。
本机数据库恢复、模拟器或真实 Agent 的本机执行不能替代它们，也不能据此宣称正式服务已发布。

浏览器复用分别按 [桌面](../testing/suiji/desktop-browser-reuse.testplan.yaml) 与
[iOS](../testing/suiji/ios-browser-reuse.testplan.yaml) 验收。2026-09-17 记录中的桌面故障/延迟、旧壳、
双 Profile 与纯 Web 操作，以及原生业务草稿、来源失效、双 App 身份、选区/大字号、真实 SSO
和飞书客户端交接尚无完整矩阵通过结论。共享实现以
[Swift 浏览器包](../../packages/browser-ios/README.md) 为准，两个宿主仍需分别取证。
上述为删除过程材料时保留的证据边界，本轮未重跑这些用例。

MCP 设备凭据存储于 schema 6 的独立凭据表，各设备可单独撤销。注册和撤销无需重启；
旧 token 通过摘要与原期限导入保留，服务启动不自动恢复旧配置。管理和迁移见[服务入口](../../packages/suiji-server/README.md#外部-agent-mcp)。
