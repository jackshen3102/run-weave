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

创建文件是 `CreateScheduledTaskRequest`：`name`、`projectId`、`provider`、`prompt`、`schedule`、`misfirePolicy`、`enabled` 必填；`model`、`effort`、`executionPolicy` 可选。编辑文件是 `UpdateScheduledTaskRequest`：只放修改字段和从 `get` 读取的 `expectedRevision`；`model`、`effort` 可用 `null` 恢复默认。具体字段与合法范围以 Backend 的严格 schema 和 `validate-*` 结果为准。默认不开启任何额外运行或删除操作。

创建时保留本次 UUID 与原文件。若请求结果未知，只能用**相同文件、摘要、Backend 和 Idempotency-Key**核对或重试；新键会创建第二个任务。编辑没有幂等键：结果未知时先 `get`，核对 revision 和字段，不能盲目重复 `update`。旧 revision 返回冲突，应重新读取、整理并请用户再次确认。认证失效时沿用 `rw auth` 的 profile 刷新机制，不把 token 写入草稿或命令参数。

`--profile` 与 `--backend-port` 可指定连接；`RUNWEAVE_BASE_URL` 及 `RUNWEAVE_ACCESS_TOKEN` 也遵守现有 `rw` 规则。`--json` 输出机器可读 JSON；非 JSON 模式输出格式化 JSON。CLI 退出非零表示请求未确认成功，不能仅凭命令启动或网络发送宣称任务已创建。
