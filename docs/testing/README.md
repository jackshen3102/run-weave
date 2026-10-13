# 测试与验收

本目录保存**测试合同和操作规则**，不是单元测试目录。新增或重写测试计划只使用
`*.testplan.yaml`，每个文件最多 20 个 case。

## 先读规则

| 任务                            | 文档                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| YAML schema、Case ID 与拆分规则 | [test-plan-format.md](./test-plan-format.md)                            |
| 自动化、脚本和人工证据分层      | [layers.md](./layers.md)                                                |
| Activity 与事件日志恢复故障验证 | [恢复验证入口](../../scripts/verify/recovery/README.md)                 |
| 按改动类型选择命令              | [command-matrix.md](./command-matrix.md)                                |
| iOS 日常交互排查与修复验收      | [agent-device 技能](../../plugins/toolkit/skills/agent-device/SKILL.md) |

## 按能力找计划

| 目录                                             | 范围                                                 |
| ------------------------------------------------ | ---------------------------------------------------- |
| [`agent-team/`](./agent-team/)                   | Agent Team 生命周期、执行、恢复、配置与干预          |
| [`agent-evaluation/`](./agent-evaluation/)       | 个人工作流决策重放与真实动作评测                     |
| [`app/`](./app/)                                 | 原生 iOS、App Server 与设备连接                      |
| [`archive/`](./archive/)                         | 已被新版行为取代的历史验收合同                       |
| [`architecture/`](./architecture/)               | 跨运行时架构与 Activity 数据底座                     |
| [`analytics/`](./analytics/)                     | Web 纯无埋点接入、行为回放与采集边界验收             |
| [`browser/`](./browser/)                         | 浏览器和原型画廊                                     |
| [`evolution/`](./evolution/)                     | Agent Self-Evolution                                 |
| [`platform/`](./platform/)                       | Dev Session、Beta Pool、桌面 companion 与 CLI 控制面 |
| [`remote-desktop/`](./remote-desktop/)           | Mac LAN 远控会话、输入媒体、安全权限与来源           |
| [`runbooks/`](./runbooks/)                       | 可重复执行的人工操作流程                             |
| [`skills/`](./skills/)                           | Toolkit 技能的真实输入、输出与验收边界               |
| [`scheduled-tasks/`](./scheduled-tasks/)         | 定时任务调度、后台执行、Web 管理与普通终端恢复       |
| [`background-commands/`](./background-commands/) | 快捷指令后台运行、来源归属、通知与恢复               |
| [`suiji/`](./suiji/)                             | 随记服务、MCP、Web 录入、AI 回顾、原生体验与部署恢复 |
| [`terminal/`](./terminal/)                       | Terminal、Browser、tmux、MCP 与 Worktree Context     |

开发资源的当前快照、认证与手动释放使用[专项验收计划](./platform/development-resources.testplan.yaml)，
原生 iOS 使用[手机专项计划](./app/ios-development-resources.testplan.yaml)，
产品边界见[开发资源合同](../architecture/development-resources.md)。

## 桌面全局设置与管理导航合同

桌面全局设置已接入现有领域组件，当前导航与作用域见
[全局设置](../../frontend/docs/global-settings.md)。
[桌面全局设置计划](./platform/desktop-global-settings.testplan.yaml)覆盖无搜索的全屏 10 页、原快捷图标、工作区保活、
独立设置目标、迟到响应隔离、草稿离开保护、路由回退及原生 Browser 让位与恢复。
[管理外壳计划](./platform/management-shell.testplan.yaml)另覆盖全部管理页面及深层详情的统一侧栏、
左上角唯一出口、会话目标准备和紧凑窗口；页面可达不等于业务验收通过。
设计对照见[第五版原型](../prototypes/global-settings/README.md)与
[18 个功能分区清单](../prototypes/global-settings/feature-preservation.md)；原型数据和模拟成功不能替代真实服务证据。

生产实现复用既有领域服务、配置存储与权限，不复制原型模拟逻辑。设置目标与工作区连接分离；
本台、账户和所选电脑分别保有归属。不得借此重构扩大配置 HTTP 允许列表、修改认证协议、
迁移 Browser 配置或调整原生 iOS 导航。保存、进程采用和跨端结果分别取证，未知结果先核对原请求。

SSH、手机登录、配置、模型、资源及运行状态还须执行各领域既有计划，不能用导航用例替代业务验收。
18 分区逐字段、操作、权限和异常状态有真实证据前，不移除旧功能入口；回滚不重置用户配置。
代码阶段拆分与原文件建议仅保留在
[历史实施计划](https://github.com/jackshen3102/run-weave/blob/aa0d9b7cc0e0cc5aa3cf04f27976c052a931d4f4/docs/plans/2026-10-12-desktop-global-settings.md)，
不作为当前实现事实。历史设置导航证据见[验收画廊](../prototypes/desktop-global-settings-acceptance-20261013/index.html)，
其中 DGS-001 至 DGS-007 的通过记录不代表 SSH、真机扫码、账户、密码修改、进程操作
或资源释放的完整领域矩阵已通过。本轮文档整理未重跑产品验收。

## 长任务监控有界上下文

[有界上下文计划](./terminal/task-supervision-bounded-context.testplan.yaml)覆盖热状态与历史档案分离、
原始来源回读、冷索引分片、预算限制、迁移及跨端按需读取；当前实现与升级边界见
[任务监控架构](../architecture/terminal-task-supervision.md)。全部用例的端到端记录、
进程终止故障注入、跨端真实业务流和旧分类策略逐项对照仍需独立取证。
历史合成数据、受控接口和部分分类语料的验证不能替代这些结果；本轮未重跑。

## 验证

```bash
pnpm testplan:validate
pnpm testplan:verify
```

静态门禁不是 UI 或运行行为证据。测试计划要求浏览器或桌面行为时，必须按根 `AGENTS.md`
执行真实环境验证并保留计划要求的证据。

终端长文本附件以[专项计划](./terminal/runtime/text-attachments.testplan.yaml)和
[既有输入回归](./terminal/runtime/activity-composer.testplan.yaml)为验收合同。早期本地整体验收记录的
缺口包括：TXT-014 缺完整 runtime 退出/删除证据，TAC-003 缺真实 Run 前提且后续回归未执行；
`pnpm backend:verify-lifecycle` 曾在既有 Activity 初始化检查失败。本轮未重跑这些用例。
当前长文本附件已不按 Agent、thread 或客户端地址关闭，文件仍保存在终端所属 Backend；
SSH 或容器内是否能读取该路径需独立确认，现行边界见[文本附件合同](../../backend/docs/terminal-text-attachments.md)。
这些未闭环项不能由格式校验、构建或原型交互判为通过。

YouTube 阅读稿的[验收计划](./skills/youtube-reading.testplan.yaml)要求区分脚本产物、
字幕与画面对照、实际音频抽听；来源段映射完整不等于语义或听辨准确。未完成抽听的用例
不得标为通过。技能的当前操作合同见 [youtube-reading](../../plugins/toolkit/skills/youtube-reading/SKILL.md)。
