# Agent Team CLI

## Export

导出一个 Agent Team run 的复盘包：

```bash
rw agent-team export <runId> --tail 1000 --json
rw agent-team export <runId> --history none --json
rw agent-team export <runId> --plain
```

也可以用项目和终端定位当前 run：

```bash
rw agent-team export --project-id <projectId> --terminal-session-id <terminalSessionId> --tail 1000 --json
```

导出内容包括：

- run package
- run-bound panels 和 session-other panels
- panel history tail
- pane-scoped outboxes 与 legacy session outbox
- acceptance summary
- warnings

`--history` 支持 `none`、`tail`、`full`。默认 `tail`，`--tail` 最大 5000 行。

## Verification fixtures

按父 Run 或精确 behavior dispatch 查看 owned fixture，不隐藏已取消的审计记录：

```bash
rw agent-team fixtures <ownerRunId> --json
rw agent-team fixtures <ownerRunId> --dispatch-id <dispatchId> --plain
```

显式取消单个 Run。primary Run 会冻结 worker、结束控制循环并审计 owned fixture cleanup；
verification fixture 还会默认回收它声明拥有的 terminal/pane：

```bash
rw agent-team cancel <fixtureRunId> --reason "operator cleanup" --json
```

`cancel` 写入可审计的 `cancelled` 终态，不删除 Run JSON 或 outbox history。诊断资源清理问题时可暂用 `--keep-resources`；primary Run 即使 cleanup 审计仍有阻塞也会先停止控制循环，并把阻塞保留在 `fixtureCleanupHistory`。

命令只查询当前 CLI profile 对应的 Backend：父 Backend上的本地 fixture可直接查看；跨 Backend fixture应在owned Dev Session停止前查询candidate profile，停止后的Run/terminal/pane/outbox身份以Dev Session manifest的`fixtureCleanup.resourceLedger`和父Run的cleanup receipt为审计事实。
