# Agent Team Review Checkpoint 实施计划

## 结论

Agent Team 的重复 `code_review` 不应继续依赖 reviewer 自己判断“这轮到底新增了什么”。一期方案增加显式、可恢复的 **Review Checkpoint**：

1. 用户启动 Agent Team 时显式选择 `local_commit` 模式。
2. backend 在干净 Git worktree 上创建本地专用分支，并记录任务起点 commit、计划/测试文件摘要。
3. 每次进入 `code_review` 前，backend 暂存本轮代码并冻结 `baseCommit + targetTree`；reviewer 只审查该确定范围及其影响链。
4. review pass 后，backend 校验工作树未漂移，再创建本地 checkpoint commit；behavior evidence 绑定该 commit。
5. behavior fail 后，code worker 修复；下一次 review 的默认范围是 `lastReviewedCommit..staged tree`。
6. 所有 behavior case 通过后，再对 `taskBaseCommit..latestCheckpoint` 做一次任务级全量收口 review；通过后 run 才进入 `done`。

这不是发布流程。checkpoint 不自动 push、不自动 squash、不自动创建 PR；最终发布继续使用现有提交/PR 工作流。配套验收用例见 `docs/testing/agent-team-review-checkpoint-test-cases.md`。

本改动涉及 Git 写操作、状态机、backend 重启恢复和用户工作区安全，按 **L3 高风险** 实施。

## 当前现状

- `packages/shared/src/agent-team.ts` 的 `AgentTeamRunOptions` 只有 `autoApproveSplit`，run 未记录 Git repo、branch、任务基线、review 输入 tree 或 checkpoint。
- `backend/src/agent-team/service-completion.ts` 在 code outbox 完成后直接 dispatch `code_review`，在 review pass 后直接 dispatch `behavior_verify`。
- `backend/src/agent-team/prompt-builders.ts` 的 re-review prompt 只说“重新审查以下用例”，没有给出确定的 Git base/target。
- `backend/src/agent-team/service-execution.ts` 只根据 acceptance 状态决定 bounce、verify 和 done；所有 case 通过后会立即完成，没有最终全量收口 review。
- `backend/src/agent-team/service-support.ts` 已能从 project/session 解析真实项目根目录，可作为 Git worktree 入口。
- `.runweave/agent-team/<runId>.json` 已是持久化 run 真相，适合保存 checkpoint 状态并在 backend 重启后恢复。
- pane-scoped outbox 已具备 run/panel/role/freshness 校验，可扩展 reviewer 对 `baseCommit + targetTree` 的回显，而不新增第二套结果通道。
- frontend 启动面板和执行侧栏已展示 run options、active role、round、acceptance 和 logs，但没有 checkpoint 开关与基线状态。

## 目标

1. re-review 默认只审查上一个 review-pass checkpoint 之后的真实代码增量。
2. 首轮和最终轮仍能审查完整任务 diff，防止多个局部修复组合出新问题。
3. review 结论、checkpoint commit、behavior evidence 三者绑定同一代码 tree。
4. reviewer 完成后代码若被其他 pane 修改，旧 pass verdict 不得创建 checkpoint或启动 behavior。
5. 计划/测试案例文件变化时停止旧语义下的执行，不继续消费旧 acceptance 快照。
6. backend 重启后能从 run JSON 和 Git 状态恢复，不重复 commit、不重复 dispatch。
7. 所有 Git 写操作必须显式 opt-in、只作用于当前项目 worktree、失败时 fail closed。
8. 旧 run 和未开启 checkpoint 的新 run 保持现有行为。

## 非目标

- 不自动 push checkpoint branch。
- 不自动 squash、rebase、reset、stash 或删除分支。
- 不自动创建 PR/MR，也不替代现有 PR 发布流程。
- 不在 dirty worktree 上自动“接管”已有改动；一期直接拒绝启用 checkpoint。
- 不把 code review pass 等同于 behavior pass 或发布完成。
- 不按文件行数推断影响面；reviewer仍需检查接口调用方、共享协议和历史 finding。
- 不新增单元测试文件；使用 verify 脚本、隔离 Git fixture、真实 Agent Team run 和 `$toolkit:playwright-cli` 验收。
- 不修改 `packages/common`；本能力是 backend/frontend/CLI 共享状态合同，类型放在 `packages/shared`。

## 用户可见行为

### 启动

Agent Team 启动区增加复选项：

> Review 通过后创建本地 checkpoint commit

旁边明确说明：

- 仅本地，不会 push；
- 要求当前 worktree 干净；
- backend 会创建 `runweave/agt-<runShortId>` 专用分支；
- run 完成后保留 checkpoint commits，由最终 PR 流程决定是否 squash。

