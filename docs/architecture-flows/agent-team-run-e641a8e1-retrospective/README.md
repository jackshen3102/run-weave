# Agent Team run e641a8e1 复盘

本页复盘 `atr_e641a8e1_20260717180414` 从 2026-07-17 18:04 到 2026-07-18 11:47 的执行链路，重点解释为什么代码修复相对小，但整体流程被投递、恢复协议、运行环境和验收合同放大。

## 事实基线

- Run 状态：`need_human / executing`
- 验收：23 条中 22 条通过，WTC-020 因 Dev Session 不提供 `app` surface 而 pending
- 人工 intervention：15 次
- Loop 日志：75 条
- 真实产品缺陷：WTC-009、WTC-012
- 已确认框架缺陷：长 prompt 单参数投递、dispatch 与 pane 状态漂移、active thread 消息投递未复用统一队列、协议补交与行为复验耦合、验收文件生命周期不稳定。其中长 prompt、缺失 activeWorkerDispatch 的一次性自动重建，以及 running/idle agent 的直接消息投递已在本轮修复。

## 查看

```bash
python3 -m http.server 6188 --directory docs/architecture-flows/agent-team-run-e641a8e1-retrospective
```

打开 `http://127.0.0.1:6188/`。

## 证据来源

- `.runweave/agent-team/atr_e641a8e1_20260717180414.json`
- `.runweave/outbox/e641a8e1.panel-2286cd51-ff68-4364-a74b-e08087376466.json`
- `.runweave/outbox/e641a8e1.panel-58b80d1f-8b21-4367-b82f-796d6ec93f5f.json`
- `.runweave/evidence/dvs-250c54/`
- `.runweave/evidence/dvs-9cbb52/`
- `.runweave/evidence/dvs-af2dda/`
- `backend/src/agent-team/service-worker-dispatch-support.ts`
- `backend/src/agent-team/service-completion.ts`
- `backend/src/agent-team/service-repair-protocol.ts`
- `backend/src/terminal/tmux-internals.ts`
