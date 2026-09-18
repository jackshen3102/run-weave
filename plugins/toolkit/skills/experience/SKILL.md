---
name: experience
description: 排查当前项目反复出现的故障、查找以前验证过的处理办法，或选择有历史证据的验证路径时，检索该项目的经验并记录实际采用结果。适用于任意 Git 项目；不检索其他项目，不用于每次任务的例行搜索。
---

# 当前项目的经验

当历史处理可能改变本次排查、修复或验证路线时使用。先用当前问题里的具体症状、
错误文本和工具名检索；普通新功能、改文案或无历史线索的简单任务无需例行调用。
不要要求项目提供或修改 `AGENTS.md`，也不要将经验写进它。

## 检索

在用户当前任务所在目录执行已安装的 CLI，保留该目录作为 cwd：

```bash
rw experience search --cwd "$PWD" --query '具体症状及相关工具' --json
```

- 使用宿主提供的 CLI 及连接配置；已明确提供绝对 CLI 入口时用它替代 `rw`。
  保持任务所在目录，不切到 CLI 的安装目录再检索。
- 沿用 CLI 已配置的连接与认证；仅在宿主明确给出目标时覆盖。
  端口只负责连接，不是项目身份；不要遍历端口寻找记录。
- 未安装 CLI、没有 experience 命令、API 404 或认证失败，说明入口不可用并继续原任务。
  不将这些错误说成“没有经验”，不读取凭据或自行启动服务。
- 核对响应的 `repositoryId` 和 `namespace`。同仓库 worktree 共用身份；独立仓库隔离，
  即使同名、相同 remote 或错误文本也不混用。非 Git 目录目前不支持，不回退到全局经验。
- 无匹配就继续正常排查，不换 cwd 到别的仓库，也不反复扩大查询直到命中。
- 查询用自然问题中的组件或工具名加具体症状，例如“rw 全局 CLI 更新后版本相同”，
  不需要猜记录标题或拼接完整命令。零命中也是真实结果，不为补回执制造一次命中。

## 核对与采用

`matches` 最多三条。读取 `record.applicability`、`avoid`、`actions`、`verification` 和
`evidence`。原始证据由绝对路径与行范围定位；原文件已清理时可读 `evidence.archived.text`，
明确它是脱敏摘录。结合当前代码、版本、环境和实际结果决定是否采用。

`excluded` 中的记录不作为当前建议；必要时通过下列入口调查原因：

```bash
rw experience show EXPERIENCE_ID --cwd "$PWD" --json
```

经验独立存储，源码变化不自动使其失效；可选的 `codePaths` 仅供定位。
同仓库 worktree 共用经验，但各自的版本、配置和环境仍须现场核对。经验是线索，
用户要求与现场事实优先。保留历史反例和未验收范围，不重复实现已经存在的修复。

## 结果回执

经验实际改变了行动，或经核对被明确否决时，写一份本次结果 JSON，再提交：

```bash
rw experience feedback --cwd "$PWD" --file /absolute/receipt.json --json
```

JSON 字段：`lookupId`（本次查询）、`id`、`revision`（命中记录）、`task`（当前任务标识）、
`decision`（`used` / `dismissed`）、`reason`、`action`、`outcome`、
`result`（`succeeded` / `failed` / `unknown`）、`evidence`。
每项 evidence 包含 `path`（本机绝对路径）、`startLine`、`endLine`（从 1 起）与 `note`。
`used` 必须附本次实际结果证据；`dismissed` 可用空 evidence。
沿用实际采用时的 `lookupId`、`id` 和 `revision`，不为提交反馈重新检索或换成最新版。
项目代码变化、经验更新或过期后，仍可记录该次历史结果。只附必要片段，不保存凭据。
未验证不能写 succeeded；采用失败须记录 failed。当前版本的失败会停止推荐，旧版本的
失败保留在历史中，不直接停用新版。回执是 Agent 报告，不能单凭它宣称因果收益。

向用户说明哪条经验改变了什么操作，以及本次观察到什么结果。召回和采纳次数不是效果。
验收夹具、离线命中探针及为复盘构造的任务必须注明用途，不能作为自然任务的复用收益。
