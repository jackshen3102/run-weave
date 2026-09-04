---
name: handoff
description: 当用户明确要求“交接”“handoff”“把当前任务交给另一个 Agent”时使用；把当前任务写成自包含的 Markdown 交接文档，再让一个零对话上下文的新 Agent 在当前工作区按文档执行。不要用于普通任务拆分、并行调研或 Agent Team 编排。
---

# Handoff

把当前任务交给一个全新的执行 Agent。交接以磁盘上的 Markdown 文档为唯一任务合同，不复制当前对话，也不引入 Runweave 后端、Agent Team、专属 UI 或通知协议。

## 边界

- 仅在用户明确要求交接时触发。
- 新 Agent 必须在当前工作区执行；Worktree 创建、跨 Workspace 放置和长期 Agent 管理不属于本 skill。
- 新 Agent 从零对话上下文启动，只能依赖仓库文件和交接文档。
- 当前 Agent 完成交接后不得继续修改目标文件，避免与执行 Agent 竞争。
- 交接不扩大授权。只读、诊断、实现、提交、推送等语义必须与用户原始要求一致。

## 写交接文档

将文档写入 `.runweave/handoffs/<YYYYMMDD-HHmmss>-<task-slug>.md`。创建前读取当前任务涉及的代码、最近的 `AGENTS.md` 和必要的 Git 状态，不凭记忆补全事实。

文档必须让不了解当前对话的人直接执行，按需包含：

```markdown
# Handoff: <任务标题>

## Task

用祈使句准确描述要完成的工作，并明确是调查、评审、修改还是交付。

## User intent

记录用户真正要解决的问题和已经明确的取舍，不擅自扩大目标。

## Context

说明任务为何存在，以及理解任务所需的最少背景。

## Relevant files

- `path/to/file`：职责和与任务的关系

## Current state

已经完成什么、什么仍未完成、当前已知行为是什么。

## What was tried

- 尝试及结果；没有则写“无”。

## Decisions

- 已确定的决定及原因。

## Acceptance criteria

- [ ] 可独立判断通过或失败的标准。

## Constraints

- 必须保留的行为、权限边界和明确非目标。

## Workspace snapshot

- Working directory
- Git branch and HEAD
- 与本任务相关的未提交改动；不得把无关用户改动归入任务范围

## Verification

应执行的检查及成功标准；未获授权的外部写操作不得写成默认步骤。
```

保留准确的文件路径、错误文本、命令结果和用户决策，但不要复制密钥、Token、Cookie、个人数据或无关的大段日志。调查任务必须明确写 `DO NOT edit files`；修改任务写清允许修改的范围；“提交”“推送”“创建 PR”等权限分别记录，不能相互推导。

## 启动执行 Agent

文档写完后，使用宿主提供的 sub-agent 能力启动一个新 Agent：

- 使用零对话继承模式；在 Codex collaboration 中传 `fork_turns: "none"`。
- 不指定模型覆盖，除非用户明确指定接收 Agent 或模型。
- 给新 Agent 的启动消息只包含交接文档绝对路径和以下要求：先读取适用的 `AGENTS.md`，再把交接文档视为唯一任务合同，完成其中工作和验证，并在文档末尾追加 `## Execution result`，记录结果、验证和遗留问题。
- 不把交接文档内容再次粘贴进启动消息。若不读文档也能执行，说明交接仍依赖了隐藏上下文。

当前 Agent 等待新 Agent 完成，但不实现自己的轮询、状态机或通知协议。执行 Agent 需要用户新增授权或遇到无法从代码判断的产品决策时，将问题原样交还用户。

如果宿主没有 sub-agent 能力，只完成交接文档并明确报告无法启动接收 Agent；不要由当前 Agent 冒充新的执行 Agent。

## 完成

收到执行结果后，当前 Agent 只做必要的事实核对并向用户报告：

- 交接文档路径；
- 执行 Agent 完成了什么；
- 实际执行的验证及结果；
- 未完成项或需要用户决定的事项。

不要把子 Agent 的自述当作已验证事实；高风险或外部状态结果仍需相应证据。
