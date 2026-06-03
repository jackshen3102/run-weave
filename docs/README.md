# Runweave 文档总览

面向 Runweave 工程与智能体的文档入口。按需阅读，避免在单一文档里堆叠细节。

## 路由

| 需求                                     | 阅读                                                  |
| ---------------------------------------- | ----------------------------------------------------- |
| 开源项目入口与快速开始                   | ../README.md 或 ../README.zh-CN.md                    |
| 架构/网络拓扑                            | architecture/network-topology.md                      |
| 移动端 Web 支持                          | architecture/mobile-web-support.md                    |
| 终端代码预览 / Terminal Browser          | architecture/terminal-code-preview.md                 |
| 终端 tmux 恢复                           | architecture/terminal-tmux-recovery.md                |
| 终端完成事件 Hook                        | architecture/terminal-completion-hooks.md             |
| 终端任务完成通知（桌面/飞书）            | architecture/terminal-completion-notifications.md     |
| Terminal CLI                             | cli/terminal-cli.md                                   |
| 质量体系概览                             | quality/quality-harness.md                            |
| AI 诊断日志                              | quality/ai-diagnostic-logging.md                      |
| 按需录屏的浏览器 MCP 验证                | quality/recorded-browser-mcp-verification.md          |
| 终端性能优化                             | quality/terminal-performance-optimization.md          |
| 测试层级与命名                           | testing/layers.md                                     |
| 测试命令选择                             | testing/command-matrix.md                             |
| Terminal Browser CDP/MCP 测试            | testing/terminal-browser-cdp-mcp-test-cases.md        |
| Terminal Browser Playwright MCP 工具测试 | testing/terminal-browser-playwright-mcp-test-cases.md |
| 终端回归                                 | testing/runbooks/terminal-vim.md                      |
| 部署/环境概览                            | deployment/overview.md                                |

## 维护边界

文档整理只维护当前事实、稳定边界和验证入口。新增计划、一次性执行记录或临时排障过程，默认应沉淀进上表的权威文档；如果核心结论已经被吸收，冗余材料可以删除。

纯文档保鲜不修改代码、配置、测试或 lockfile。发现代码侧问题时，先在整理报告里列为待处理项，不顺手修代码。
