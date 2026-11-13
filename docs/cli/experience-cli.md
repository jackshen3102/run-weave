# 普通会话的项目经验

`rw experience` 为普通 Codex / Pi 会话提供本机、按项目隔离的经验检索与结果回执。
它读取人工或 Agent 核实后保存的记录，不自动消费 Evolution 的分析候选。

```bash
rw experience search --instance stable --cwd "$PWD" --query 'Pi fetch failed 的传输问题' --json
rw experience show pi-transport-recovery --cwd "$PWD" --json
rw experience save --instance stable --cwd "$PWD" --file experience.json --json
rw experience save --instance stable --cwd "$PWD" --file revised.json --expected-revision UUID --json
rw experience feedback --instance stable --cwd "$PWD" --file receipt.json --json
rw experience history --cwd "$PWD" --json
rw experience status --cwd "$PWD" --json
rw experience diagnose --cwd "$PWD" --json
rw experience diagnose --cwd "$PWD" --query '全局 rw 更新后怎么确认实际版本' --json
rw experience retry --instance stable JOB_ID --cwd "$PWD" --json
```

所有命令支持 `--instance`、`--config-dir`、`--profile`、`--backend-port`，默认 cwd 为调用目录。
`--instance` 和 `--config-dir` 可放在命令前后；写入命令（包括保存检索记录的 `search`）
须显式指定目标实例，发送前仍校验 Backend 环境。示例使用 `stable`，开发实例改用对应实例 ID。
需要本机直连已认证的 Backend。仓库身份为 `SHA-256(realpath(git --git-common-dir))`，返回 `repositoryId` 和
`namespace`。主目录、子目录、符号链接与所有 worktree 共用仓库身份，不依赖 Project 注册、
项目 UUID、Backend profile 或端口；没有注册或重复注册均不影响检索。
同名独立仓库、独立 clone 不共享，即使 remote URL 相同；submodule 按独立 Git 仓库处理。
当前身份是本机 common directory 的规范路径；移动主仓库或重新 clone 会生成新身份，
不自动按名称或远程地址合并旧经验。

同一系统用户、同一命名空间的不同 Backend 共用
`~/.runweave/experience/<namespace>/<repositoryId>/store.sqlite`。
默认 Stable 使用 `production`，Beta 使用 `beta`，其他开发环境使用 `development`。
需共用的 Backend 可以在启动前显式配置相同的 `RUNWEAVE_EXPERIENCE_NAMESPACE`
（1–80 位小写字母、数字或连字符，首位不能是连字符）。这属于启动配置，不由 CLI 请求切换。
自动化验证应使用独立测试命名空间；`RUNWEAVE_EXPERIENCE_TEST_MODE=true` 默认使用 `test`，
仅此模式允许 `RUNWEAVE_EXPERIENCE_HOME` 覆盖根目录，避免测试写入正式数据。
端口只决定请求发送给谁，不参与仓库身份或数据分区。

经验独立于项目源码保存。同仓库不同 worktree 的源码内容不影响召回；修改、移动或删除源码
不会自动使经验失效。采用前仍须核对 applicability 中的版本、配置、环境与当前实际结果。

## 历史盘点与候选退役

```bash
rw evolution repository list --include-removed --json
rw experience catalog --repository-id <已登记仓库ID> --kind records --all --json
rw experience catalog --repository-id <已登记仓库ID> --kind revisions --all --json
rw experience catalog --repository-id <已登记仓库ID> --kind candidates --all --json
rw experience catalog --repository-id <已登记仓库ID> --kind jobs --all --json
rw experience candidate <candidateId> --cwd /actual/repository --json
rw experience retire-candidate <candidateId> --cwd /actual/repository --expected-version <读取到的version> --reason '逐项审查后的具体退役理由' --instance stable --json
```

`catalog` 对应 `GET /api/experience/catalog/:repositoryId?kind=...`，只接受当前 Backend 已登记的
仓库 ID（包括已注销登记），保留本机直连与登录门禁，不根据仓库名称、remote 或其他项目兜底。
以只读 SQLite 连接读取该命名空间的当前经验、所有修订、学习候选或学习作业，源码目录消失不阻止
读取已留存的数据。`sourceAvailable: false` 仍表示源码不可用，不能据此确认历史结论现在仍成立；
`storeAvailable: false` 表示没有对应存储文件，不会自动创建空库或宣称已覆盖历史。
`--limit 1..200` 默认 50，返回 `nextCursor`；`--cursor` 续读，`--all` 自动翻页，两者互斥。
游标绑定仓库、命名空间及数据类别，按不可变 ID 排序；并发写入时不是固定快照，正式全量审查仍需
核对盘点前后变化。旧 `status` 的最近 50 条作业保持兼容；`history` 仍指经验使用反馈。

