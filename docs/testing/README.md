# 测试与验收

本目录保存**测试合同和操作规则**，不是单元测试目录。新增或重写测试计划只使用
`*.testplan.yaml`，每个文件最多 20 个 case。

## 先读规则

| 任务                            | 文档                                         |
| ------------------------------- | -------------------------------------------- |
| YAML schema、Case ID 与拆分规则 | [test-plan-format.md](./test-plan-format.md) |
| 自动化、脚本和人工证据分层      | [layers.md](./layers.md)                     |
| 按改动类型选择命令              | [command-matrix.md](./command-matrix.md)     |

## 按能力找计划

| 目录                               | 范围                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| [`agent-team/`](./agent-team/)     | Agent Team 生命周期、执行、恢复、配置与干预          |
| [`app/`](./app/)                   | Ionic App、App Server 与设备连接                     |
| [`architecture/`](./architecture/) | 跨运行时架构与 Activity 数据底座                     |
| [`browser/`](./browser/)           | 浏览器和原型画廊                                     |
| [`evolution/`](./evolution/)       | Agent Self-Evolution                                 |
| [`platform/`](./platform/)         | Dev Session、Beta Pool、桌面 companion 与 CLI 控制面 |
| [`runbooks/`](./runbooks/)         | 可重复执行的人工操作流程                             |
| [`terminal/`](./terminal/)         | Terminal、Browser、tmux、MCP 与 Worktree Context     |

## 验证

```bash
pnpm testplan:validate
pnpm testplan:verify
```

静态门禁不是 UI 或运行行为证据。测试计划要求浏览器或桌面行为时，必须按根 `AGENTS.md`
执行真实环境验证并保留计划要求的证据。
