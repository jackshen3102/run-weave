# Evolution CLI

`rw evolution` 通过当前 CLI profile 对应的 Backend API 管理 Evolution Run、Schedule 和
Provider 状态。它不会在 Backend 不可用时降级为直接读写 `learning.sqlite`。

所有命令支持 `--json` 或 `--plain`，并复用通用的 `--profile`、`--backend-port` 和登录态。

## Run

`run` 和 `schedule create` 默认使用调用目录；`--cwd` 可显式指定仓库工作目录。
旧 `--project-id` 仍可作为兼容入口，由 Backend 解析其当前路径；不能与 `--cwd` 混用。
不同 Project 指向同一个 Git common directory 时共享 `learningScopeId`。
`list` 默认仍查询全部历史，显式 `--cwd` 才按仓库筛选；与 `--learning-scope-id` 互斥。
旧 scope 查询只有已审计且唯一的映射才转换，歧义或缺少归属会返回明确错误。

创建 standard/auto Run：

```bash
rw evolution run \
  --cwd /absolute/path/to/repository \
  --analysis-profile standard \
  --provider-policy auto \
  --json
```

可选数据边界：

```bash
rw evolution run \
  --cwd /absolute/path/to/repository \
  --after-watermark <repositoryBindingOffset> \
  --at-or-before 2026-07-25T01:00:00.000Z \
  --plain
```

可覆盖预算：

```text
--max-agents
--max-model-turns
--max-wall-time-ms
--max-context-bytes
--max-tool-calls
--max-replays
```

预算是硬上限。达到上限的 Run 进入明确的 `partial`，已有 attempt 保留，但不提交长期知识。

查询：

```bash
rw evolution list --limit 50 --json
rw evolution list --cwd /absolute/path/to/repository --json
rw evolution list --learning-scope-id <scopeId> --stage completed --plain
rw evolution get <runId> --json
```

取消与重试：

```bash
rw evolution cancel <runId> --json
rw evolution retry <terminalRunId> --json
```

`retry` 只接受终态 Run，沿用原 profile、Provider policy、预算和数据范围，创建新的
`runId`；它不会原地改写旧 Run。

## Provider availability

```bash
rw evolution providers --plain
rw evolution providers --json
```

输出区分：

- binary 是否存在；
- 当前本机是否已认证；
- Provider 版本；
- Evolution runtime 是否可用；
- 不可用原因。

`auto`、显式 `codex|trae` 和 `mixed` 的 fallback/blocked 语义由 Backend 决定，CLI 只呈现
同一 API 结果，不自行替换 Provider。

## Schedule

列出：

```bash
rw evolution schedule list --json
rw evolution schedule list --learning-scope-id <scopeId> --plain
```

创建：

```bash
rw evolution schedule create \
  --cwd /absolute/path/to/repository \
  --name "daily evolution" \
  --cron "0 3 * * *" \
  --timezone Asia/Shanghai \
  --analysis-profile standard \
  --provider-policy auto \
  --data-window since_last_success \
  --enabled true \
  --json
```

更新：

```bash
rw evolution schedule update <scheduleId> \
  --cron "30 3 * * *" \
  --timezone Asia/Shanghai \
  --enabled false \
  --json
```

`update` 至少需要一个 Schedule option。可更新 `--name`、`--cron`、`--timezone`、
`--enabled`、profile、Provider policy、data window 和预算。

删除：

```bash
rw evolution schedule delete <scheduleId> --plain
```

删除 Schedule 不删除已完成的 Run、Insight、Candidate 或 RuntimeTrace。

## 输出与错误

文本模式面向人阅读；JSON 模式返回 Backend 的稳定对象，适合脚本：

```bash
run_json="$(rw evolution run --cwd /absolute/path/to/repository --json)"
run_id="$(printf '%s' "$run_json" | jq -r '.runId')"
rw evolution get "$run_id" --json
```

下列情况以非零退出码明确失败：

- 当前 profile 没有有效认证；
- Backend 连接失败或已停止；
- 参数、枚举、整数范围或 timezone 非法；
- Run/Schedule 不存在；
- 非终态 Run 被重试；
- Evolution runtime degraded/unavailable。

错误不会输出 Provider 凭据，也不会在本机创建替代 Run 或修改 Schedule。

## 相关文档

- 架构与治理：[Agent Self-Evolution V1](../architecture/agent-self-evolution.md)
- 核心测试计划：
  [agent-self-evolution-core.testplan.yaml](../testing/evolution/agent-self-evolution-core.testplan.yaml)
- 激活测试计划：
  [agent-self-evolution-activation.testplan.yaml](../testing/evolution/agent-self-evolution-activation.testplan.yaml)

`rw evolution providers` 在运行时不可用时显示 `Runtime reason`；JSON 的
`runtimeUnavailableReason` 区分 `migration_required`、`migration_incomplete`、
`schema_incompatible` 与 `storage_unavailable`。正常时为 `null`，旧后端可能省略此字段。
迁移类错误按 [仓库身份迁移指南](../deployment/evolution-repository-migration.md) 处理；
版本不兼容需升级后端，其他存储故障需检查后端日志与数据目录。诊断响应不暴露原始数据库错误。
