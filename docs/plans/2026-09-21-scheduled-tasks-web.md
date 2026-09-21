# Web 定时任务实施计划

日期：2026-09-21。状态：Web 消费端已实现，Backend 依赖与端到端验收未完成。当前交付边界见 [Web 接入说明](../../frontend/docs/scheduled-tasks.md)。

本轮实现路由、卡片/详情/表单、API 消费、共享 DTO、作用域查询、终端来源回跳及导航恢复；当前 Backend 没有 scheduled-tasks 路由，真实能力检查返回 404。因此 W2/W3 的真实业务验收及 W4 仍阻塞，保留两份过程计划，不将它们清理成“已完成”。

## 目标与交付范围

在现有 Web 终端工作区提供定时任务入口，完成创建、调度、查看历史和继续对话的完整闭环。服务端独立于页面运行；Web 关闭后任务仍由 Backend 执行。

本计划分成两个可独立验收的部分：

1. [Backend 执行与持久化计划](2026-09-21-scheduled-tasks-backend.md)：协议、调度、持久 Agent thread、幂等打开普通终端。
2. 本文：Web 入口、任务页面、现有终端来源入口及整体验收。依赖第一部分的正式 API，不把 HTML 模拟器接进产品。

交互基准为[第三轮原型](../prototypes/agent-scheduled-tasks/README.md)。用户已接受核心交互，并确认 Web 主入口与“随记”并列。原型中的假数据、LocalStorage、固定时钟、模拟终端与预设回复均不进入生产。

本期不实现 iOS 页面、Swift DTO 或 iOS 验收；不新增 Electron 原生能力；不重写终端、PTY、输入组件或恢复体系；不提供 worktree 开关、通用 Cron 编辑器、飞书发布配置、通知中心或任意来源插件框架。不自动创建目录、Worktree、提交 PR 或发布文档，这些由任务提示词与 Skill 决定。

## 当前代码与差异

| 已核实位置                                                | 当前能力                                        | 本期补齐                                           |
| --------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| `frontend/src/components/terminal/workspace/header.tsx`   | 顶部项目导航、随记、状态和更多菜单              | 增加固定“定时任务”入口                             |
| `frontend/src/App.tsx`                                    | 按连接与认证装配页面、Query scope               | 新页面路由沿用相同边界                             |
| `frontend/src/components/terminal/workspace/actions.ts`   | 按当前 effective project 创建普通终端           | 新任务默认上下文；打开运行后选择已有终端           |
| `frontend/src/features/terminal/state/workspace-store.ts` | 当前父项目、实际项目、终端与历史选择            | 离开任务页后恢复原工作区；进入运行时切换正确上下文 |
| `packages/shared/src/terminal/runtime/session.ts`         | projectId、threadId/provider 等合同，无任务来源 | 可选 source，具体协议见 Backend 计划               |
| `backend/src/terminal/application/agent-preparation.ts`   | 指定现有 panel 和 resumeThreadId 启动恢复       | 复用而非复制；启动命令提交不等于恢复完成           |

Worktree 已是子 Project，见[现有身份合同](../architecture/terminal-worktree-context.md)。只使用 `projectId = effectiveProjectId`，不增加 `worktreeId`。顶层列表筛选父项目时聚合其规范子项目；创建时默认精确的当前上下文，选择器可以显示“Runweave / docs-maintenance”，它仍是项目选择，不是新增隔离策略设置。

## 用户可见行为

### 入口与返回

- 顶部“定时任务”在“随记”旁，图标加文字，一次点击进入 `/scheduled-tasks`。
- 默认当前 Backend 和父项目筛选；可切换“所有项目”。创建时带入进入页面时的 effectiveProjectId，用户可在项目选择器中修改。
- 使用 React Router 导航，保存原工作区选择。返回恢复原 Backend scope 内的父项目、Worktree、终端；访问任务页不得主动销毁或停止既有终端。
- `/scheduled-tasks/:taskId?run=:runId` 是来源回跳地址。来源属于当前连接，不跨 Backend 猜测同名 ID。刷新与直接访问仍通过认证及资源校验。
- 窄屏 Web 沿用同一页面自适应，不等同于原生 iOS 支持。

