# CLI 文档

当前命令实现位于 `packages/runweave-cli/`，修改 CLI 前先读
`../../packages/runweave-cli/AGENTS.md`。

| 任务                                         | 文档                                                       |
| -------------------------------------------- | ---------------------------------------------------------- |
| 实例配置查询、迁移和显式加载                 | [configuration.md](./configuration.md)                     |
| Terminal、Project、输入投递与 Agent 控制     | [terminal-cli.md](./terminal-cli.md)                       |
| Terminal 快照分享、匿名读取与有效期          | [terminal-snapshot-share.md](./terminal-snapshot-share.md) |
| Agent Team 创建、执行、观察和介入            | [agent-team-cli.md](./agent-team-cli.md)                   |
| iOS 两台模拟器跨 worktree 复用               | [ios-simulators.md](./ios-simulators.md)                   |
| 普通会话经验检索与结果回执                   | [experience-cli.md](./experience-cli.md)                   |
| Agent Self-Evolution 操作                    | [evolution-cli.md](./evolution-cli.md)                     |
| 成果引用与 Agent 复查                        | [knowledge-cli.md](./knowledge-cli.md)                     |
| Agent 整理、校验并确认后创建或编辑定时任务   | [scheduled-task-cli.md](./scheduled-task-cli.md)           |
| Terminal Browser Profile、网页工具与人工协助 | [browser-profile.md](./browser-profile.md)                 |

命令、参数、JSON 输出或退出码变化时，同一改动内更新对应文档。

## 飞书 Bridge 恢复

`rw feishu bridge --json` 是常驻进程；单实例锁保持至退出，SIGINT/SIGTERM 会关闭连接并
保留尚未发送的等待消息。网络、后端和认证恢复状态写 stderr，包含 UTC 时间戳。
消息等待上限为创建后 120 秒，已开始发送但结果未知的消息不会自动重发。
认证从所选实例的 YAML profile 读取并串行刷新；认证刷新须明确实例目标。启动时后端暂时不可用不阻止飞书连接；首次使用仍需 `rw auth login`。
单实例和状态写入锁由操作系统持有，崩溃/重启后自动释放，不根据持久化 PID 判断存活。
升级旧锁协议及安装依赖的要求见 [飞书部署](../deployment/feishu-app-integration.md)。
详细合同见 [桌面与飞书完成通知](../architecture/terminal-completion-notifications.md)。
