# 全局设置边界修订（第二版）

> **最新可交互原型：** [全局设置第三版](../global-settings/README.md)，已撤掉浏览器设置入口并按作用范围重新组织。

2026-10-11 的设计评审材料，待用户评审；不是产品实现。此文替代第一版的“所有功能统一进入全屏中心”方案。旧 10 张图与旧 HTML 保留为历史，不能继续作为功能归属依据。

> **已确认范围：浏览器不改。** 现有 Browser 的入口、默认 Profile、Profile 端口与代理、Worktree 首选及运行交互全部保持原样；不新增全局浏览器入口。

## 修订结论

**全屏设置承接应用级、设备级、账户级配置，以及与这些配置直接相关的状态和维护。终端、项目、任务和业务对象的操作留在各自上下文。**

“没有 terminalSessionId 参数”只是候选条件，不是进入设置的充分条件：随记、定时任务、成果库即使可跨终端使用，也属于业务功能。独立业务页可以继续全屏，但不挂到本次的全局设置导航里。全局设置与全屏显示方式是两件事。

本次审查覆盖第一版全部 **36 个页面定义**，并额外检查了终端菜单、Browser 绑定、SSH 通道选择和右侧工具，逐项去向见下表及 [结构化清单](scope-audit.json)。源码只读，未修改产品功能。

## 准入规则

1. 必须是应用/账户/明确选定电脑的配置，或对应的状态维护；创建、执行、阅读某个业务对象的页面不准入。
2. 打开和保存不得隐式读取当前 terminalSessionId、panelId、threadId、projectId、runId。仅为返回工作区保存这些 ID 是导航上下文，不是业务依赖。
3. 页面应能在没有选中项目、没有终端的情况下使用；不能要求先开终端才能修改全局默认值。
4. “本台应用”和“所选电脑”明确分开。所选电脑的实例级默认配置只影响该实例，不代表跨电脑同步。
5. 混合组件必须拆到字段和动作级，不能因为一个弹窗里有全局字段，就把整个弹窗上移。

## 发现的关键混淆

### 终端历史与 Team 运行

[工作区历史入口](../../../frontend/src/components/terminal/workspace/header.tsx) 读取 activeSession 和 activePanel；[浮层装配](../../../frontend/src/components/terminal/workspace/overlays.tsx) 将 session、panel、thread、project 一起传给历史抽屉。当前终端历史应留在终端菜单。

[Team 面板](../../../frontend/src/components/terminal/agent-team/panel.tsx) 启动运行必须带 projectId 和 terminalSessionId，后续裁决/修复等操作以 runId 为对象。Team、Race、任务交接、任务监控、会话阅读都保留在右侧工具区。

现有 [工作历史服务](../../../frontend/src/services/work-history.ts) 也提供跨终端/跨 Team 的档案查询。这个聚合能力保留在独立业务页面，不以“全局能查询”为由进入设置。

### Team 默认模型确实存在实例级配置，但不能混称“多 Agent 设置”

真实链路是 [配置弹窗](../../../frontend/src/components/terminal/agent-team/model-config-dialog.tsx) → [GET/PUT /api/agent-team/model-settings](../../../frontend/src/services/terminal/agent-team.ts) → [路由](../../../backend/src/routes/agent-team/model-settings.ts) → [模型服务](../../../backend/src/agent-team/model-catalog/service.ts) → [ConfigurationDomain("agents.team")](../../../backend/src/agent-team/runtime/model-config-store.ts)。不传 terminalSessionId。

因此：撤掉全局导航里独立的“Agent Team / 多 Agent”入口；仅将**新运行使用的默认角色模型**放到“所选电脑 → 高级配置 → 默认模型”。运行中的 Team 配置、进度和人工裁决留原面板。默认值不能追写已经创建的运行快照。

同时纠正旧原型的另一处失真：当前专用 API 一次提交四个角色的 roles 配置，并不是四个独立保存接口；provider 目录是 Codex/Traex，不应照旧图加入 Pi。若将来采用逐角色保存交互，必须合并完整配置并考虑覆盖冲突，不能声称接口已支持。