### 列表、编辑与运行记录

- 沿用原型的卡片、启停开关、提示词摘要、时间和更多菜单；详情为配置卡片与运行历史。
- 创建/编辑字段：名称、项目、Agent、提示词、时间规则、时区；模型与推理强度可选并收进高级设置。使用 Backend 提供的 provider 能力和时间预览，禁止前后端各自推导不同的下次执行时间。
- Agent 下拉首个交付闭环为 Codex。TraeX/Pi 只有通过 Backend 计划的独立运行与精确恢复门禁后才启用；未通过显示不可用原因，不静默换 Agent。
- 暂停只停止后续触发；停止针对本次运行，确认后调用停止 API；手动立即运行与定时触发使用同一执行服务。
- 编辑只改变未来运行，历史显示其配置快照。删除按软删除处理；通过列表更多菜单“已删除任务”访问只读任务及历史，仍能打开历史对话，不提供自动恢复调度。
- 每次运行显示时间、触发原因、状态、摘要和产物链接；允许没有文件变更或外部链接的纯文本结果。生产页面打开真实产物，不使用原型里的伪 PR/飞书弹窗。
- 运行中点击记录，展开该记录的只读进度与停止入口；不并行恢复正在被后台进程使用的 thread。完成、失败但有可恢复 thread、或已释放执行权的等待处理记录，点击后按需打开普通终端。
- 上一条是原型到实现的明确收敛：静态原型中的“运行中终端输出”不能被当成已有无 PTY 执行进程的可附着能力；不为此创建第二种终端。

### 普通终端与来源

- Web 调用幂等打开接口，Backend 返回普通 terminalSessionId、panelId 和原有 terminalUrl；Web 导航现有 `/terminal/:terminalSessionId` 并选中实际 projectId/panelId。
- 显示“正在恢复”只依据返回的 attachment 状态；精确 thread 身份得到运行时确认后才视为可输入。沿用终端本身的启动、断连和失败反馈。
- 终端仅增加轻量“来源：任务名称”，回到任务详情并滚动、突出对应 run；不新增定时任务状态栏和专用输入区。
- 名称从任务/历史快照解析；来源任务软删除后仍能打开只读历史。没有 source 的普通终端不增加空占位。
- 已打开过的 thread 复用对应终端；终端不存在可重新创建，原终端已转入别的活跃会话时不得覆盖。具体绑定与冲突语义以 Backend 计划为准。
- 后续自由追问不改变已完成的定时运行结果。只有等待处理运行明确关联的接管操作可以推进该运行；来源标签本身不是完成事件归属依据。

## 接口消费与错误处理

完整 HTTP/数据合同只维护在 [Backend 计划](2026-09-21-scheduled-tasks-backend.md)。Web 新建 `frontend/src/services/scheduled-tasks.ts`，调用既有 HTTP 客户端和 scoped auth；不直接访问数据库、provider 文件、shell 或 App Server。

- Query key 包含既有 connection scope、taskId、筛选条件；切换连接取消旧请求，旧响应不得污染新连接。
- 首版列表/详情在页面可见且在线时每 3 秒轮询，创建、编辑、启停、打开后主动失效相关 query；关闭页面停止轮询。调度不依赖轮询。
- 400 显示字段错误；401 沿用重新认证；404 显示当前连接找不到资源；409 刷新并显示冲突原因；503 区分调度不可用/provider 不可用和“还没有任务”。
- 表单提交失败保留草稿；按钮 pending 避免误触，但不能替代服务端去重。修改带 revision，冲突不覆盖他人编辑；提示刷新后重新提交，保留用户草稿供复制。
- 展示 Agent 文本与产物使用现有安全渲染；链接只允许 http/https，禁止把内容拼成 shell 命令或执行 HTML。

## 实施任务与文件范围

### W1：入口、路由与页面骨架

