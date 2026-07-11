# Runweave 文档总览

面向 Runweave 工程与智能体的**唯一完整文档索引**。按需读取，避免在单一文档里堆叠细节。

文档分两类：

- **活文档**：描述系统当前事实，需要保鲜（architecture / cli / deployment / quality / testing）。
- **历史归档**：记录特定基线的一次性产物，不代表当前事实（architecture-flows / prototypes）。计划、评审和执行记录不再作为长期文档保留。

---

## 架构理解（活文档）

| 需求                            | 阅读                                                            |
| ------------------------------- | --------------------------------------------------------------- |
| 架构 / 网络拓扑                 | architecture/network-topology.md                                |
| app-server 架构概览             | architecture/app-server-architecture.md                         |
| app-server Event Center 细节    | architecture/app-server-event-center.md                         |
| App 移动端边界                  | architecture/app-mobile.md                                      |
| App 后端连接管理                | architecture/app-mobile.md#配置与安全                           |
| App 终端语音输入                | architecture/app-mobile.md#app-终端语音输入                     |
| App 终端输入与快捷键            | architecture/app-mobile.md#app-终端详情                         |
| 终端状态模型                    | architecture/terminal-state.md                                  |
| 终端代码预览 / Terminal Browser | architecture/terminal-code-preview.md                           |
| 多项目原型轮巡库                | architecture/terminal-code-preview.md#多项目原型轮巡库          |
| Web Terminal 快捷指令           | architecture/terminal-code-preview.md#快捷指令入口              |
| Terminal Browser 注释模式       | architecture/terminal-code-preview.md#terminal-browser-注释模式 |
| 终端 tmux 恢复                  | architecture/terminal-tmux-recovery.md                          |
| 终端完成事件 Hook               | architecture/terminal-completion-hooks.md                       |
| 终端任务完成通知（桌面/飞书）   | architecture/terminal-completion-notifications.md               |
| Agent Team / Loop Engine        | architecture/multi-agent-orchestrator.md                        |
| 本机系统资源监控                | architecture/system-monitor.md                                  |

## 操作指南（活文档）

| 需求                   | 阅读                                 |
| ---------------------- | ------------------------------------ |
| Terminal CLI           | cli/terminal-cli.md                  |
| Agent Team CLI         | cli/agent-team-cli.md                |
| 部署 / 环境概览        | deployment/overview.md               |
| Electron 本地自动更新  | deployment/electron-local-updates.md |
| Runweave Beta 自举通道 | deployment/runweave-beta.md          |

## 质量与可观测（活文档）

| 需求                       | 阅读                                         |
| -------------------------- | -------------------------------------------- |
| 质量体系概览               | quality/quality-harness.md                   |
| AI 诊断日志 / Web 日志上报 | quality/ai-diagnostic-logging.md             |
| 后端滚动日志               | quality/backend-rolling-logs.md              |
| 按需录屏的浏览器 MCP 验证  | quality/recorded-browser-mcp-verification.md |
| 终端性能优化               | quality/terminal-performance-optimization.md |

## 测试用例（活文档）

供人或 agent 执行的测试用例与回归清单，非可执行测试代码。

| 需求                                     | 阅读                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 测试层级与命名                           | testing/layers.md                                                                  |
| 测试命令选择                             | testing/command-matrix.md                                                          |
| TerminalState 测试                       | testing/terminal-state-test-cases.md                                               |
| Terminal 事件恢复与架构问题测试          | testing/terminal-event-recovery-test-cases.md                                      |
| Terminal activeCommand 一致性测试        | testing/terminal-active-command-consistency-test-cases.md                          |
| App 设备在线测试                         | testing/app-device-online-test-cases.md                                            |
| app-server CLI 启动测试                  | testing/app-server-event-center-test-cases.md#as-ec-008-cli-owned-app-server-start |
| app-server 状态同步测试                  | testing/app-server-state-sync-test-cases.md                                        |
| Runweave Agent CLI 控制面测试            | testing/runweave-cli-control-plane-test-cases.md                                   |
| Agent Team / Loop Engineer 测试          | testing/agent-team-loop-engineer-test-cases.md                                     |
| Agent Team 验收来源测试                  | testing/agent-team-verification-case-source-test-cases.md                          |
| App Server ThreadRef fixture             | testing/app-server-threadref-fixture.md                                            |
| Terminal Panel Split 测试                | testing/terminal-panel-split-test-cases.md                                         |
| 桌面端重启项目/终端恢复测试              | testing/desktop-restart-terminal-selection-test-cases.md                           |
| Terminal Floating Composer 测试          | testing/terminal-floating-composer-test-cases.md                                   |
| Terminal IME 输入测试                    | testing/terminal-ime-input-test-cases.md                                           |
| 本地客户端更新测试                       | testing/runweave-local-client-update-test-cases.md                                 |
| Runweave Beta 自举开发通道测试           | testing/runweave-beta-self-hosting-test-cases.md                                   |
| Terminal Browser CDP/MCP 测试            | testing/terminal-browser-cdp-mcp-test-cases.md                                     |
| Terminal Browser Playwright MCP 工具测试 | testing/terminal-browser-playwright-mcp-test-cases.md                              |
| Terminal Browser 自适应多 Tab 测试       | testing/terminal-browser-adaptive-tabs-test-cases.md                               |
| 多项目原型轮巡库测试                     | testing/prototype-gallery-preview-test-cases.md                                    |
| 系统性架构重构验收                       | testing/runweave-systematic-architecture-refactor-test-cases.md                    |
| 终端回归（Vim）                          | testing/runbooks/terminal-vim.md                                                   |
| Explorer Quick Search 回归               | testing/runbooks/explorer-quick-search.md                                          |
| Web Terminal 状态查询回归                | testing/runbooks/status-lookup-ui.md                                               |

## 历史归档（冻结，不代表当前事实）

| 目录                | 内容                                                                          |
| ------------------- | ----------------------------------------------------------------------------- |
| architecture-flows/ | 可运行 HTML 技术架构、事件流与故障因果说明（见 architecture-flows/README.md） |
| prototypes/         | 可运行 HTML/JS 产品交互原型（见 prototypes/README.md）                        |

`docs/plans/` 和 `docs/review/` 只允许作为临时过程目录；有效结论应迁入上面的活文档，目录内文件不得长期保留。

---

## 维护边界

- **本文件是唯一完整索引。** root `README.md` 只保留面向用户的精选链接，`AGENTS.md` 不再维护路由表。新增/移动活文档时，只在这里同步。
- 文档整理只维护当前事实、稳定边界和验证入口。一次性计划、评审、执行记录、临时排障过程应沉淀进上表的活文档；核心结论被吸收后，冗余材料应删除。
- 纯文档保鲜不修改代码、配置或 lockfile。发现代码侧问题时，先在整理报告里列为待处理项，不顺手修代码。