用户未开启时，API 使用 `disabled`，流程与当前版本一致。

### 执行侧栏

开启后展示：

- `task base` 短 SHA；
- 当前 checkpoint 序号与短 SHA；
- 当前 review scope：`full`、`incremental` 或 `final`；
- base commit、target tree、受影响文件数；
- `checkpoint pending / committed / source drift / git drift`；
- checkpoint 分支名；
- 明确文案“本地 checkpoint，不代表行为验收或发布完成”。

发生 Git/source 漂移时，run 进入 `need_human`，UI 展示原因与恢复建议，不自动执行破坏性 Git 命令。

## 固定产品决策

### 1. checkpoint 由 backend 创建

code worker 和 reviewer 都不能自行决定 commit 边界。backend 在消费合法 review outbox 后创建 checkpoint，确保：

- verdict 与 active dispatch 匹配；
- review target tree 未变化；
- branch/HEAD 未漂移；
- source hash 未变化；
- review outbox 没有未修复 P0/P1。

### 2. 一期只支持干净 worktree

开启 `local_commit` 时，start preflight 必须满足：

- 当前目录位于 Git worktree；
- `git status --porcelain=v1 --untracked-files=all` 不含 `.runweave/**`、`docs/review/**` 之外的改动；
- HEAD 存在且不是 unborn branch；
- 同一 repo 没有另一个 running checkpoint run；
- 可以创建专用本地分支。

任一条件不满足时返回 409 和可操作说明，不执行 `git add`、`git switch` 或 `git commit`。

### 3. 专用分支，不直接污染 main/feature

preflight 通过后创建：

```text
runweave/agt-<runId 短 ID>
```

记录原始 branch 和 task base，但一期不自动切回原分支。这样 checkpoint commits 始终位于明确的 run branch，避免把临时提交直接写入 `main`。

### 4. review 报告不是代码审查目标

`docs/review/**` 和 `.runweave/**` 不计入 semantic review target。reviewer允许写 pane outbox 和 repo 约定的 review 报告；backend 校验 tree 漂移时忽略这些明确 artifact 路径。

checkpoint commit 一期只提交 review 前已暂存的代码 tree，不在 pass 后二次 `git add -A`，避免把 reviewer 生成的未审查文件混入代码 checkpoint。review 报告由最终发布流程另行处理。

### 5. checkpoint commit 不运行发布 hooks

checkpoint 使用明确的 Runweave author/committer，并带 `--no-verify --no-gpg-sign`。原因是它是本地状态边界，不是发布提交；commit hook 可能在 review pass 后改写文件，使已审 tree 与 commit tree 不一致。正式发布仍必须运行仓库要求的质量门禁和提交/PR 流程。

## 状态机

```text
start checkpoint run
  -> git preflight
  -> create run branch + record taskBase/source digests
  -> code
  -> prepare review target (stage -> targetTree)
  -> code_review(full | incremental)
       fail -> bounce code（不 commit）
       stale target/source/git -> need_human（不 commit、不 verify）
       pass -> create checkpoint commit
  -> behavior_verify(checkpoint SHA)
       fail -> bounce code
       partial pass -> selective recheck
       all behavior pass -> final full review(taskBase..latestCheckpoint)
  -> code_review(final)
       fail -> bounce code
       pass + HEAD/tree unchanged -> done
```

非法迁移：

- 没有 review pass 不得 commit；
- 没有 checkpoint commit 不得启动 behavior；
- reviewer pass 后 target tree 变化不得 commit；
- behavior evidence 的 checkpoint SHA 与当前 checkpoint 不同不得合并结果；
- final review 未通过不得 `done`。

## 共享合同

在 `packages/shared/src/agent-team.ts` 增加：

```ts
export type AgentTeamReviewCheckpointMode = "disabled" | "local_commit";
export type AgentTeamReviewScope = "full" | "incremental" | "final";

export interface AgentTeamReviewTarget {
  scope: AgentTeamReviewScope;
  baseCommit: string;
  targetTree: string;
  changedPaths: string[];
  planSha256: string | null;
  testCaseSha256: string | null;
  requestedAt: string;
}

export interface AgentTeamReviewCheckpoint {
  sequence: number;
  commit: string;
  parentCommit: string;
  tree: string;
  reviewRound: number;
  reviewerPanelId: string | null;
  createdAt: string;
}

export interface AgentTeamReviewCheckpointState {
  mode: AgentTeamReviewCheckpointMode;
  repoRoot: string;
  originalBranch: string;
  branch: string;
  taskBaseCommit: string;
  lastReviewedCommit: string;
  pendingReview: AgentTeamReviewTarget | null;
  checkpoints: AgentTeamReviewCheckpoint[];
  finalReviewedCommit: string | null;
}
```

