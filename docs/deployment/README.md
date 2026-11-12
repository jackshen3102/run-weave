# 部署与运行环境

从 [overview.md](./overview.md) 判断目标运行形态，再进入具体流程。

| 任务                                     | 文档                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| NPM 安装独立后台、常驻和更新             | [服务端管理](../cli/server-cli.md)                                                             |
| NPM 发行流程、devbox 升级与 Agent 操作   | [NPM Server 运维](./npm-server-operations.md)                                                  |
| 配置版本、随包迁移、升级恢复与实施边界   | [配置升级合同](./configuration-upgrades.md)                                                    |
| 部署形态、环境变量和入口总览             | [overview.md](./overview.md)                                                                   |
| 旧源码 / 独立 Backend 迁移到 npm         | [backend-standalone.md](./backend-standalone.md)                                               |
| Linux npm 后台升级与开机自启             | [update-runweave-backend Skill](../../plugins/toolkit/skills/update-runweave-backend/SKILL.md) |
| 新服务器初始化 Pi、搜索与子 Agent 扩展   | [pi-agent-setup.md](./pi-agent-setup.md)                                                       |
| Runweave Beta、Dev Session 与固定槽位    | [runweave-beta.md](./runweave-beta.md)                                                         |
| Linux x64 桌面预览与打包                 | [electron-linux.md](./electron-linux.md)                                                       |
| Windows x64 桌面预览与已有 Server 共存   | [electron-windows.md](./electron-windows.md)                                                   |
| Electron 本地更新                        | [electron-local-updates.md](./electron-local-updates.md)                                       |
| 飞书应用通知与 Terminal 回复             | [feishu-app-integration.md](./feishu-app-integration.md)                                       |
| 推送服务 Lightsail / Docker Compose 部署 | [push-gateway.md](./push-gateway.md)                                                           |
| Evolution 仓库身份升级与恢复             | [evolution-repository-migration.md](./evolution-repository-migration.md)                       |
| ChatGPT 连接本机代码、日志与运行数据     | [Runweave MCP 接入](./runweave-research-mcp.md)                                                |
| 公网终端快照托管                         | [snapshot-share.md](./snapshot-share.md)                                                       |

涉及 Electron 时读 `../../electron/AGENTS.md`；涉及 Dev Session / Beta Pool 时读
`../../scripts/dev-session/AGENTS.md`。不要从历史 plan 推断当前启动或回滚命令。
