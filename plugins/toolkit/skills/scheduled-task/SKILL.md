---
name: scheduled-task
description: 在 Runweave 终端用自然语言创建或编辑 Backend 定时任务：Agent 整理配置、只读校验并展示完整草稿，用户确认最终数据后才写入。用户说“帮我设一个定时任务”“修改这个定时任务”等时使用。
---

# 用 Agent 创建或编辑 Runweave 定时任务

本 Skill 管理 **Runweave Backend** 的定时任务，不创建 Codex 或其他产品自己的自动化。入口是 `rw scheduled-task`；在 Runweave 源码 checkout 中可读 `docs/cli/scheduled-task-cli.md`。已安装的 `rw` 没有此命令时，可在当前 Runweave 源码 checkout 运行 `pnpm cli:build` 后使用 `node packages/runweave-cli/dist/index.js`；找不到支持此命令的客户端就报告环境缺口，不绕开鉴权写数据库。

## 整理草稿

1. 用 `rw auth status --json` 确认目标 Backend/profile，用 `rw scheduled-task projects --json` 和 `capabilities --json` 读取可用项目、Worktree context、provider 与执行权限。编辑时先 `list`/`get` 精确定位一条未归档任务；同名多条不能猜测。所有命令使用同一 profile 或 Backend 端口。
2. 把用户的话整理成任务名称、精确项目 ID、provider、完整提示词、时间规则与 IANA 时区、补跑策略、启用状态，以及可选模型、推理强度、执行权限。提示词忠实保留目标、约束和验收条件；不自行增加发布、发送消息、删除或提高权限等动作。用户未指定的值可以提出默认建议，但必须在最终核对中明确展示。当前 Web 默认 Codex、启用、仅沙箱、错过后补最近一次且有效期 24 小时；不要把这些当作用户已确认的选择。
3. 明确一次性时间的日期、时区和 UTC 转换；“明早”“工作日”等相对说法要按当前日期解释并给出绝对日期/规则。缺少项目、时间、时区或任务内容，或存在两种合理解释时先询问。任务提示词提到另一个 Skill 时，确认它在预期后台 Agent 环境可用；无法确认就告知用户这一限制。
4. 在本次唯一的受保护临时路径写 JSON（权限 `0600`）。创建文件使用 `CreateScheduledTaskRequest`；编辑文件只放改动字段和从 `get` 读到的 `expectedRevision`。编辑草稿应同时保存当前任务原文，以便展示修改后的**完整有效配置**。不把访问 token、密码或无关资料写入草稿。

## 只读校验与最终确认

- 创建执行 `rw scheduled-task validate-create --file <草稿> --json`；编辑执行 `rw scheduled-task validate-update <精确 taskId> --file <补丁> --json`。校验复用正式写入的 Backend schema、项目、provider、schedule 和 revision 检查，但不写任务。失败时说明具体问题，修改草稿并重验；不可用 provider、失效项目、过期一次性时间和 revision 冲突不能靠猜测绕过。接口返回 404 表示当前 Backend 尚未提供预校验，应报告需要更新 Backend，不能跳过校验直接写入。
- 以验证响应的 `validation.config` 为准，向用户展示目标 Backend/profile、项目名称/路径/ID、任务 ID（编辑）、完整名称与**完整提示词**、provider/model/effort、执行权限、启用状态、时间规则与时区、下一次及后续预览的本地和 UTC 时间、补跑策略，以及编辑前后变化。连同 `sha256` 明确标识本次请求。预览不保证电脑届时在线；不要声称任务已经创建。
- **等待用户明确确认这份最终配置。** 初始“帮我创建/修改”不等于确认；用户改任何字段、目标 Backend 改变、编辑任务 revision 改变、或一次性时间已过，都要重新校验并再次展示。没有明确确认不得调用 `create` 或 `update`，也不得以准备好的文件代替确认。

## 写入和核对

- 创建：为这份已确认草稿生成并保留一个 UUID 幂等键，调用一次 `rw scheduled-task create --file <草稿> --sha256 <验证响应 sha256> --expected-backend <验证响应 backend> --idempotency-key <UUID> --json`。只有成功响应并通过 `get <返回 taskId>` 核对后，才报告创建成功。
- 编辑：确认前再次 `get` 核对任务仍是原 `expectedRevision`，然后调用一次 `rw scheduled-task update <taskId> --file <补丁> --sha256 <验证响应 sha256> --expected-backend <验证响应 backend> --json`，再 `get` 核对。出现 revision 冲突时保留草稿，重新整理差异并请用户确认，不能覆盖较新版本。
- 创建请求结果不确定时，保留原文件和幂等键；先只读查询，必要时仅用**相同文件、摘要、Backend 和键**重试。编辑结果不确定时先 `get` 对比 revision 与字段，不盲目再次 PATCH。停止、删除或立即运行是独立操作，本 Skill 不因创建/编辑成功而触发。