### Browser 保持现状；隧道仍区分主机配置与终端绑定

[Browser 设置](../../../frontend/src/components/terminal/browser/header/profile-settings.tsx) 与 [Electron 保存逻辑](../../../electron/src/browser/profile/preferences.ts) 虽然区分 global、profile、worktree，但用户已明确要求不改这部分。默认 Profile、固定端口、代理配置、Worktree 首选，以及标签/工作组等全部保留现有入口和行为。本次不迁移、不拆分，也不在全局设置中重复增加入口。

[SSH 终端绑定](../../../frontend/src/features/tunnels/terminal-binding.tsx) 调用 selectTunnelBrowser(hostId, terminalId)，留在终端。SSH 主机定义、Backend 地址与通道配置属于本台连接管理。

### 定时任务、随记、自进化不是设置

定时任务列表与后台运行按当前电脑聚合，不需要依附某个现有终端；随记是独立账户业务；自进化还具有 global/repository 学习范围。但它们管理的是任务、记录、成果，继续保留各自业务入口，不进入设置侧栏。

快捷指令模板列表确实是 scope=global，发送动作依赖当前终端。模板管理与执行留快捷指令模块；只有后台执行的默认模型、并发与超时等实例配置进入高级配置。

## 图片状态

- [V2 全局设置与外观](image-options/v2-global-settings.png)：其中侧栏的“浏览器默认”已撤回，图片尚未同步重绘；其他布局仅供参考。
- [V2 浏览器默认配置](image-options/v2-browser-defaults.png)：**整张方案作废**，仅保留历史记录。
- 旧 01–10 图仍仅作历史对照。当前范围以本文导航树和逐项清单为准。

## 修订后的导航树

```text
全局设置                        ← 返回工作区
├─ 本台应用
│  ├─ 外观                      主题、右侧工具默认显隐/排序
│  ├─ 桌面通知                  本台系统通知偏好
│  └─ 快捷键                    现有绑定只读查阅
├─ 连接与服务
│  ├─ 连接管理                  保存的 Backend 连接、SSH 主机与通道
│  └─ 随记账户                  独立账户、环境与服务地址
├─ 所选电脑                     明确选择：本机 Mac / 开发机
│  ├─ 登录与手机接入            Backend 密码、退出、手机授权
│  ├─ 资源监控与提醒            采样、提醒、受权限限制的进程控制授权
│  └─ 高级配置
│     ├─ 默认模型               Team 默认角色模型、快捷后台默认模型
│     ├─ 后台任务配置           启用、并发、超时、输出上限
│     ├─ 数据保留策略           仅实际支持的实例配置
│     └─ 其他实例配置           按 owner/remote/apply 展示
└─ 状态与诊断
   ├─ 所选电脑                  运行状态、资源、开发资源、额度、日志
   └─ 本台桌面诊断              本台版本、导出、运行时维护
```

树是信息归属，不要求每个叶子单独占一条常驻导航；状态详情和高级分类可在父页面展开。全局侧栏不出现当前项目名、终端名称、任务运行标签或具体运行列表。

## 不进入全局设置的入口如何保留

| 原有能力                                                                   | 保留位置                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------- |
| 当前终端历史、输出复制、快照、Fork、恢复 Agent、状态查询                   | 当前终端菜单；明确 session/panel 目标                    |
| Team 运行/历史/人工裁决、Race、任务交接、任务监控、会话阅读                | 当前终端右侧工具；各自 run/session 上下文                |
| 项目与 Worktree 管理、开发服务、原型预览                                   | 项目/Worktree 菜单和原有 Services/Preview 入口           |
| Browser 默认、Profile 端口与代理、Worktree 首选、标签/工作组及其他现有交互 | 全部保留现有 Browser / Worktree 入口；本次不改           |
| 快捷指令插入/发送/后台执行                                                 | 终端附近的快捷指令入口；不从全局页隐式发送到当前终端     |
| 定时任务与后台运行、随记、自进化、跨终端工作档案                           | 原有独立业务入口；需要时仍可用全屏业务页，不混入设置导航 |
| 项目范围数据导出、删除、单次任务回复                                       | 所属业务对象页面，明确目标与确认                         |
| 系统窗口/编辑/缩放/全屏/DevTools                                           | 保留原生系统菜单                                         |

