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
