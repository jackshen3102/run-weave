---
name: review-agent
description: 在原生 CLI 中通过 @review、@review-agent 或明确的独立代码审查请求，异步代发给 Runweave 独立 Review Agent，接收本轮结果；当前 Agent 已是 Reviewer 时不触发。
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
# 外部终端显式传入 terminalSessionId，多面板来源另加 --panel-id <id>。
```

保存 `reviewId`。响应包含 `resultDelivery: "source_conversation"` 时，告知用户请求已受理、结果将回到原会话，
然后结束当前轮或继续独立工作。无需定期查询或查看 Reviewer 终端。缺少该字段时，说明此版本无法承诺后台交卷，
提供原编号供手动查阅。相同请求结果未知时先按来源查询，再用原 requestId 恢复。

## 收到结果

Backend 回传带 `[runweave-code-review-feedback:<reviewId>]` 的本轮结果。按回传内容报告通过、已复现 Bug、
验收阻塞或运行失败，按需阅读其中的报告引用。需要主动查看进度或完整报告时运行
`rw terminal review show <reviewId> --json`。结果对应本轮冻结快照，注意过期标记和核验范围。
覆盖缺口的细节留在完整报告，只把实际复现的问题报告为 Bug。

独立 Reviewer 只审查、不修改业务代码；来源实现 Agent 收到问题后，按原任务已有授权继续
修复并验证，不因调用 Review 或收到自动反馈而要求用户重复授权。用户明确要求只审查、
不修改、等待确认、停止或已人工接管时遵循最新限制；超出原任务范围的操作仍需相应授权。
复审按新请求冻结新快照，Backend 决定安全复用原 Reviewer 或创建新会话。
这不是任意聊天转发，目前仅有 Review 一个目标。