- [x] 修改 `frontend/src/App.tsx` 和 `components/terminal/workspace/header.tsx`，连接认证、Backend scope、当前位置和返回上下文。
- [x] 新建 `frontend/src/pages/scheduled-tasks-page.tsx`；按职责建立 `frontend/src/features/scheduled-tasks/{queries,task-list,task-detail,task-editor}.tsx` 或等价清晰模块。
- [x] 新建 `frontend/src/services/scheduled-tasks.ts`，只消费正式共享 DTO。
- [x] 页面沿用当前主题、按钮、弹窗与表单组件；稳定事件引用使用 useMemoizedFn。
- 验收：正确入口一次进入、默认项目正确、返回原终端、跨连接无旧数据混入。

### W2：任务管理与状态

- [ ] 接入创建/编辑/启停/删除/只读归档、立即运行、停止、分页历史与产物。
- [ ] 接入 Backend preview、provider capabilities、字段校验及 revision 冲突。
- [ ] 区分任务启停、单次执行状态、普通终端状态，不以启用开关代替停止按钮。
- 验收：真实 API 刷新后数据保留，进度更新，后端离线提示清楚；历史不随编辑变化。

### W3：普通终端打开与来源回跳

- [x] 新建 `frontend/src/features/scheduled-tasks/open-run.ts`，只编排打开 API、query 刷新、工作区选中与现有路由跳转。
- [x] 在 `frontend/src/components/terminal/workspace/header.tsx` 或邻近既有终端信息区域呈现 source 入口；来源标题解析留在 `features/scheduled-tasks`，不让通用终端维护调度状态机。
- [x] 检查 `features/terminal/queries/workspace.ts`、`state/workspace-store.ts` 对新增可选字段的传递；不修改终端渲染、复制、图片、输入等基础能力。
- 验收：两个标签并发打开只出现一个新终端，原 thread 可继续追问；项目和 Worktree 都正确；普通终端回归通过。

### W4：整体验收与文档收尾

- [ ] 执行 Backend 计划的 provider/runtime 门禁，再执行本计划 Web 用例；不能以原型截图替代。
- [ ] 运行下面命令；只有改动涉及对应模块才扩大既有回归。
- [ ] 更新真实实现涉及的架构/使用文档，标明原型为历史交互基准；完成后依仓库治理清理这两份过程计划，长期合同迁至活文档。

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/frontend typecheck
pnpm --filter @runweave/frontend lint
pnpm architecture:check
pnpm docs:check
pnpm testplan:validate docs/testing/scheduled-tasks/web.testplan.yaml
```

不新增单元测试。实际页面验收必须使用 `$toolkit:playwright-cli`，启动/打开隔离 Dev Session 必须使用 `$toolkit:runweave-dev-session`。本轮没有启动 Dev Session。

## 验收与交付门禁

[Web 验收计划](../testing/scheduled-tasks/web.testplan.yaml)覆盖入口、管理、作用域、进度、按需打开、来源回跳及不受影响的普通终端。Backend 能力验收见[执行计划](../testing/scheduled-tasks/runtime.testplan.yaml)。用例只描述目标行为，不代表当前已有或已通过。

先交付 Codex 的真实“无终端运行 → 持久 thread → 普通终端恢复 → 追问”证据，再完成页面集成。未通过该链路不得交付只会展示成功卡片的版本。涉及 provider 的失败如实显示；不以随机 thread ID、重新发送原提示词或新建空对话替代恢复。

## 风险、兼容与回滚

- Web 页面离开会卸载工作区组件，要验证仅断开前端订阅，不销毁服务端终端；既有路由生命周期若有冲突，只修改导航/订阅边界。
- source 是可选增量合同，旧终端行为保持原样；本期不修改 iOS。没有实现能力的旧 Backend 隐藏入口或提示升级，不展示伪空列表。
- 功能回滚先在 Backend 停止调度并排空执行，再撤销 Web 入口；保留任务、历史、thread 文件和普通终端，不通过回滚删用户数据。
- 本计划不授权部署、合并或更新安装态客户端。执行阶段仅修改范围内文件，保留现有原型和其他工作区改动。