并扩展：

- `AgentTeamRunOptions.reviewCheckpointMode`，默认 `disabled`；
- `AgentTeamRun.reviewCheckpoint`，旧 run 缺字段按 disabled 处理；
- `AgentTeamActiveWorkerDispatch.reviewTarget?`；
- `AgentTeamWorkerOutbox.reviewTarget?`，review worker必须原样回显；
- behavior outbox 增加 `verifiedCheckpointCommit?`，开启 checkpoint 时必填；
- `AgentTeamVerificationConfig` 增加 plan/test/generated 文件 SHA-256。

run/export API 直接通过现有 `AgentTeamRun` 和 export payload 暴露这些字段，不新增独立 endpoint。

## Git 操作边界

新增 `backend/src/agent-team/review-checkpoint-git.ts`，所有 Git 调用使用 `execFile("git", args, { cwd: repoRoot })`，禁止 shell 字符串拼接。

职责：

1. `preflightReviewCheckpoint()`：解析 repo/worktree、clean status、branch、HEAD 和并发占用。
2. `createRunCheckpointBranch()`：只创建并切换专用本地分支。
3. `prepareReviewTarget()`：
   - 再次验证 branch/HEAD；
   - 运行 `git add -A -- .`，但排除 `.runweave/**` 和 `docs/review/**`；
   - 拒绝敏感文件路径（`.env*`、`*.pem`、`*.key`、credential/token 文件）和异常大 untracked 文件；
   - 用 `git write-tree` 得到 `targetTree`；
   - 用 `git diff --cached --name-only <baseCommit>` 得到 changed paths；
   - 没有代码 diff 时不 dispatch review、不创建空 checkpoint，进入 `need_human` 说明原因。
4. `assertReviewTargetUnchanged()`：复核 branch、HEAD、index tree、source SHA。
5. `commitReviewedTarget()`：提交已审 index tree，随后验证 `HEAD^{tree} === targetTree`。

任何错误都返回结构化原因；禁止自动 reset、restore、checkout 覆盖、stash 或删除用户文件。

## Review 范围规则

### 首轮 full

```text
baseCommit = taskBaseCommit
targetTree = 当前 staged tree
```

review prompt 必须要求：

- 审查 `git diff --cached <baseCommit>` 的完整任务 diff；
- 检查 changed paths 的调用方、共享协议和跨运行时消费者；
- 输出回显的 `reviewTarget`；
- 未修复 P0/P1 必须 fail。

### 后续 incremental

```text
baseCommit = lastReviewedCommit
targetTree = 修复后的 staged tree
```

默认审查：

- `baseCommit..targetTree` 增量；
- 本次失败 case 的完整链路；
- 受影响调用方/消费者；
- 上轮 resolved findings 的回归点。

它不是“只看新增几行”。reviewer若判断影响面超出 changed paths，必须扩展阅读并在 evidence 说明。

### 最终 final

behavior acceptance 全部通过后，使用：

```text
baseCommit = taskBaseCommit
target = latestCheckpointCommit
```

做一次完整任务 diff 收口。final review 不产生新 commit；如果代码 tree 未变且没有 P0/P1，直接完成 run，不重复 behavior。如果 final review fail，回弹 code，后续修复仍走 incremental review + selective behavior，再重新 final review。

## Source 漂移规则

run 创建/生成 acceptance 时计算并持久化计划、测试案例文件 SHA-256。以下时点重新比较：

- code -> review；
- review pass -> checkpoint commit；
- checkpoint -> behavior；
- final review -> done。

任一摘要变化：

- 不消费旧 verdict；
- 不 commit；
- 不继续 behavior；
- run 进入 `need_human`；
- UI/log 列出变化文件、old/new digest 和“重建 acceptance 或明确恢复”的操作建议。

一期不自动热重载 case，也不静默把旧 pass 映射到新 case。

## Behavior evidence 绑定

开启 checkpoint 时，behavior prompt 明确写入：

```text
本轮被测 checkpoint：<commit>
开始验收前执行 git rev-parse HEAD，并确认等于该 commit。
outbox 顶层 verifiedCheckpointCommit 必须等于该 commit。
```

backend 消费 behavior outbox 时必须校验：

- `verifiedCheckpointCommit === reviewCheckpoint.lastReviewedCommit`；
- 当前 branch/HEAD仍等于该 commit；
- source hash 未漂移。

