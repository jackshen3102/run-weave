---
name: review-agent
description: 在原生 CLI 中通过 @review、@review-agent 或明确的独立代码审查请求，代发给 Runweave 独立 Review Agent，读取状态与真实报告；当前 Agent 已是 Reviewer 时不触发。
---

# 代发独立 Review

用户仍在当前 CLI 对话。调用 `rw terminal review` 复用 Backend 的独立 Reviewer；不要由当前
Agent 自己代替审查，也不要启动通用子 Agent 来绕过该流程。普通就地评审沿用 review-only。
已经拿到冻结输入和结构化 Review 输出合同的 Reviewer 直接审查，不递归派工。

## 发起

命令使用 `${RUNWEAVE_CLI_BIN:-rw}`。需要支持 `terminal review` 的 CLI 和具备代码 Review
服务的 Backend；命令不存在时明确版本缺口，不自行升级或改用其他审查方式。

- 默认来源是 `RUNWEAVE_TERMINAL_SESSION_ID`，即当前 Runweave 托管的原生 CLI 终端。
  外部原生终端也可调用，但必须提供已明确选定的来源 terminalSessionId 和对应连接配置；
  不根据 cwd、最近活跃记录或相似名称猜来源。
- 为这次用户请求生成一个 UUID，记录它和来源 ID，再发起。相同请求恢复查询时保留原 ID；
  用户明确要求新一轮复审才生成新 ID。用户不需要手填编号。
- 本入口审查来源终端所属项目的当前 staged、working、untracked 改动，Backend 冻结原生
  用户要求及明确引用的计划。不传入完整对话、实现者自评或 Skill 编造的需求。若用户指定
  任意 PR、分支、其他工作区或只审某个文件，先说明范围不匹配，不擅自改成全工作区审查。

```sh
"${RUNWEAVE_CLI_BIN:-rw}" terminal review start --request-id <本次UUID> --json
# 外部终端或用户已指定来源时，在 start 后传入 terminalSessionId。
```

保存响应的 `reviewId`、`caseId`、`round` 和 `reviewerTerminalId`。开始响应可能尚未分配
Reviewer；用后续查询核对，不能把 `preparing` 说成已经审完。重复请求由 Backend 去重；
同来源正在执行时沿用当前轮次，新消息不会自动追加进已冻结输入，报告这一点。

## 读取与回报

```sh
"${RUNWEAVE_CLI_BIN:-rw}" terminal review wait <reviewId> --wait-ms 30000 --json
"${RUNWEAVE_CLI_BIN:-rw}" terminal review show <reviewId> --json
"${RUNWEAVE_CLI_BIN:-rw}" terminal review list --json
# 历史分页使用 list --before <上页before>；同样可显式指定来源 ID。
```

默认继续读取本轮结果；等待期间简短说明进度。`waitTimedOut` 只表示这一段等待结束，
不会取消审查；继续查询原 reviewId，不再次 start。用户只要求发起时给出编号与查询方式。
正数等待期限也约束 HTTP 查询；若到期前尚无首个响应，run/snapshot/report 为 null，使用返回
的 reviewId 继续查询，不把缺少状态解释为审查失败。wait-ms=0 仅执行一次查询。
网络结果未知时先 list 查询原 requestId，再用同一 ID 恢复，不换 ID 盲目重发。

读取保存的独立报告和 run 状态，核对范围、快照有效性及回传结果。默认只回报已实际复现的
Bug：级别、位置、标题、影响和证据。未验证目标、覆盖缺口和 limitations 保留在完整报告，
不逐项转抄到来源终端；用户明确询问时再解释。零 Bug 不发送问题反馈，也不代表需求已经
全部验证。原 CLI 报告必须基于保存的报告，不冒充 Reviewer 作答。

Backend 仅自动回传已复现的 Bug；Skill 不再向来源终端 send 一份。没有已复现 Bug 时
delivery 为 skipped，即使报告仍有验收阻塞。不要自动关闭事项或追着重试失败的 Reviewer。
独立 Reviewer 只审查、不修改业务代码；来源实现 Agent 收到问题后，按原任务已有授权继续
修复并验证，不因调用 Review 或收到自动反馈而要求用户重复授权。用户明确要求只审查、
不修改、等待确认、停止或已人工接管时遵循最新限制；超出原任务范围的操作仍需相应授权。
复审按新请求冻结新快照，Backend 决定安全复用原 Reviewer 或创建新会话。
这不是任意聊天转发，目前仅有 Review 一个目标。
