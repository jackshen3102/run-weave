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

Daily Record 的[浏览来源接入计划](./skills/daily-record-browser.testplan.yaml)覆盖 Mac 来源选择、
访问证据回查、主题归并、来源迁移及导入恢复；架构边界见[定时上报](../architecture/suiji.md#daily-record-定时上报)。
浏览日志读取完整、手动导入与自然到点调度分别取证，不能相互替代。

开发资源的当前快照、认证与手动释放使用[专项验收计划](./platform/development-resources.testplan.yaml)，
原生 iOS 使用[手机专项计划](./app/ios-development-resources.testplan.yaml)，
产品边界见[开发资源合同](../architecture/development-resources.md)。

## OSC 7501 终端状态验收

[传输计划](./terminal/runtime/osc-7501-transport.testplan.yaml)覆盖实时帧、历史隔离、Claude
能力探测、直连 PTY 和 Windows ConPTY。[状态计划](./terminal/runtime/osc-7501-status.testplan.yaml)
覆盖 Codex Full Access 成功与失败、手动启动、Hook 兜底、多 Panel、桌面与 iOS。

本地 tmux Codex 组合使用 OSCT-001～003、OSCS-001～007。Claude 的目标 tmux 握手与状态验收
分别见 OSCT-004、OSCS-008。直连 PTY、Windows 及 iOS 分别见 OSCT-005、OSCT-006 和
OSCS-009。记录实际 CLI、运行时和客户端版本。各路径以真实目标环境的结果为准。

## Claude Code 集成验收

Claude 的[配置与能力](../cli/configuration.md#claude-code-原生引用与能力)、
[正文读取](../architecture/terminal-code-preview.md)、
[Hook 生命周期](../architecture/terminal-state.md#运行限制)和
[原生空闲通知](../architecture/terminal-completion-notifications.md#claude-原生空闲确认)分别描述当前接入。
以下三份计划保留完整能力的验收要求，不是已实现清单，也没有完整通过记录：

- [基础闭环](./terminal/runtime/claude-code-foundation.testplan.yaml)：安装、身份、生命周期、只读会话和精确恢复。
- [跨端交互](./terminal/claude-code-interaction.testplan.yaml)：输入、附件、问答、模型设置、fork 与旁聊。
- [后台与内部 Agent](./scheduled-tasks/claude-code-automation.testplan.yaml)：执行策略、取消、续跑、接管与内部消费者。

原生 CLI 请求、resume/fork 和结构化输出的受控验证不能替代 Runweave 受管恢复或后台执行；
reader fixture 不能替代真实压缩、浏览器或 iOS 阅读验收。版本和登录探测不证明模型调用成功，
进程退出 0 也不证明业务成功。没有可核对的实际 verdict 时，未完成项继续保持未验收。

执行时为每例建立独立项目、pane、进程与通知 sink，不使用用户活跃任务或向真实联系人发测试通知。
证据分别记录源码/fixture、真实 Claude 请求、浏览器、iOS、安装态与操作系统平台；
保留版本及目标身份，脱敏凭据和原生记录。某一平台通过不能扩写为全部平台通过。

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

## 任务交接上下文关联

当前行为以[普通终端任务交接](../../frontend/docs/task-handoff.md#随记关联与来源阅读)为准，
[上下文关联计划](./terminal/task-handoff-context-links.testplan.yaml)覆盖手动关联、来源分页、
账号与会话隔离、精确消息定位、本地持久化和既有草稿保护。

2026-10-18 的历史执行记录仅正式通过 HCL-001～003；HCL-004 的同源双页前提受阻，
HCL-005～015 未正式执行。后续执行需要同一实现的可用纯 Web 地址及支持创建同源双页的受控 CDP；
不得通过替换 Dev Session 入口或降级 Profile 绕过前提。单页补充诊断、静态门禁和历史原型
均不能补记为这些用例通过，Desktop 与纯 Web 需分别取证，原生 iOS 不在此计划范围。
本轮文档维护未重跑产品验收。

## 验证

右侧 Browser 的可靠性回归按能力拆分为
[首次可用](./terminal/browser/resilience-availability.testplan.yaml)、
[传输恢复](./terminal/browser/resilience-transport-recovery.testplan.yaml)、
[进程与认证](./terminal/browser/resilience-lifecycle-recovery.testplan.yaml)、
[仅使用 rw 恢复](./terminal/browser/resilience-command-recovery.testplan.yaml)、
[页面数据链路](./terminal/browser/resilience-data-path-recovery.testplan.yaml)及
[持续可靠性](./terminal/browser/resilience-soak-recovery.testplan.yaml)。
各计划分别记录本机、Windows 云桌面和 Linux devbox 的版本、操作及未执行边界；
短时通过不能替代两小时抖动或八小时闲置验收。

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

## 终端压力验收合同

压力计划是可执行的验收要求，不是性能通过记录。Windows ConPTY 与 macOS、Linux tmux
分别执行、分别出 verdict；Backend 健康、协议回执或短时通过均不能替代真实页面、原进程保活或长时间稳定性。

| 链路 | 传输与输入 | 生命周期与资源 | 真实页面 |
| --- | --- | --- | --- |
| tmux | [传输与后台采集](./terminal/runtime/tmux-transport-stress.testplan.yaml) | [生命周期](./terminal/runtime/tmux-lifecycle-stress.testplan.yaml) | [终端交互](./terminal/runtime/tmux-ui-stress.testplan.yaml) |
| Windows ConPTY | [传输与恢复](./platform/windows-terminal-transport-stress.testplan.yaml) | [生命周期](./platform/windows-terminal-lifecycle-stress.testplan.yaml) | [桌面交互](./platform/windows-terminal-ui-stress.testplan.yaml) |

每例独占配置、认证、端口、终端、驱动与合成数据；tmux 显式指定独立 socket，保活用例使用 preserve
关闭策略，清理用例独立建 fixture。禁止使用默认 socket、用户终端或生产 Host 做故障注入。
清理与信号操作前核对 PID 启动时间和归属，恢复暂停进程，结束后复核非测试资源基线。
执行前记录源码、实际产物、平台、进程身份及运行中 tmux server 版本；旧常量不能当作当前边界。

取证分为探测进程账本（输入序号、摘要与执行次数）、显示流（同 attach 的 streamId/cursor/range
及静止屏幕 marker）、后台 pipe-pane 与持久历史（实际保留窗口、截断和末尾 marker）三条链。
应用输出字节不等于 tmux 重绘字节；输入接收不等于执行或上屏，窗口外历史与停机期间不承诺无损。
结果不确定的输入不重发。语义依据见 [tmux 恢复](../architecture/terminal-tmux-recovery.md)
与 [Windows PTY Host](../architecture/windows-pty-host.md)。

tmux 通用预算：60 秒无负载校准，各档预热 10 秒、采样 60 秒、重复 3 次；单 pane
64 KiB/s、256 KiB/s、1 MiB/s、4 MiB/s，突发 512 KiB～64 MiB，并发 session 1/4/8/16/32，
同 session 观看端 1/4/8/16，输入 1/10/50 次每秒及 8 KiB 分片边界、64 KiB 多字节文本。
默认持续 20 分钟，全量 2 小时；重连 100 次、创建删除各并发档 200 次、正常/异常重启各 10 次。
这些是验收预算，不是产品性能承诺；逐例步骤和预期仍以 YAML 为准。

常用档（单 session 64/256 KiB/s、4 session 各 64 KiB/s）在本机回环每秒 10 次输入，
p95 ≤250 毫秒、p99 ≤1 秒、5 秒超时为零；不能靠断开显示流满足指标。
同流恢复至新输入可见 ≤5 秒，Backend 重启从 fresh health ready 起 ≤10 秒。
每秒记录 CPU/RSS、FD、进程数、磁盘、实际吞吐与延迟分布；未采到指标不能写为零。
每轮结束等 75 秒再取 30 秒稳态窗口；允许的有界缓存单列，专用资源回到空闲基线，
预热后 Backend+tmux 稳态 RSS 中位数不得高于基线加 max(64 MiB, 20%)。
磁盘不足 1 GiB、内存压力持续 10 秒、影响非测试资源或无法确认清理归属时停止升压。

首个失败保留版本、最小负载、独立账本和原始回执；修复后按同一负载及判据复验。
逐平台、逐 case、逐档报告 pass/fail/blocked/not_run、截断、容量停止与资源回落，不平均掩盖失败。
20 分钟记录不能声称 24 小时或整机重启通过；协议通过不能替代页面验收，格式校验也不是行为通过。

## HTML 方案阅读与评审验收

当前功能与隔离边界见 [HTML 方案元素评审](../architecture/terminal-code-preview.md#html-方案元素评审)，
用例见 [可视化方案评审](./terminal/visual-plan-review.testplan.yaml)。电脑圈选与手机阅读分别取证。
原过程计划记录过 Web/Electron VPR-003～014 及旧 Browser 最小回归通过，但 iPhone 阅读、锚点、
本地交互与更新重读 VPR-015～017 受真机自动化连接阻塞；没有新的真机证据前仍保留为验收缺口。
本次文档维护不重跑这些用例，也不以删除过程计划代表全部交付。