旧 outbox 先由 mtime freshness boundary 视为 stale 丢弃；当前 dispatch 的新 outbox 若仍回传错误 SHA，则进入 `need_human` 且不更新 acceptance。

## Backend 重启恢复

startup reconciliation 除现有 outbox freshness 外增加 Git 状态复核：

- run 处于 review：复核 pending target、branch、HEAD、index tree；一致时才允许消费旧 outbox；
- run 处于 behavior：复核 HEAD 等于 last checkpoint；
- checkpoint commit 已存在但 run JSON 尚未落盘：通过 commit message trailer `Runweave-Agent-Team-Run` 和 `Runweave-Review-Sequence` 恢复，避免重复提交；
- 无法唯一恢复时进入 `need_human`，不猜测、不重复 commit。

checkpoint commit message 固定包含：

```text
checkpoint(agent-team): <runId> review <sequence>

Runweave-Agent-Team-Run: <runId>
Runweave-Review-Sequence: <sequence>
Runweave-Review-Tree: <targetTree>
```

## 文件范围

### 共享合同

- `packages/shared/src/agent-team.ts`：options、checkpoint state、review target、outbox/evidence 字段。

### Backend

- `backend/src/routes/agent-team.ts`：接收 `reviewCheckpointMode`。
- `backend/src/agent-team/review-checkpoint-git.ts`：新增，封装安全 Git 读写与错误分类。
- `backend/src/agent-team/service-context.ts`：持有 checkpoint Git service。
- `backend/src/agent-team/service-lifecycle.ts`：run start preflight、专用分支、初始 state/source digest。
- `backend/src/agent-team/service-support.ts`：source hash、run update 字段和恢复辅助。
- `backend/src/agent-team/service-completion.ts`：code completion 后 prepare target；review pass 后 commit；behavior outbox commit 绑定。
- `backend/src/agent-team/service-execution.ts`：final review gate、drift/need_human 状态迁移。
- `backend/src/agent-team/service-workflow-policy.ts`：active dispatch 与 review target 匹配。
- `backend/src/agent-team/service-acceptance-policy.ts`：final review 和 behavior selective rerun规则。
- `backend/src/agent-team/prompt-builders.ts`：full/incremental/final diff prompt 和 checkpoint evidence 要求。
- `backend/src/agent-team/service-export.ts`：导出 checkpoint 状态和 warnings。
- `backend/src/agent-team/storage/run-store.ts`：保持可选字段兼容；如恢复逻辑需要，仅增加查询 helper，不另建状态库。

### Frontend

- `frontend/src/components/terminal/terminal-agent-team-panel.tsx`：checkbox state 和 start payload。
- `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`：启动说明、checkpoint 状态、drift/need_human 展示。
- `frontend/src/services/terminal.ts`：若当前请求类型不是共享 DTO 直接推导，补齐 mode 字段。

### 验证与文档

- `scripts/verify-agent-team-review-checkpoints.mjs`：新增隔离 Git fixture verify，不作为单元测试。
- `package.json`：增加 `agent-team:verify-review-checkpoints`。
- `docs/testing/agent-team-review-checkpoint-test-cases.md`：配套行为验收。
- `docs/architecture/multi-agent-orchestrator.md`：实现完成后沉淀 checkpoint 状态机和安全边界。
- `docs/README.md`：登记测试入口。

## 分阶段实施

### 阶段 1：共享合同与安全 Git service

- [x] 增加 optional checkpoint types，旧 run 缺字段保持兼容。
- [x] 实现 Git preflight、branch、stage/tree、commit、drift 检查。
- [x] 对 Git 命令使用固定参数数组、超时和输出上限。
- [x] 实现 repo 级 checkpoint run 排他检查。
- [x] 实现 source digest 计算。
- [x] 增加隔离 fixture verify，覆盖 clean/dirty、commit/tree、branch/HEAD drift 和敏感文件拒绝。

验证：`pnpm agent-team:verify-review-checkpoints` 输出 JSON，所有子项为 pass；fixture 位于临时目录，当前 repo branch/index/worktree 前后不变。

### 阶段 2：接入 code -> review -> checkpoint

- [x] start API/UI 增加显式 mode。
- [x] code completion 后 prepare review target 并写 active dispatch。
- [x] reviewer prompt 包含 scope/base/tree/paths。
- [x] review outbox 回显 target；旧 outbox 按 freshness 拒绝，新 outbox target 不匹配则 fail closed。
- [x] review pass 后创建 checkpoint，fail 时不创建。
- [x] checkpoint 成功后才 dispatch behavior。

验证：隔离真实 run 的首次 review pass 产生一个 commit；review fail、stale tree、source drift均不产生 commit。

