# CLI 文档

当前命令实现位于 `packages/runweave-cli/`，修改 CLI 前先读
`../../packages/runweave-cli/AGENTS.md`。

| 任务                                     | 文档                                       |
| ---------------------------------------- | ------------------------------------------ |
| Terminal、Project、输入投递与 Agent 控制 | [terminal-cli.md](./terminal-cli.md)       |
| Agent Team 创建、执行、观察和介入        | [agent-team-cli.md](./agent-team-cli.md)   |
| Agent Self-Evolution 操作                | [evolution-cli.md](./evolution-cli.md)     |
| Terminal Browser Profile 解析与人工协助  | [browser-profile.md](./browser-profile.md) |

命令、参数、JSON 输出或退出码变化时，同一改动内更新对应文档。

## 飞书 Bridge 恢复

`rw feishu bridge --json` 是常驻进程；单实例锁保持至退出，SIGINT/SIGTERM 会关闭连接并
保留尚未发送的等待消息。网络、后端和认证恢复状态写 stderr，包含 UTC 时间戳。
消息等待上限为创建后 120 秒，已开始发送但结果未知的消息不会自动重发。
认证共享 profile 会自动重新读取并串行刷新；使用环境变量指定的 access token 时需由调用方
更新。启动时后端暂时不可用不阻止飞书连接；首次使用仍需 `rw auth login`。
详细合同见 [桌面与飞书完成通知](../architecture/terminal-completion-notifications.md)。
