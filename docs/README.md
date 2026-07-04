# Runweave 文档总览

面向 Runweave 工程与智能体的**唯一完整文档索引**。按需读取，避免在单一文档里堆叠细节。

文档分两类：

- **活文档**：描述系统当前事实，需要保鲜（architecture / cli / deployment / quality / testing）。
- **历史归档**：一次性产物，写完即冻结，不代表当前事实（plans / review / prototypes）。各目录内 `README.md` 说明其生命周期。

---

## 架构理解（活文档）

| 需求                                 | 阅读                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| 架构 / 网络拓扑                      | architecture/network-topology.md                                |
| app-server 架构概览                  | architecture/app-server-architecture.md                         |
| app-server Event Center 细节         | architecture/app-server-event-center.md                         |
| App 移动端边界                       | architecture/app-mobile.md                                      |
| App 后端连接管理                     | architecture/app-mobile.md#配置与安全                           |
| App 终端语音输入                     | architecture/app-mobile.md#app-终端语音输入                     |
| App 终端输入与快捷键                 | architecture/app-mobile.md#app-终端详情                         |
| 终端状态模型                         | architecture/terminal-state.md                                  |
| 终端代码预览 / Terminal Browser      | architecture/terminal-code-preview.md                           |
| Web Terminal 快捷指令                | architecture/terminal-code-preview.md#快捷指令入口              |
| Terminal Browser 注释模式            | architecture/terminal-code-preview.md#terminal-browser-注释模式 |
| 终端 tmux 恢复                       | architecture/terminal-tmux-recovery.md                          |
| 终端完成事件 Hook                    | architecture/terminal-completion-hooks.md                       |
| 终端任务完成通知（桌面/飞书）        | architecture/terminal-completion-notifications.md               |
| Multi-Agent Orchestrator / Do-A-IDEM | architecture/multi-agent-orchestrator.md                        |
| 本机系统资源监控                     | architecture/system-monitor.md                                  |

## 操作指南（活文档）

| 需求                  | 阅读                                 |
| --------------------- | ------------------------------------ |
| Terminal CLI          | cli/terminal-cli.md                  |
| 部署 / 环境概览       | deployment/overview.md               |
| Electron 本地自动更新 | deployment/electron-local-updates.md |

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
| Terminal activeCommand 一致性测试        | testing/terminal-active-command-consistency-test-cases.md                          |
| App 设备在线测试                         | testing/app-device-online-test-cases.md                                            |
| app-server CLI 启动测试                  | testing/app-server-event-center-test-cases.md#as-ec-008-cli-owned-app-server-start |
| Runweave Agent CLI 控制面测试            | testing/runweave-cli-control-plane-test-cases.md                                   |
| Agent Team / Loop Engineer 测试          | testing/agent-team-loop-engineer-test-cases.md                                     |
| Terminal Panel Split 测试                | testing/terminal-panel-split-test-cases.md                                         |
| 本地客户端更新测试                       | testing/runweave-local-client-update-test-cases.md                                 |
| Terminal Browser CDP/MCP 测试            | testing/terminal-browser-cdp-mcp-test-cases.md                                     |
| Terminal Browser Playwright MCP 工具测试 | testing/terminal-browser-playwright-mcp-test-cases.md                              |
| 终端回归（Vim）                          | testing/runbooks/terminal-vim.md                                                   |
| Explorer Quick Search 回归               | testing/runbooks/explorer-quick-search.md                                          |

## 历史归档（冻结，不代表当前事实）

| 目录        | 内容                                               |
| ----------- | -------------------------------------------------- |
| plans/      | 按日期沉淀的设计计划稿（见 plans/README.md）       |
| review/     | 计划与代码评审记录（见 review/README.md）          |
| prototypes/ | 可运行 HTML/JS 交互原型（见 prototypes/README.md） |

> 注：`quality/2026-05-03-terminal-preview-panel-review.md` 是一次性评审记录（性质同 review/），历史原因留在 quality/ 目录，不属于活的质量文档。

---

## 维护边界

- **本文件是唯一完整索引。** root `README.md` 只保留面向用户的精选链接，`AGENTS.md` 不再维护路由表。新增/移动活文档时，只在这里同步。
- 文档整理只维护当前事实、稳定边界和验证入口。一次性计划、执行记录、临时排障过程应沉淀进上表的活文档；核心结论被吸收后，冗余材料可归档或删除。
- 纯文档保鲜不修改代码、配置或 lockfile。发现代码侧问题时，先在整理报告里列为待处理项，不顺手修代码。