`candidate` 对应 `GET /api/experience/candidates/:id?cwd=...`，返回候选及包含审查/状态的
`version` 指纹；catalog 的候选条目使用相同结构。退役通过 `POST /api/experience/candidates/:id/retire`
提交 `{cwd, expectedVersion, reason}`，要求真实 Git 目录仍可解析。版本变化返回 409，不自动重试；
完全相同的请求可返回原回执，不新增退役时间。候选变为 `retired` 并保存原状态、理由、时间与前版本，
保留正文、原 review、证据和来源作业；之后的学习审查不能再晋级该候选。退役 promoted 候选不自动
退役它已发布的经验，后者仍需独立审查。不能把“证据缺失、低使用量、已处理”直接作为无价值理由。

源码路径丢失时可完成历史盘点，但无法通过 cwd 执行候选退役或核验当前源码。需要找回**同一 Git
common-directory 身份**，或另行明确数据迁移范围；不伪造路径、重建空 Git 仓库或按名称合并。

针对性隔离验证（真实 HTTP、SQLite、Git 与 CLI 分页，不写生产数据）：

```bash
env -u RUNWEAVE_BETTER_SQLITE3_PACKAGE_DIR -u RUNWEAVE_BETTER_SQLITE3_NATIVE_BINDING pnpm --dir backend exec tsx ../scripts/verify/experience/maintenance.mts
```

## 增量知识审查

```bash
rw experience review-queue --repository-id <已登记仓库ID> --kind candidates --policy cleanup-v1 --pending-only --all --json
rw experience review --repository-id <同一仓库ID> --file review.json --instance stable --json
rw experience review-receipt --repository-id <同一仓库ID> --request-id <原请求UUID> --json
```

`review-queue` 支持与 catalog 相同的四类对象：records、revisions、candidates、jobs。
policy 是调用方选择的审查规则版本（1–80 位字母、数字、点、下划线或连字符），规则或适用基线
改变时使用新 policy；它不自动识别语义变化。接口为
`GET /api/experience/maintenance/:repositoryId?kind=...&policy=...`，沿用登记仓库、命名空间、
认证与本机直连门禁，源码丢失仍能盘点历史，返回明确的 sourceAvailable。

每项返回 itemId、完整 item、version、evidenceIssues、review 和 pending/reviewed/deferred 状态。
version 同时绑定对象正文、生命周期、来源可用性、有效期状态、证据行的实际哈希及缺失状态。
有合法归档的原文件缺失沿用原证据读取合同；原文件再次变化、恢复可读、对象更新、任务重试或
policy 改变，都会重新进入 pending。每次队列查询重新核对证据，不用旧的有效性判断永久跳过。
这只避免重复的内容审查，不免除当前适用前提的核对；环境基线改变需要更新 policy。

`--pending-only` 只输出本次待审对象，但 counts 仍包含本页扫描的全部对象，以及已审和暂缓数量。
blockers 按调用方提供的稳定原因键合并**当前暂缓对象数**，不累计运行次数、不将暂缓算作完成。
没有 pending 但仍有 deferred，不能报告全量审查完成。分页先按原始对象前进，因此过滤后的空页
仍可能有 nextCursor；`--all` 会继续翻页并累加 counts 和 blockers。游标绑定 policy、过滤条件和
catalog 作用域；`--cursor` 不能与 `--all` 同用。分页不是跨请求固定快照，结束前应从头核对变化，
不得将本次返回的数量当作永久不变的全库总数。

逐项实质审查后保存单条请求文件；不要将未审的列表批量标记为已审：

```json
{
  "requestId": "本次请求生成并保留的UUID",
  "policy": "cleanup-v1",
  "kind": "candidates",
  "itemId": "队列中的itemId",
  "expectedVersion": "队列中的version",
  "expectedReviewId": null,
  "decision": "reviewed",
  "reason": "本次实际审查的结论和依据",
  "blocker": null
}
```

