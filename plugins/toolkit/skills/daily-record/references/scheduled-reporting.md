# 多机器使用同一 Daily Record 定时任务

每个 Runweave Backend 使用同版 Daily Record Skill 和任务提示词，只读取所在机器的数据，主动上报随记。Mac 可启用本机 Agent、飞书聊天及浏览概览，devbox 只启用本机 Agent；不需要 Mac 发起 SSH 采集，也不增加采集 daemon。当前不做跨机器自动语义合并。

## 前置与配置

已有本机任务时，先在 `~/.runweave/daily-record/` 中查找 `*-job.json`；只有一个任务配置时复用它，多个候选时核对当前机器及来源，不能猜测目标。沿用该配置中的日期、来源、collector、随记目标和状态目录，不重新初始化。执行相邻 `scripts/job.py` 前选择本机 Python 3.9+；macOS 优先使用 Homebrew 的 `python3`，并将 `~/.bun/bin` 和 Homebrew 的 `bin` 加入子进程 PATH，保留原 PATH。

本机需要 Python 3.9+、Node.js 22、同版 `@runweave/daily-record` 构建产物、配套 suiji Skill 和非交互式 Agent 登录。飞书启用的节点另需已授权本人身份的 lark-cli；关闭飞书的节点不检查这个依赖。飞书聊天只采本人发送消息及选定相关回复，文档默认不采。

配置、状态及凭据保存在用户私有目录，目录 0700、文件 0600，不提交 Git。示例中的绝对路径、ID 和首次日期必须替换为实际数据：

```json
{
  "schemaVersion": 1,
  "producerId": "固定的本机UUID",
  "sourceNamespace": "daily-固定的本机UUID",
  "startDate": "2026-10-24",
  "timeZone": "Asia/Shanghai",
  "stateDir": "/absolute/private/daily-state",
  "collectorArgv": [
    "/absolute/node",
    "/absolute/browser-viewer/packages/daily-record/dist/cli.cjs"
  ],
  "sources": {
    "localAgent": { "providers": ["codex"], "home": "/absolute/user-home" },
    "feishu": { "enabled": false, "channels": "messages" }
  },
  "projectAliases": {},
  "suiji": {
    "configPath": "/absolute/private/suiji.json",
    "tokenFile": "/absolute/private/suiji.env",
    "autoPublish": false
  },
  "maxDaysPerRun": 7
}
```

Mac 的 feishu 改为 `{"enabled":true,"channels":"messages","accountScope":"固定的本人账号范围ID"}`。首次验证过的本人 openId 保存到状态，以后账号变化拒绝继续；别把飞书配置复制到 devbox。来源开关、首次日期、机器身份和随记目标被状态绑定，变更会拒绝静默继续；迁移需保留原状态、事项映射和 outbox，不能通过换 ID 来重试。

`home` 指定时忽略继承的 provider HOME 环境变量；省略时沿用本机原生目录。`providers` 明确列出实际需要采集的 Codex/Pi/Claude/Trae，未启用来源不产生不可用回执。

## Mac 浏览来源（可选）

旧配置不需要改动，缺省/关闭不检查浏览依赖。仅在 Mac 给 `sources` 增加：

```json
"browser": {
  "enabled": true,
  "effectiveFrom": "实际启用日期",
  "root": "/absolute/home/.runweave/browser-history",
  "collectorArgv": ["/absolute/node22", "/absolute/private/runtime/browser-history.cjs"],
  "expectedSourceIds": ["从本机browser-history status取得的实际UUID"]
}
```

日期不早于 job.startDate；生效日前不期待浏览 scope。固定 runtime 与同版 Skill 一起部署，不能依赖临时 worktree。
配置只消费已落盘日志，不安装扩展或自动改变记录开关。预期来源白名单之外的 Profile 不进入报告。

已有状态不能直接编辑 sources。生成受保护的新配置后执行
`job.py migrate-sources --config <原配置> --next-config <新配置> --dry-run`，核对受影响日期后用同参数去掉 dry-run 执行。
迁移仅允许增加 browser，不能改旧机器/目标/来源；有任何未结束批次时先恢复原流程。
迁移持锁、备份并保存 journal；中断后原样重跑迁移，不能手动删除 journal 或重置 state。
原事项键、历史回执和 outbox 保留，生效日后的日期重新检查浏览完整性。

