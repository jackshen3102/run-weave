# 普通会话的项目经验

`rw experience` 为普通 Codex / Pi 会话提供本机、按项目隔离的经验检索与结果回执。
它读取人工或 Agent 核实后保存的记录，不自动消费 Evolution 的分析候选。

```bash
rw experience search --cwd "$PWD" --query 'Pi fetch failed 的传输问题' --json
rw experience show pi-transport-recovery --cwd "$PWD" --json
rw experience save --cwd "$PWD" --file experience.json --json
rw experience save --cwd "$PWD" --file revised.json --expected-revision UUID --json
rw experience feedback --cwd "$PWD" --file receipt.json --json
rw experience history --cwd "$PWD" --json
rw experience status --cwd "$PWD" --json
rw experience diagnose --cwd "$PWD" --json
rw experience diagnose --cwd "$PWD" --query '全局 rw 更新后怎么确认实际版本' --json
rw experience retry JOB_ID --cwd "$PWD" --json
```

所有命令支持 `--profile`、`--backend-port`，默认 cwd 为调用目录。需要本机直连已认证的
Backend。仓库身份为 `SHA-256(realpath(git --git-common-dir))`，返回 `repositoryId` 和
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
返回最多三条完整记录，`matchedTerms` 说明命中原因。不要把宽泛的“问题”“测试”单独作为触发。
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
数据库保存 records/revisions/lookups/feedback/candidates，文件权限 0600，数据库连接按操作关闭。
此前实验版 browser profile 内按 Project UUID 保存的 JSON 不自动合并；正式版尚未部署过该入口。
旧实验记录需重新核实来源与适用条件后，通过 `save` 显式导入。
这是独立的已核实记录入口；不会迁移或修改既有候选生命周期、分析任务与策略。
当前没有跨机器路径映射或经验管理 UI。

## 正式环境的持续更新

Stable 默认启用后台学习；`RUNWEAVE_EXPERIENCE_LEARNING=false` 可关闭。Beta/dev 默认关闭，
验收时显式设为 `true`。需安装并登录本机 Codex CLI；复用现有只读 Provider，不使用 Agent Team。
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
3. Codex 首先提炼至多一条候选，再以独立只读调用核对具体工具结果与适用前提；
   不额外读取源码文件，不用文件内容一致性代替适用性判断。提炼参考最近二十条失败回执摘要；
   复核读取完整的有界本轮事实，以及同一经验最近五条失败回执和归档摘录（每条最多八千字符，
   截断会显式标注）。后续失败或历史反例未解释时，不得因较早成功而晋级；需要候选未归档
   的其他证据才能成立时保持 pending，等待重新提炼。
   两次调用各最多 90 秒，不允许模型执行仓库命令。候选及复核引用必须包含同一工具调用的请求和结果。
   两次结构化输出的证据 ID 均限定为本轮真实 ID；复核 supported 仍只能引用候选已归档的证据。
   无新发现可合法跳过；不足的候选保持 pending，反证成立则 rejected；supported 且证据有效、数据库旧版本
   未变化时才原子晋级。模型复核仍是 advisory 判断，不是独立认证的实际收益。
4. 更新沿用经验 ID，保留旧版本和反例；新经验默认三十天有效。不自动续期。
   崩溃后租约到期可重新领取；正常关闭会取消分析并把任务重新排队。失败可通过 `retry` 重试。

`status` 返回本仓库最近五十个任务（queued/running/completed/skipped/failed）、失败或跳过原因、
候选和复核理由。`completed` 表示分析结束，不等于候选已晋级；查看 candidate.status。
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