## 36 项逐项审查

| 原页面                                     | 处理                     | 实际归属                                    | 修订后入口                                                                 | 代码证据                                                                                                                                                                                                                                                |
| ------------------------------------------ | ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 终端历史（`history`）                      | 移出                     | 终端 / 面板；另有跨终端档案查询             | 终端菜单 → 输出与历史；跨终端归档留在独立工作记录页                        | [overlays.tsx](../../../frontend/src/components/terminal/workspace/overlays.tsx)：history drawer 的 source 含 sessionId、panelId、threadId；跨终端列表不改变记录对象的终端归属。                                                                        |
| 多 Agent 运行（`team-history`）            | 移出                     | 项目 / terminalSessionId / runId            | 右侧 Agent Team → 当前运行与历史；跨运行档案仍属业务页                     | [panel.tsx](../../../frontend/src/components/terminal/agent-team/panel.tsx)：启动 Team 必须传 projectId 和 terminalSessionId，操作以 runId 为目标。                                                                                                     |
| 快捷指令（`commands`）                     | 移出业务、保留默认配置   | 指令库为连接级；发送动作依赖终端            | 快捷指令面板 / 独立指令库；后台默认模型进所选电脑高级配置                  | [quick-input-popover.tsx](../../../frontend/src/components/terminal/input/quick-input-popover.tsx)：列表 scope=global，发送却需要 activeSession；列表全局不等于业务执行应进入设置。                                                                     |
| 定时任务（`schedules`）                    | 移出                     | 连接级任务列表；每项绑定执行项目            | 保留顶栏定时任务及独立业务页                                               | [scheduled-tasks-page.tsx](../../../frontend/src/pages/scheduled-tasks-page.tsx)：列表按连接查询，任务编辑选择项目；返回携带终端仅为恢复上下文，不等于任务绑定发起终端。                                                                                |
| 后台运行（`runs`）                         | 移出                     | 连接级后台运行聚合；对象为 task/run         | 快捷指令后台运行面板 / 定时任务详情                                        | [use-quick-input-background-runs.ts](../../../frontend/src/features/scheduled-tasks/use-quick-input-background-runs.ts)：查询当前电脑全部后台运行；继续、回复、恢复是业务动作而非全局设置。                                                             |
| 记录（`notes`）                            | 移出                     | 随记账户业务数据                            | 随记抽屉 / 独立随记页面                                                    | [workspace.tsx](../../../frontend/src/features/suiji/workspace.tsx)：随记客户端与账户独立于终端；不是全局设置内容。                                                                                                                                     |
| 待办（`todos`）                            | 移出                     | 随记账户业务数据                            | 随记 → 待办                                                                | [workspace.tsx](../../../frontend/src/features/suiji/workspace.tsx)：业务对象，不因与终端无关就进入设置。                                                                                                                                               |
| AI 回顾（`review`）                        | 移出                     | 随记账户业务数据                            | 随记 → AI 回顾                                                             | [review.tsx](../../../frontend/src/features/suiji/review.tsx)：回顾内容是业务页面。                                                                                                                                                                     |
| 回收站（`trash`）                          | 移出                     | 随记账户业务数据                            | 随记 → 回收站                                                              | [workspace.tsx](../../../frontend/src/features/suiji/workspace.tsx)：记录恢复属于随记业务流程。                                                                                                                                                         |
| 随记账户设置（`suiji-account`）            | 保留配置                 | 随记账户 / 环境                             | 全局设置 → 外部服务 → 随记账户                                             | [accounts.ts](../../../frontend/src/features/suiji/accounts.ts)：环境、登录与服务地址是配置；不能把随记账户当作 Backend 登录。                                                                                                                          |
| 成果（`knowledge`）                        | 移出                     | 连接 / 账户下的成果对象                     | 独立自进化成果页                                                           | [evolution-page.tsx](../../../frontend/src/pages/evolution-page.tsx)：KnowledgeInbox 是成果阅读与处理。                                                                                                                                                 |
| 分析管理（`evolution`）                    | 移出                     | 学习范围 / 分析运行                         | 独立自进化管理页                                                           | [evolution-page.tsx](../../../frontend/src/pages/evolution-page.tsx)：按 scope 过滤 run、schedule、candidate、insight；不是应用偏好。                                                                                                                   |
| 洞察（`insights`）                         | 移出                     | 学习范围 / 洞察对象                         | 自进化 → 洞察                                                              | [evolution-page.tsx](../../../frontend/src/pages/evolution-page.tsx)：保留业务模块内归属。                                                                                                                                                              |
| 候选资产（`candidates`）                   | 移出                     | 学习范围 / 候选资产                         | 自进化 → 候选资产                                                          | [evolution-page.tsx](../../../frontend/src/pages/evolution-page.tsx)：授权与退休针对候选对象。                                                                                                                                                          |
| 运行计划（`evolution-schedules`）          | 移出                     | 学习范围 / 运行计划                         | 自进化 → 计划                                                              | [evolution-page.tsx](../../../frontend/src/pages/evolution-page.tsx)：计划带 learningScopeId，不提升为应用级配置。                                                                                                                                      |
| Memory Canary 策略（`evolution-policy`）   | 移出                     | 明确学习范围：global 或 repository          | 自进化 → 所选学习范围策略                                                  | [evolution-page.tsx](../../../frontend/src/pages/evolution-page.tsx)：旧稿标为 project 过于简化；global 学习范围也不等于应用全局设置。                                                                                                                  |
| 原型库（`prototypes`）                     | 移出                     | 项目资源；列表可跨项目                      | 项目菜单 → 原型库 / 独立原型页                                             | [prototype-gallery.ts](../../../frontend/src/services/terminal/prototype-gallery.ts)：预览 ticket 路由需要 projectId、source、slug。                                                                                                                    |
| 连接管理（`connections`）                  | 保留                     | 本台应用保存的连接                          | 全局设置 → 连接管理                                                        | [use-connections.ts](../../../frontend/src/features/connection/use-connections.ts)：连接定义管理不依赖当前终端；工作区保留快速切换入口。                                                                                                                |
| 连接手机（`mobile`）                       | 保留                     | 所选 Backend 登录授权                       | 所选电脑 → 登录与手机接入                                                  | [connection-switcher.tsx](../../../frontend/src/components/connection-switcher.tsx)：授权连接到所选电脑，页面必须展示目标电脑。                                                                                                                         |
| 端口与隧道（`tunnels`）                    | 拆分                     | SSH 主机定义 / 某终端的 Browser 通道绑定    | SSH 主机与通道配置进连接管理；终端选通道留在终端                           | [terminal-binding.tsx](../../../frontend/src/features/tunnels/terminal-binding.tsx)：selectTunnelBrowser(hostId, terminalId) 是终端操作，不能搬进全局主机配置页。                                                                                       |
| 运行状态（`runtime`）                      | 保留辅助信息             | 所选电脑及明确标注的本台组件                | 全局设置 → 状态与诊断 → 运行状态                                           | [runtime-status.ts](../../../frontend/src/services/runtime-status.ts)：按 apiBase 查询；本机 Electron 信息必须另行标注，不能跟随远端标签伪装。                                                                                                          |
| 系统资源（`resources`）                    | 保留辅助管理             | 所选电脑进程与资源                          | 状态与诊断 → 系统资源                                                      | [resource-monitor.ts](../../../frontend/src/services/resource-monitor.ts)：进程控制目标是电脑上的进程，不是当前终端；权限与危险确认保留。                                                                                                               |
| 开发资源（`dev-resources`）                | 保留辅助管理             | 所选 Backend 管理的开发资源                 | 状态与诊断 → 开发资源                                                      | [dev-resources-page.tsx](../../../frontend/src/pages/dev-resources-page.tsx)：资源详情显示实际设备、会话或工作区归属，不默认释放当前终端。                                                                                                              |
| Codex 额度（`quota`）                      | 保留辅助信息             | 所选 Backend 对应的 Codex 额度              | 状态与诊断 → Codex 额度                                                    | [codex-quota.ts](../../../frontend/src/services/codex-quota.ts)：/api/codex/quota 无 terminalSessionId；额度不表示当前终端的专属配额。                                                                                                                  |
| 日志记录（`logs`）                         | 保留、显式标来源         | 所选 Backend + 本台前端记录器               | 状态与诊断 → 日志记录                                                      | [diagnostic-log-entry.tsx](../../../frontend/src/components/diagnostic-log-entry.tsx)：Backend 记录与 frontendDiagnosticLogRecorder 配合；终端内容复制不合并进这里。                                                                                    |
| 桌面诊断（`desktop-diagnostics`）          | 保留                     | 本台 Electron                               | 状态与诊断 → 本台桌面诊断                                                  | [runtime-status-panel.tsx](../../../frontend/src/components/runtime-status-panel.tsx)：Electron 宿主操作保持本台作用域，不能随所选远端连接而变。                                                                                                        |
| 状态查询（`lookup`）                       | 移出                     | terminalSessionId / threadId / panel        | 终端菜单 → 状态查询                                                        | [status-lookup-dialog.tsx](../../../frontend/src/components/terminal/workspace/status-lookup-dialog.tsx)：打开时默认 activeSessionId，可查询 ThreadRef；属于上下文排障。                                                                                |
| 活动数据（`events`）                       | 拆分                     | 活动事实 / 时间线 / 数据策略                | 事件与终端归档留 Activity；实例数据保留策略归高级配置                      | [activity-page.tsx](../../../frontend/src/pages/activity-page.tsx)：API 能聚合查询不意味着终端、Team 历史成为设置项。                                                                                                                                   |
| 账户与登录（`settings/account`）           | 保留、改名               | 所选 Backend 的认证                         | 所选电脑 → 登录与手机接入                                                  | [auth.ts](../../../frontend/src/services/auth.ts)：changePassword(apiBase, token) 修改目标 Backend 的登录凭据；不存在已证实的统一云账户。                                                                                                               |
| 外观（`settings/appearance`）              | 保留                     | 本台客户端主题及工具布局偏好                | 本台应用 → 外观                                                            | [store.ts](../../../frontend/src/features/terminal/preview/store.ts)：工具显隐/排序存 deviceStorage；只调整通用布局，不把工具内部业务搬来。                                                                                                             |
| 浏览器（`settings/browser`）               | 保持现状，不纳入本次重构 | 本台全局默认 / 本台 Profile / Worktree 绑定 | 全部保留在现有 Browser / Worktree 入口；全局设置不新增浏览器页面或重复入口 | [profile-settings.tsx](../../../frontend/src/components/terminal/browser/header/profile-settings.tsx)：用户明确要求保持不变；global/profile/worktree 的作用范围区分不构成迁移入口的理由。现有默认 Profile、固定端口、代理与 Worktree 首选均保留原交互。 |
| Agent Team 模型（`settings/models`）       | 拆分、降为高级配置       | 所选 Backend 默认角色模型 / 运行快照        | 全局默认值归所选电脑高级配置；运行、角色任务与人工裁决留 Team 面板         | [model-config-store.ts](../../../backend/src/agent-team/runtime/model-config-store.ts)：ConfigurationDomain("agents.team") 是实例级，非单终端；不保留顶级“多 Agent 设置”入口。                                                                          |
| 资源监控与提醒（`settings/notifications`） | 拆分                     | 本台系统通知 / 所选电脑采样与提醒           | 本台应用 → 桌面通知；所选电脑 → 资源监控与提醒                             | [resource-settings.tsx](../../../frontend/src/features/system-monitor/resource-settings.tsx)：macNotifications 与 Backend settings/remoteControl 分属不同 owner；单次任务处理不归这里。                                                                 |
| 数据管理（`settings/data`）                | 收缩、移出业务操作       | 实例保留策略 / 所选数据对象                 | 保留策略归高级配置；按项目导出删除留 Activity 对象操作                     | [activity.ts](../../../frontend/src/services/activity.ts)：撤回旧图泛化的“一键导出/删除全部项目”合同；必须沿用实际 operation 与权限。                                                                                                                   |
| 高级实例配置（`settings/advanced`）        | 保留                     | 所选实例；部分字段仅本地可管                | 所选电脑 → 高级配置                                                        | [fields.ts](../../../packages/shared/src/configuration/fields.ts)：遵循 scope、owner、remote、apply；保存与重新加载/重启分别反馈，不暗示跨电脑同步。                                                                                                    |
| 快捷键（`settings/shortcuts`）             | 保留只读                 | 客户端快捷行为说明                          | 本台应用 → 快捷键                                                          | [menu.ts](../../../electron/src/desktop/menu.ts)：仅查阅已有快捷行为，不新增未实现的自定义绑定能力。                                                                                                                                                    |