服务先升级并声明 `features.workBrowserHistory=true`，再登记机器级 scope
`browser:<producerId>:observed`，名称“Mac 浏览概览（仅已记录访问）”，producer/namespace 沿用本机，effectiveFrom 与配置一致。
现存登记日志全部读完可为 complete，但不代表全天浏览覆盖；partial/unavailable 保留补采义务。
独立浏览主题仅 documented，每天至多 3 条、每条正文至多 160 字；优先合并到原事项，完整依据仅留本地。
未启用浏览的 devbox 不要求任何浏览 CLI、扩展或配置。浏览验证见
[浏览接入合同](../../../../../docs/testing/skills/daily-record-browser.testplan.yaml)。

## 随记来源登记

随记 schema 11 提供 `features.workSources`。先在管理员环境登记每个预期来源，再启用任务；使用 `MIGRATION_DATABASE_URL` 的既有管理员进程，不给 API 迁移凭据。`pnpm --filter @runweave/suiji-server work:sources register` 从 stdin 接受：

```json
{
  "ownerId": "实际owner UUID",
  "sourceScope": "agent:固定的本机UUID:codex",
  "producerId": "固定的本机UUID",
  "sourceNamespace": "daily-固定的本机UUID",
  "name": "Mac Codex",
  "effectiveFrom": "2026-10-24",
  "effectiveTo": null
}
```

Mac 飞书另登记 `feishu:<accountScope>:messages`，producerId/sourceNamespace 属于 Mac；同一 sourceScope 的生效区间不可重叠。每个 provider 各自登记。容器管理员入口为 `work-sources register|list|stop`；list 的 stdin 为 ownerId/from/to，stop 为 ownerId/sourceScope/effectiveTo。结束日期不含当天，停用不能早于上海今天，不能追溯消除缺报。

每日 coverage 对照有效登记：全部来源 complete 才完整；未上报来源和 partial/unavailable 均不完整；未登记旧日期为 unknown。显式日期范围最多 366 天，包括全无事实的缺报日期。`suiji.py work-sources --from ... --to ...` 只读查看预期来源、实际回执和 missingScopes。

## 共用任务的执行步骤

由现有后台 Agent 执行以下操作。脚本本身不调用模型；Agent 负责阅读和事实语义核对。任务已启用 autoPublish 时，自动导入已获授权，无需每天重新确认。

1. 取得本次真实 run ID、thread ID 和 **Agent 进程 PID**。thread ID 可来自当前 Agent 上下文或明确环境身份，不能伪造；owner-pid 不是即将退出的临时 shell PID，也不是其他终端进程。不能取得这些身份时报告 blocked。
2. 运行 `python3 scripts/job.py prepare --config <配置> --run-id <真实ID> --thread-id <真实ID> --owner-pid <Agent PID>`。首次从 startDate 到昨天选择最早未完成日，最多 maxDaysPerRun 天。返回 batch 路径、generation、材料模板、旧事项映射和剩余日期。
3. 后续命令均传 `--config`、`--batch`、`--run-id`、`--generation`。若 next 为 reconcile，先恢复原 pending 导入，禁止重新整理或新建请求。
4. `job.py review` 按 `--offset`/`--limit` 分页列出材料和预览。对消息逐条 `job.py read --id <材料ID>`；长正文用返回的 nextOffset 续读。read 记录连续读取位置，预览不算阅读全文；validate 要求全部用户/助手消息及被引用工具证据已读。
5. Mac 对实质飞书事项按需 `job.py context --date YYYY-MM-DD --message-id <已发现的本人消息ID> [--minutes 30]` 补回复，随后读取新增材料。上下文失败将该来源记 partial；消息快照变化时重新采集，不能混合两个版本。此命令仍只读聊天。
6. 从 facts.template.json 写一个 0600 的 facts.json，保留 batchId/generation/evidenceHash/days。每个日 items 形式如下。引用来自本批材料 ID；eventKey 可省略，由脚本在首次校验时分配并持久复用。已有关联项会从证据身份匹配旧键，拆分/合并有歧义时拒绝。