对应 `POST /api/experience/maintenance/:repositoryId/reviews`。首次 expectedReviewId 为 null；
修改同一对象版本的结论时，使用队列 review.requestId。缺少证据或来源不可用只能记 deferred，
并提供 blocker（与 policy 相同字符约束，例如 source-unavailable）和具体 reason。
内容版本或已审回执变化返回 409，不自动重试。requestId 与原参数用于核对结果不确定的原请求，
完全相同的重放返回原回执及原时间；复用 requestId 修改正文返回冲突。回执和历史追加保存于
同仓库 SQLite，重启后保留；保存前再次核对对象版本，证据观察发生在写入之前，之后的外部变化
由下次队列查询识别，不承诺文件系统与 SQLite 的跨资源事务。
`review-receipt` 通过 `GET /api/experience/maintenance/:repositoryId/reviews/:requestId` 回读原回执，
对象后来变化也不覆盖该历史。404 只能说明此次读取未找到，不能在原写入仍不确定时自动换键重放。

审查回执不修改候选、已发布经验、有效期、使用反馈或人类收件箱状态，也不是独立验收或成功证明。
需要实际退役时先使用 retire-candidate 或正常的记录更新接口，再重新读取新版本并记录审查结论；
不能用 reviewed 代替实际处置。源码路径不可用的对象保留 deferred，不能伪造目录绕过身份校验。
实现入口为 [增量审查](../../backend/src/experience/maintenance-review.ts)。

## 人类阅读与 Agent 使用