## 旧 10 个视觉方向如何修订

所有旧图的业务导航均失效，以下是对应的修订方向，不表示已重新生成全部十图。

| 编号          | 修订                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| 01 分组侧栏   | 保留布局，分组换为本台应用、连接与服务、所选电脑、状态与诊断；删除全部业务目录。    |
| 02 两级导航   | 一级按作用范围，二级只显示配置分类；不再以工作记录、自动化、随记等业务模块为一级。  |
| 03 常用与全部 | 固定对象仅允许配置页；删除定时任务、随记待办等快捷入口。首版先不加固定能力。        |
| 04 搜索定位   | 索引仅含配置字段与配置页面，不检索终端历史、任务、运行；结果显示作用范围。          |
| 05 功能与偏好 | 撤回顶部“功能/设置”切换：全局设置只有设置，不承担功能中心。                         |
| 06 连接作用域 | 保留本台与所选电脑的明确区分；Team 独立页面改成高级配置中的默认模型，不带当前终端。 |
| 07 模块展开   | 保留折叠交互，但展开的是配置分类；撤回自动化/随记/工作记录目录。                    |
| 08 列表与详情 | 若用于设置，只适用于“连接列表 → 连接配置”；任务列表详情仍用于独立业务页。           |
| 09 宽松阅读   | 保留排版，用于全局配置与设备状态；不能把终端级诊断混入系统运行状态。                |
| 10 紧凑工作台 | 撤回任务标签与多业务工作台；第一版不引入设置页面多标签，保持单页切换。              |