```json
{
  "title": "讨论每日记录方案",
  "statement": "讨论了本机与devbox分别采集并上报的方案。",
  "status": "discussed",
  "project": null,
  "sourceIds": ["从本批review取得的真实材料ID"]
}
```

7. `job.py validate --facts <facts.json>` 校验材料摘要、已读记录、日期、事实状态、项目归属、稳定身份与单日限制，生成不可变 export.json。原生来源项目复用材料中的名称或配置的明确别名，跨仓库事实 project 为 null。飞书事实项目需语义核对，不按群名猜测。
8. `job.py publish` 只发送 validated 导出，先持久化冻结请求，再复用随记 prepare/import/回读。每包最多 100 条/200 KiB，按完整日期分包；单日超限拒绝，不截断。禁用 autoPublish 时拒绝写入，保留本地产物。
9. 检查 confirmedDays、remainingDays 和 complete。partial 日即使已导入仍待补采；预算耗尽报告剩余工作，使用现有任务续接或下次调度继续，不报告全部成功。

空日只在实际请求范围完整且没有事项时说明该范围无记录。构建、部署触发、Agent 自述与独立验证分别保留；verified 必须有当天工具回执。服务不做语义真实性判断。

## 中断、补采与上传恢复

`job.py status --config ...` 只读返回逐日状态、批次和实际来源回执，不联网。先查 pending，再处理新日期。服务端完整来源诊断使用上述 work-sources 命令。

所有者仍活动时另一 run 返回 BUSY。原进程已退出后，新 run 的 prepare 必须显式给 `--recover-run-id <旧run ID>`，进程 PID 和开始时间均核对，批次代际递增；旧 run 的提交会被拒绝。没有 pending 时可显式 `--recollect` 在新代际目录重新采集，保留旧材料；不得覆盖旧材料或丢弃冻结导入。

`job.py reconcile` 仅恢复本批次原请求；也可使用配套 `suiji.py --config ... --env-file ... work-reconcile --request <冻结请求> --job-config <任务配置>`。只允许保护配置中显式 autoPublish 的工作事实导入，同一键、目标和参数最多调用 3 次；收到幂等原回执后独立回读。超时仍未知则保留 outbox，不换键，不处理该流后续包。收到明确 WORK_FEED_CHANGED 才允许重新读取核对并准备，最多连续冲突 3 次。手动 retry 和其他笔记/待办写操作不获得自动重试能力。

成功回执在删除待确认请求之前持久保存，防止进程在“服务成功、本机记账未完成”之间退出后丢失结果。人工改过的字段及人工清空项目继续受现有导入保护。

本功能记录自身 thread ID 并在后续本机采集中排除，不排除其他真实后台开发。它不生成飞书文档或发送消息，不把自己产出的记录再次采作新工作。

## 安装定时任务与验证

使用 [共用模板](scheduled-task.template.json) 渲染两份实际 Backend 配置。替换占位后先通过现有 scheduled-task Skill/CLI 验证完整草稿，用户确认再创建；模板文件本身不可直接提交。两端提示词相同，配置路径指向各自本机文件；配置和时刻不是源码里的固定默认值。

先验证真实 Mac/飞书和真实 devbox 的手动执行，再观察一次真实 scheduledFor 的到点运行。服务已部署不证明采集器、凭据、模型登录或非交互 PATH 可用。本地成功不能冒充实际 devbox 或真实飞书验收。

[上报验收合同](../../../../../docs/testing/skills/daily-record-reporting.testplan.yaml) 与 [随记导入合同](suiji-work-records.md) 分别验证采集和写入。集成验证入口为 `pnpm --filter @runweave/suiji-server exec tsx scripts/verify-reporting.ts <隔离PostgreSQL18端口>`，只创建并清理随机临时数据库，不读取真实聊天。

停用仅禁用已有两个任务，保留本地状态/outbox/成功事实；必要时按生效日期停用来源。不删除用户原始对话、不重置机器或事项身份、不执行破坏性数据库回退。
