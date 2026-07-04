# Runweave 文档总览

面向 Runweave 工程与智能体的文档入口。按需阅读，避免在单一文档里堆叠细节。

## 路由

| 需求                                     | 阅读                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 开源项目入口与快速开始                   | ../README.md 或 ../README.zh-CN.md                                                 |
| 架构/网络拓扑                            | architecture/network-topology.md                                                   |
| app-server 架构概览                      | architecture/app-server-architecture.md                                            |
| app-server Event Center 细节             | architecture/app-server-event-center.md                                            |
| app-server CLI 启动测试                  | testing/app-server-event-center-test-cases.md#as-ec-008-cli-owned-app-server-start |
| App 移动端边界                           | architecture/app-mobile.md                                                         |
| App 后端连接管理                         | architecture/app-mobile.md#配置与安全                                              |
| App 终端语音输入                         | architecture/app-mobile.md#app-终端语音输入                                        |
| App 终端输入与快捷键                     | architecture/app-mobile.md#app-终端详情                                            |
| 终端状态模型                             | architecture/terminal-state.md                                                     |
| 终端代码预览 / Terminal Browser          | architecture/terminal-code-preview.md                                              |
| Web Terminal 快捷指令                    | architecture/terminal-code-preview.md#快捷指令入口                                 |
| Terminal Browser 注释模式                | architecture/terminal-code-preview.md#terminal-browser-注释模式                    |
| 终端 tmux 恢复                           | architecture/terminal-tmux-recovery.md                                             |
| 终端完成事件 Hook                        | architecture/terminal-completion-hooks.md                                          |
| 终端任务完成通知（桌面/飞书）            | architecture/terminal-completion-notifications.md                                  |
| Multi-Agent Orchestrator / Do-A-IDEM     | architecture/multi-agent-orchestrator.md                                           |
| 本机系统资源监控                         | architecture/system-monitor.md                                                     |
| Terminal CLI                             | cli/terminal-cli.md                                                                |
| Runweave Agent CLI 控制面测试            | testing/runweave-cli-control-plane-test-cases.md                                   |
| Agent Team / Loop Engineer 测试          | testing/agent-team-loop-engineer-test-cases.md                                     |
| Terminal Panel Split 测试                | testing/terminal-panel-split-test-cases.md                                         |
| 本地客户端更新测试                       | testing/runweave-local-client-update-test-cases.md                                 |
| 质量体系概览                             | quality/quality-harness.md                                                         |
| AI 诊断日志 / Web 日志上报               | quality/ai-diagnostic-logging.md                                                   |
| 后端滚动日志                             | quality/backend-rolling-logs.md                                                    |
| 按需录屏的浏览器 MCP 验证                | quality/recorded-browser-mcp-verification.md                                       |
| 终端性能优化                             | quality/terminal-performance-optimization.md                                       |
| 测试层级与命名                           | testing/layers.md                                                                  |
| 测试命令选择                             | testing/command-matrix.md                                                          |
| Terminal Browser CDP/MCP 测试            | testing/terminal-browser-cdp-mcp-test-cases.md                                     |
| Terminal Browser Playwright MCP 工具测试 | testing/terminal-browser-playwright-mcp-test-cases.md                              |
| 终端回归                                 | testing/runbooks/terminal-vim.md                                                   |
| 部署/环境概览                            | deployment/overview.md                                                             |
| Electron 本地自动更新                    | deployment/electron-local-updates.md                                               |

## 维护边界

文档整理只维护当前事实、稳定边界和验证入口。新增计划、一次性执行记录或临时排障过程，默认应沉淀进上表的权威文档；如果核心结论已经被吸收，冗余材料可以删除。

纯文档保鲜不修改代码、配置或 lockfile。发现代码侧问题时，先在整理报告里列为待处理项，不顺手修代码。