推荐收敛到 **01 的单侧栏 + 07 的按需展开 + 09 的内容排版**。只建立一套明确的作用范围，不再把十种布局当成十套功能分类。

## 交互约束与后续验证边界

- 进入设置只保存工作区返回位置；设置读写不借用该终端/项目作为默认业务目标。
- 无项目、无终端时仍能打开、读取和保存本台设置；不支持的宿主能力按 capability 呈现。
- 切换所选电脑只更换实例级配置和查询，不能改变本台外观、Browser Profile 与随记账户。
- 终端和 Worktree 的变化不能重定向正在编辑的配置；保存时使用页面明确固定的目标。
- Browser 的入口、读写方式和生效行为全部沿用现状；本次设置重构不得迁移或重复实现这些能力。
- 系统通知与资源监控分别保存到对应 owner；不同实例不共享草稿、缓存或保存结果。
- 高级配置按真实接口执行：模型整组提交、敏感项保留/替换/删除、权限检查、保存与生效状态分别处理。
- 从诊断跳到业务对象时显式离开设置进入所属终端/项目，返回路径保留；不在设置内嵌终端工作区。

本轮完成的是源码归属核查、清单与方案修订，不是上述产品行为的运行时验收。旧 HTML 的 70 项检查仅证明旧原型交互，不能证明本版范围正确或已实现。