### 阶段 3：增量 re-review 与 behavior 绑定

- [x] behavior fail 回弹后，将 last checkpoint作为下一 review base。
- [x] behavior prompt/outbox 绑定 checkpoint SHA。
- [x] 错 SHA、旧 SHA、HEAD drift 的 behavior结果不进入 acceptance。
- [x] selective rerun保持现有失败/未执行/依赖/影响面语义。

验证：C1 behavior fail -> fix -> review 只看到 C1 后增量 -> C2；已通过且未受影响 case 保持 skipped + reason。

### 阶段 4：最终全量收口 review

- [x] behavior 全部通过时不立即 done，先 dispatch final review。
- [x] final prompt 审查 task base 到 latest checkpoint完整 diff。
- [x] final pass 且 tree 未变时直接 done，不重复 behavior。
- [x] final fail 回弹 code，并在修复闭环后重新 final review。

验证：至少两个 checkpoint 的 run 必须经过 final review 后才能 done；跳过 final 或用增量 target冒充 final 均失败。

### 阶段 5：恢复、UI 与文档

- [x] startup 恢复 pending review/checkpoint/behavior边界。
- [x] UI 展示 branch、checkpoint、scope、drift 和本地非发布说明。
- [x] `$toolkit:playwright-cli` 验证真实 terminal sidecar。
- [x] 更新架构活文档与 docs 索引。

验证：backend 在 review pass outbox 已写、commit 前后两个窗口分别重启，均只产生一个 checkpoint和一次后续 dispatch。

## 错误处理

| 场景                              | 行为                                        |
| --------------------------------- | ------------------------------------------- |
| 非 Git / dirty / unborn HEAD      | start 返回 409，无 Git 副作用               |
| 同 repo 已有 checkpoint run       | start 返回 409，展示 owner run              |
| branch 或 HEAD 被人工改变         | `need_human`，不 checkout/reset             |
| plan/test hash 改变               | `need_human`，旧 verdict失效                |
| reviewer 期间代码 tree 改变       | `need_human`，丢弃旧 pass                   |
| review fail                       | 不 commit，回弹 code                        |
| staged tree 为空                  | `need_human`，不创建空 checkpoint           |
| commit 创建失败                   | `need_human`，保留 index/worktree供人工诊断 |
| commit tree 与 reviewed tree 不同 | `need_human`，禁止 behavior                 |
| behavior outbox commit SHA 不匹配 | `need_human`，不更新 acceptance             |
| backend 重启无法唯一恢复          | `need_human`，不重复 commit                 |

## 安全、兼容与回滚

- 功能默认 disabled，发布后可逐 run 开启；出现问题可关闭 mode，旧流程不受影响。
- checkpoint 不推送远程，不写 token，不读取 Git credential，不调用网络命令。
- Git path 全部由真实 repo root解析；拒绝项目外 pathspec和 symlink逃逸。
- 不执行 reset/rebase/stash/clean/branch delete 等破坏性命令。
- Git stderr 进入结构化错误前脱敏，不输出环境变量或凭据。
- run JSON 不保存文件内容，只保存 SHA、路径、branch 和状态。
- checkpoint branch/commits 是本地持久产物；用户明确清理前不自动删除。
- 回滚本功能只需关闭 UI mode并移除 checkpoint dispatch分支；optional run字段可继续保留读取。

## 验证

按顺序执行，任一失败即停：

```bash
pnpm agent-team:verify-review-checkpoints
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
pnpm lint
git diff --check
```

静态门禁不能替代行为验收。必须按 `docs/testing/agent-team-review-checkpoint-test-cases.md`：

- 使用临时 Git repo 验证 commit/tree/branch/index安全；
- 使用真实 Agent Team panes验证 code/review/behavior/final状态迁移；
- 使用 `$toolkit:playwright-cli` 验证 sidecar checkpoint展示和错误反馈；
- 至少执行一次 backend重启恢复；
- 验证当前源 repo未被 fixture Git命令改动。

## 完成定义

- checkpoint mode为显式 opt-in，dirty/non-Git场景无副作用失败。
- 首轮 review有 full target，后续 review有 incremental target，最终有 final target。
- 每个 behavior结果绑定唯一 checkpoint commit。
- reviewer期间代码变化、source变化、HEAD/branch变化都不能推进。
- review pass才创建 checkpoint，review fail不创建。
- behavior全部通过后仍必须final full review，pass后才done。
- backend重启不重复commit或dispatch。
- 旧run和disabled mode行为不变。
- 配套测试案例全部通过并保留run JSON、outbox、Git log/tree和真实浏览器证据。