已保存且当前有效的经验也通过「自进化」成果收件箱供人阅读。手机和桌面的已处理/恢复只改变
独立消费状态，不代表采纳，不提交 `feedback`，不影响 `search` 的有效性或排序。
人类消费接口只接受 Backend 登记的仓库身份；原 `/api/experience` 的本机直连门禁保持不变。
统一条目、版本、历史与跨端刷新合同见
[人类成果收件箱](../architecture/agent-self-evolution.md#人类成果收件箱)。

## 记录

`save --file` 输入使用 [ExperienceDraft](../../packages/shared/src/experience.ts)：

```json
{
  "id": "specific-failure",
  "title": "具体发现",
  "triggers": [
    ["工具名", "工具别名"],
    ["具体症状", "错误字符串"]
  ],
  "applicability": "已验证版本、环境、前提与失效条件",
  "avoid": ["有反例支持的错误路线"],
  "actions": ["当前代码已有入口与操作"],
  "verification": ["本次要观察的外部结果"],
  "expiresAt": "2026-10-01T00:00:00.000Z",
  "state": "active",
  "evidence": [
    {
      "path": "/absolute/evidence.json",
      "startLine": 1,
      "endLine": 10,
      "note": "支持什么结论"
    }
  ]
}
```

触发组之间为 AND，组内同义词为 OR；ASCII 词有词边界，中文按短语匹配。
返回最多三条记录，保留适用条件、反例、行动、验证方式和证据索引，`matchedTerms` 说明命中原因。
检索响应不附带 `evidence[].archived` 历史摘录；需要核对原文时用 `show` 读取完整记录。
先判断是否适用，不要求每次命中都读取原文。不要把宽泛的“问题”“测试”单独作为触发。
触发词应是自然提问中的短词或错误片段，而非完整描述句；例如
`[["rw", "全局 CLI"], ["更新", "版本", "shasum"]]`。自动提炼要求至少两组，
每词最多 48 字符，并参考已有经验的触发词；人工保存的旧记录仍兼容原有长度。

不要求 codePaths；兼容旧输入中的可选路径提示，但不会读取或散列这些文件。旧数据库中的
codeHashes 在读取时忽略，不自动重写历史数据。保存与检索仅校验证据完整性、有效期和状态；
证据改变/不可读、过期、`retired` 或 `needs_revalidation` 的记录进入 `excluded`。
`show` 保留审计可读性并明确 `available: false`。可召回不代表当前现场已满足适用前提。
新记录会保存所引用行的脱敏摘录（每项最多 64 KiB），而不是复制整段对话。
原文件删除后仍可通过摘录校验；原文件仍存在但内容变化时停止推荐。旧记录没有摘录时，
继续要求来源可读。摘录保留原始位置和原始哈希，并以独立哈希验证摘录；它只保证可追溯，
不证明结论正确。暂时没有按来源删除自动传播到摘录的机制；敏感内容不应作为经验材料。

更新需要旧 `revision`，冲突 HTTP 409；旧版本留存。SQLite 短事务原子保存当前记录和版本，
不同 Backend 同时提交相同旧版本也只能有一个成功。回执绑定检索时实际命中的版本，
经验更新、过期或项目源码变化均不阻止记录该次使用结果。
数据库保存 records/revisions/lookups/feedback/candidates，文件权限 0600。普通操作结束时关闭数据库连接；后台学习队列在其运行期间复用连接，停止调度并排空当前任务后关闭，不在等待模型或证据 I/O 时持有事务。
此前实验版 browser profile 内按 Project UUID 保存的 JSON 不自动合并；正式版尚未部署过该入口。
旧实验记录需重新核实来源与适用条件后，通过 `save` 显式导入。
这是独立的已核实记录入口；不会迁移或修改既有候选生命周期、分析任务与策略。
当前没有跨机器路径映射或经验管理 UI。

## 正式环境的持续更新

Stable 默认启用后台学习；`RUNWEAVE_EXPERIENCE_LEARNING=false` 可关闭。Beta/dev 默认关闭，
验收时显式设为 `true`。需安装并登录本机 Codex CLI；复用现有只读 Provider，通过普通终端执行。
更新客户端后这条链路生效；旧版本不支持。本机终端之外的会话没有完成事件，不会自动纳入。

1. 已通过身份门禁的普通 Codex/Pi `Stop` 完成事件，在回复 hook 前写入命名空间内持久队列。
   不使用 shell 退出、通知、子 Agent 或 Team pane 作为学习触发。学习入队失败不阻塞原任务，写诊断日志。
2. 后台每五秒领取任务；同命名空间的多个 Backend 共用一个五分钟租约。
   入队时记录 Activity 快照，按游标读取该轮最近一次用户输入到完成时刻之间的工具请求与结果；
   后续会话不会挤掉已入队任务的来源。旧任务没有快照时也按完成时间过滤并翻页。最多扫描
   50 页、每页 200 条；达到扫描上限、缺失边界、来源失效或超出单轮内容上限均明确失败，
   不把不完整材料包装成完整分析。相同事实重复送达会跳过。
   已保存的空字符串输出有效；内容缺失与空输出分开处理。Pi 的状态先经 App Server
   到达时，直连 hook 仍可补存完全相同 Pi 上下文的 Activity 内容，不再执行状态转换；
   旧 sequence、冲突上下文或身份门禁失败仍拒绝。单条 40000 字节、单轮 160000 字节
   上限不变，不通过静默截断绕过。
3. 提炼从本仓库全量旧经验按本轮原文的字面相关性选择最多五十条比对记录，
   不按 ID 固定截取。过期、停用记录也参与比对，但不因此恢复有效性；相关候选不等于
   已确认同主题，仍须区分不同问题、根因、环境和验证条件。这不保证语义去重。
   Codex 首先提炼至多一条候选，再以独立只读调用核对具体工具结果与适用前提；
   不额外读取源码文件，不用文件内容一致性代替适用性判断。提炼参考最近二十条失败回执摘要；
   复核读取完整的有界本轮事实，以及同一经验最近五条失败回执和归档摘录（每条最多八千字符，
   截断会显式标注）。后续失败或历史反例未解释时，不得因较早成功而晋级；需要候选未归档
   的其他证据才能成立时保持 pending，等待重新提炼。
   两次调用各最多 90 秒，不允许模型执行仓库命令。候选及复核引用必须包含同一工具调用的请求和结果。
   提炼引用限定为本轮真实 ID；同主题更新会校验并保留旧版证据，复核可另引用这些归档的历史 ID，
   但历史证据不能代替本轮工具请求与结果，也不能证明当前环境仍成立。旧证据失效或合并后超过
   十项证据预算时明确失败，不丢弃证据后继续晋级。复核 supported 只能引用候选已归档的证据。
   无新发现可合法跳过；不足的候选保持 pending，反证成立则 rejected；supported 且证据有效、数据库旧版本
   未变化时才原子晋级。模型复核仍是 advisory 判断，不是独立认证的实际收益。
4. 更新沿用经验 ID，保留旧版本和反例；新经验默认三十天有效。不自动续期。
   崩溃后租约到期可重新领取；正常关闭会取消分析并把任务重新排队。失败可通过 `retry` 重试。

`status` 返回本仓库最近五十个任务（queued/running/completed/skipped/failed）、失败或跳过原因、
候选和复核理由。`completed` 表示分析结束，不等于候选已晋级；查看 candidate.status。
任务的可选 `failureReceipts` 保留最近八次失败的 Provider 调用，包括第二次调用修复成功前的失败。
回执随队列持久化，不随临时分析目录删除；记录任务尝试编号、提炼/复核/分段阶段、调用尝试、
Provider、请求模型（默认模型为 null，不代表已核实实际模型）、耗时、预算以及提示词/schema 哈希。
失败区分输出读取失败、空输出、非法 JSON、输出超限、schema 不符及其他 Provider 错误；
每条输出摘录在脱敏后最多 2 KiB，不保存输入提示词、环境变量或完整异常文本。
进程超时或非零退出时，摘录来自 stderr；原始 stderr 不进入普通错误日志。
旧任务没有回执，不补造历史原因；处理尝试数不是模型调用数或费用。此记录不改变重试、晋级和用户任务状态。
pending 项可由后续普通 Agent 阅读原始证据/脱敏摘录，在实际验证后通过正常 `save` 修正；
不能只修改状态或延长有效期。已有 Evolution 候选不直接导入，因为其范围及验证合同不同。

后续检索由用户级通用 `experience` skill 按需触发：排查重复故障、查找已验证办法或选择历史
验证路径时，Agent 可根据 skill 描述选择它；不在启动或每次输入时强制检索。
Codex 由用户主动安装 Toolkit 插件，Pi 由用户主动安装同一 skill 的 package；
[安装入口](../../plugins/toolkit/README.md#本地安装) 不依赖桌面启动。桌面和 hooks 安装器不安装、
更新或补装 experience skill，未安装就不提供该检索入口。目标项目无需 `AGENTS.md`，
也不需要 Runweave 源码。运行时只调用已安装且已认证的 `rw`，cwd 保持为任务所在目录。
所有记录、候选、查询和回执按 repositoryId 隔离，不提供跨仓库兜底或全局经验池。
通用指的是入口可用于不同项目，不表示经验内容共用。非 Git 目录目前不支持。

后台完成 hooks 不依赖 skill 是否被调用，skill 也不负责每次结束时手写记录。
Codex 更新插件后需新建会话；Pi 需重新加载。入口已安装不保证模型每次都会选择，
需要实际任务轨迹验证隐式发现、检索参数和后续行为。

## 消费诊断

`diagnose` 独立于学习开关，读取本仓库已保存的查询和回执，并检查当前经验的证据与有效期。
返回总查询数、命中查询数、有回执的查询数、最近二十次查询，以及每条当前记录跨历史版本的
返回/采用/拒绝次数。`used` 是 Agent 回执，不是已认证的收益；没有回执不推断为未采用或失败。
统计覆盖库内已保存记录，没有区分自然任务与旧验收查询；不代表全部会话的调用率。

可选 `--query` 使用与正式检索相同的触发词、有效性和前三条排序规则，逐条返回：
`returned`（会返回）、`ranked_out`（超出前三条）、`excluded`（有效性不通过）、
`trigger_mismatch`（缺少触发组），并列出 `matchedTerms` 与 `missingGroups`。
这是当前经验版本的诊断预览，不产生 lookup、不支持提交采用回执，也不会把验证命中算进使用量。
正式采用仍须使用 `search` 取得 lookup。历史查询结果保留当时版本，不用当前规则重写。

## 结果回执

```json
{
  "lookupId": "查询返回的 UUID",
  "id": "specific-failure",
  "revision": "查询返回的版本 UUID",
  "task": "当前任务或会话标识",
  "decision": "used",
  "reason": "为什么适用",
  "action": "实际改变了哪一个操作",
  "outcome": "实际观察结果，失败也照实记录",
  "result": "succeeded",
  "evidence": [
    {
      "path": "/absolute/current-result.json",
      "startLine": 1,
      "endLine": 10,
      "note": "本次结果"
    }
  ]
}
```

`dismissed` 可无结果证据。`used` 必须有本次结果证据，并引用该 lookupId 实际命中的
id 与 revision。其他项目、未召回的记录或伪造版本不能冒充此次采用；已被新版替代的
历史版本仍可提交反馈，不能因经验更新而丢失事实。`history` 返回回执，`attribution: agent_report`
明确它不是已认证的收益。
`result` 可为 `succeeded`、`failed`、`unknown`；缺省不推断结果。
`used + failed` 且附本次证据时，若被使用的仍是当前 active 版本，在同一事务中生成
`needs_revalidation` 新版本并停止推荐。若经验已更新，保留旧版本失败回执，不直接停用新版。
这表示出现待调查的反例，不等于旧结论已被证明错误；普通 `dismissed` 不自动全局停用。
后续用新证据显式更新才能重新生效。客观效果仍需检查外部证据和同条件基线；召回或采纳次数不是成功率。

实现入口：[Backend service](../../backend/src/experience/service.ts)、
[HTTP 路由](../../backend/src/routes/experience.ts)、
[Toolkit 使用入口](../../plugins/toolkit/skills/experience/SKILL.md)。

验收合同：[普通会话经验测试计划](../testing/experience/ordinary-session.testplan.yaml)。
采集修复验收：[学习来源采集](../testing/experience/learning-ingestion.testplan.yaml)，
执行 `pnpm --filter @runweave/backend exec tsx ../scripts/verify/experience/ingestion.mts`。
它使用独占临时存储、真实 HTTP 路由和 SQLite worker，不向 production 写入验收记录。

## 未处理经验与处理闭环

```bash
rw experience list --limit 10 --json  # 默认 10 条，只返回未处理经验
rw experience list --all --json       # 自动翻页，返回当前仓库全部未处理经验
rw experience process --instance stable <experience-id> --expected-content-version <contentVersion> --json

# 保存列表，逐条审阅后仅保留要处理的 items；不要把未审阅的条目交给 process。
rw experience list --all --json > reviewed-list.json
rw experience process --instance stable --file reviewed-list.json --json
```

`list` 先按当前认证用户、当前仓库、experience 来源和 pending 状态过滤，再按内容更新时间
倒序取最近 N 条；`--limit` 与 `--all` 互斥。N 可超过服务端单页上限，CLI 自动分页。
结果包含条目正文、`sourceId`（经验 ID）、`contentVersion` 和 `stateVersion`；原始经验及证据
仍通过 `show <sourceId>` 读取。分页期间数据并非固定快照，服务端冲突会直接报错，需重新查询。
来源不可用时命令失败，不把故障当作“没有未处理经验”。只支持后端登记仓库的收件箱。

`process` 将指定经验版本标记为当前用户已处理。建议传入分析时取得的 `contentVersion`，
内容已更新则拒绝；省略时使用命令开始查询到的版本。更新同时校验服务端状态版本，冲突不自动
重试。重复处理同一版本不重复写入。后续出现新内容版本时，新版本仍进入未处理列表。
此操作与手机、桌面成果收件箱共用状态，不修改经验有效性，不提交使用反馈。

批量 `--file` 直接读取上述列表 JSON，要求保留顶层 `repositoryId`、`namespace`，以及每条的
`source`、`repositoryId`、`itemId`、`sourceId`、`contentVersion`；可删去不处理的 items。
文件路径相对于命令执行目录；`--cwd` 仅选择仓库。不能与经验 ID 或 `--expected-content-version`
同时使用，每条沿用其已审阅版本。重复条目、其他来源或仓库、namespace 不符均拒绝。
空 items 返回空结果，不修改状态。

批量复用一次仓库身份查询，按 itemId 读取当前详情，不扫描待处理或已处理列表。
全部条目通过身份、内容版本与可用性核对后才开始串行处理；写入仍校验内容及状态版本。
成功返回 `{repositoryId, namespace, state: "processed", items}`，包含已处理条目的回执；
同版本已处理项不重复写入。整个批次不是原子事务：写入期间遇到冲突或请求失败立即停止，
错误包含失败条目及已返回成功的条目 ID；网络失败的那笔可能已在服务端提交，须回读收件箱后
再决定重试，不自动重放或回滚。
