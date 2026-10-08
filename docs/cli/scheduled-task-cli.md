# 定时任务 CLI

`rw scheduled-task` 通过现有 Runweave profile 鉴权，操作当前 Backend 的定时任务。
创建和编辑由 `$toolkit:scheduled-task` 组织用户确认；CLI 校验文件摘要和 Backend 地址，防止确认后误用改过的请求或另一条连接。`validate-*` 只读，`create` 和 `update` 才写入。

```bash
rw auth status --json
rw scheduled-task projects --json
rw scheduled-task capabilities --json
rw scheduled-task list --json
rw scheduled-task get <task-id> --json
rw scheduled-task validate-create --file /private/draft.json --json
rw scheduled-task validate-update <task-id> --file /private/patch.json --json
```

`projects` 返回父项目及其 Worktree contexts，使用精确 `projectId`。`list` 可用 `--project-id`、`--parent-project-id`、`--q`、`--archived true|false` 过滤；不传时返回 Backend 默认第一页。验证响应包含完整请求、SHA-256、Backend 地址、项目名称与路径、provider、启用状态以及后续 UTC 运行时间。只有当前配置通过与正式写入相同的服务校验时，`validate-*` 才成功。时间预览是验证当刻的结果；写入时会重新计算下一次执行时间。

用户核对**完整请求和目标 Backend**后，原样使用验证响应的 `sha256` 与 `backend`：

```bash
rw scheduled-task create --file /private/draft.json --sha256 <验证响应的 sha256> --expected-backend <验证响应的 backend> --idempotency-key <本次唯一 UUID> --json
rw scheduled-task update <task-id> --file /private/patch.json --sha256 <验证响应的 sha256> --expected-backend <验证响应的 backend> --json
```

创建文件是 `CreateScheduledTaskRequest`：`name`、`projectId`、`provider`、`prompt`、`schedule`、`misfirePolicy`、`enabled` 必填；`model`、`effort`、`executionPolicy`、`continuationPolicy` 可选。`executionPolicy` 可为 `sandbox`、`auto-review` 或 `full-access`，省略时仍为 sandbox；可用值以当前 Backend capabilities 为准，不支持的值会被 `validate-*` 明确拒绝而不会降级。`full-access` 无沙箱且不等待交互审批，可联网并访问 Browser、模拟器和本机文件，只应使用可信提示词。Browser、模拟器、网络或 Git 不是额外配置字段，是否使用由完整提示词和对应 Skill 决定。编辑文件是 `UpdateScheduledTaskRequest`：只放修改字段和从 `get` 读取的 `expectedRevision`；`model`、`effort` 可用 `null` 恢复默认。具体字段与合法范围以 Backend 的严格 schema 和 `validate-*` 结果为准。默认不开启任何额外运行或删除操作。

创建时保留本次 UUID 与原文件。若请求结果未知，只能用**相同文件、摘要、Backend 和 Idempotency-Key**核对或重试；新键会创建第二个任务。编辑没有幂等键：结果未知时先 `get`，核对 revision 和字段，不能盲目重复 `update`。旧 revision 返回冲突，应重新读取、整理并请用户再次确认。认证失效时沿用 `rw auth` 的 profile 刷新机制，不把 token 写入草稿或命令参数。

`--profile` 与 `--backend-port` 可指定连接；`RUNWEAVE_BASE_URL` 及 `RUNWEAVE_ACCESS_TOKEN` 也遵守现有 `rw` 规则。`--json` 输出机器可读 JSON；非 JSON 模式输出格式化 JSON。CLI 退出非零表示请求未确认成功，不能仅凭命令启动或网络发送宣称任务已创建。

## 后台续接与人工回复

`continuationPolicy.mode` 为 `off` 或 `bounded`，随运行快照冻结；配置更改不修改已开始的运行。
旧任务缺省关闭，新 Web/iOS 表单在 provider 支持原会话恢复时默认开启；新快捷运行默认值见
[运行配置](./configuration-reference.md#scheduledtasksquickinputdefaultscontinuationmode)。
Backend 需确认 `codex exec resume` 能力，不支持时拒绝开启，不降级为新对话。

自动续接沿用同一 run、thread、目录、模型与权限。仅结构化的 `continue/remaining-work`、
`wait/transient` 和 `wait/external-wait` 可以自动推进；输入、权限拒绝、未知结果、进程异常与结果缺失
保留人工入口，不把系统提示视为新授权。写操作超时先核对外部事实，不能盲目重复。

每次运行最多自动续接 3 次。新剩余工作可立即推进；等待或重复建议按 1、5、15 分钟退避，
不早于服务明确的最早恢复时间。首次可恢复结果开启 60 分钟窗口，各轮累计使用原执行时长与输出预算。
等待释放全局执行槽，同任务仍视为未结束。重启只恢复持久化的待续接；在途所有权不明时保留现场。

Web/iOS 详情可直接回复受阻事项，无需先打开终端。Backend 接口为
`POST /api/scheduled-tasks/runs/:runId/continue`，要求 `expectedRevision` 和 `Idempotency-Key`。
带 `reply` 时记录真实用户原文，允许未归档、未被终端接管且有原会话的 failed/cancelled 运行重新入队；
沿用累计预算，不消耗或重置自动续接次数。重复请求不重复执行，旧 revision 或同 key 不同回复拒绝。
`recovery.confirmation` 只承载明确动作与范围；“允许并继续”发送该事项的完整确认，泛泛“继续”不能扩大授权。
CLI 创建与编辑任务不等于已发送运行回复，也不自动启动一次运行。

停止、后台领取和终端接管互斥；已有终端绑定不能自动拉回后台。终端内任意后续 final 不回写原任务结果。
等待期间不发送终态通知，最终通知按 run ID、resultRevision 和订阅去重。
验收合同见 [后台续接](../testing/scheduled-tasks/continuation.testplan.yaml)，
接口与策略以 [Backend 路由](../../backend/src/routes/scheduled-tasks.ts)、
[续接规则](../../backend/src/scheduled-tasks/continuation.ts) 和
[共享合同](../../packages/shared/src/scheduled-tasks/index.ts) 为准；文档检查不代表实际恢复或跨端验收通过。
