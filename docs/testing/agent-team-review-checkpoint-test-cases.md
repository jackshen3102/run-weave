# Agent Team Review Checkpoint 测试案例

## 范围

验证 Agent Team 在显式开启 `local_commit` 后，以 review-pass checkpoint 为增量审查基线，并把 review、commit、behavior evidence 和最终全量 review绑定到同一代码 tree。

不覆盖自动 push、PR/MR创建、自动 squash/rebase、远程 Git 凭据和 checkpoint branch自动清理；这些均不属于一期能力。

## 前提事实

- 实施计划：`docs/plans/2026-07-12-agent-team-review-checkpoints.md`。
- run 真相：`.runweave/agent-team/<runId>.json`。
- worker 结果：pane-scoped `.runweave/outbox/<sessionId>.panel-<panelId>.json`。
- 串行角色：`code -> code_review -> behavior_verify`，全部 behavior通过后增加 `code_review(final)`。
- checkpoint mode只允许干净 Git worktree，并创建本地专用 branch。
- 本仓库不新增单元测试文件；Git状态机使用隔离 verify脚本，UI 使用 `$toolkit:playwright-cli`，桌面仅在需要启动真实 Runweave时使用 `$computer-use`。

## 环境与证据

所有写 Git 用例必须使用临时 repo或专用测试 worktree，禁止在用户当前分支直接演练。每条用例至少保存：

- run JSON 的 `reviewCheckpoint`、`activeWorkerDispatch`、`loop` 和 `status`；
- `git branch --show-current`、`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`git status --porcelain=v1`；
- 对应 pane prompt/capture 和 pane-scoped outbox；
- 涉及 UI 时的 `$toolkit:playwright-cli` DOM/screenshot；
- 涉及恢复时的 backend日志和重启前后时间线。

## 必跑命令

按顺序执行，任一失败即停：

```bash
pnpm agent-team:verify-review-checkpoints
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
pnpm lint
git diff --check
```

以上只作为前置门禁，不能替代真实 Agent Team、Git commit 或浏览器行为证据。

## 覆盖说明

- 主路径：AGT-RC-001、AGT-RC-002、AGT-RC-005、AGT-RC-011。
- 等价类与边界：AGT-RC-003、AGT-RC-004、AGT-RC-006、AGT-RC-007。
- 状态迁移：AGT-RC-002、AGT-RC-005、AGT-RC-009、AGT-RC-010、AGT-RC-011。
- 并发与隔离：AGT-RC-008、AGT-RC-012。
- 重启恢复与幂等：AGT-RC-009、AGT-RC-010。
- 数据与协议：AGT-RC-002、AGT-RC-005、AGT-RC-013。
- 安全：AGT-RC-003、AGT-RC-004、AGT-RC-007、AGT-RC-008。
- 回归兼容：AGT-RC-014、AGT-RC-015。
- 不覆盖外部 HTTP 鉴权：本改动没有新增外部 endpoint或权限模型，继续使用现有 Agent Team API鉴权。

## 用例

### AGT-RC-001 干净 worktree 开启 checkpoint 时创建专用分支和任务基线

前置条件：临时 Git repo有一个已提交基线，worktree/index均干净；不存在同 repo running checkpoint run。

步骤：从真实 Agent Team启动面板开启 `local_commit`，提交带计划和测试案例文件的任务；读取 API响应、run JSON和Git状态。

期望：创建 `runweave/agt-<shortId>` 本地分支；run记录 original branch、checkpoint branch、taskBaseCommit、source SHA；未创建 checkpoint commit；没有 push或远程访问。

失败判定：直接在原 branch工作、task base错误、启动阶段提前commit、发生网络Git命令，或run未记录可恢复状态。

依赖：无。

标签：主路径, Git, 启动。

### AGT-RC-002 首轮 review pass 后提交与 reviewed tree 完全一致的 checkpoint

前置条件：AGT-RC-001同类独立run；code worker产生tracked修改和新文件；review artifact写入允许路径。

步骤：等待backend准备首轮review target；读取review prompt；reviewer对门禁case返回pass并回显target；读取checkpoint commit、run JSON和behavior prompt。

期望：review scope为full，base等于taskBaseCommit；changed paths包含新文件；review pass后只创建一个checkpoint；commit tree等于targetTree；behavior在commit成功后才启动并收到该commit SHA。

失败判定：untracked代码漏审、commit tree与target不同、review前commit、同一outbox创建多个commit，或behavior先于commit启动。

依赖：无。

标签：主路径, full-review, checkpoint。

### AGT-RC-003 dirty worktree 开启 checkpoint 时无副作用拒绝启动

前置条件：临时Git repo分别准备staged、unstaged、untracked三种dirty等价类；记录branch、HEAD、index tree和文件hash。

步骤：每次只保留一种dirty状态，调用start API开启 `local_commit`；读取HTTP响应和前后Git状态。

期望：三种情况均返回409和明确dirty说明；branch、HEAD、index、文件内容完全不变；不创建run branch或commit。

失败判定：任一dirty状态被静默接管、自动stash/commit/reset、部分创建分支，或错误不指出清理/改用disabled方式。

依赖：无。

标签：边界, dirty-worktree, 无副作用。

### AGT-RC-004 非 Git、detached/unborn 或敏感文件场景 fail closed

前置条件：分别准备非Git目录、detached HEAD、unborn branch，以及code轮新增 `.env.local`、`secret.pem`、`client.key` 的隔离fixture。

步骤：前三种调用start；敏感文件场景在review target准备前完成code outbox；读取run/API/Git状态。

期望：非Git、detached/unborn在start前拒绝；敏感文件在stage/commit前进入need_human；不提交敏感内容，不删除文件，不输出内容。

失败判定：继续执行review/behavior、敏感文件进入Git object/commit、自动删除文件，或日志泄露内容。

依赖：无。

标签：安全, Git边界, 敏感文件。

### AGT-RC-005 behavior fail 修复后只审查上一 checkpoint 之后的真实增量

前置条件：独立run已产生C1；behavior对一个case返回稳定fail并回弹code；记录C1 SHA。

步骤：code只修改失败链路；完成后读取re-review prompt、staged diff和review target；review pass并读取C2。

期望：scope为incremental，baseCommit等于C1；target只包含C1后的修复增量；prompt仍要求检查失败case完整调用链和受影响消费者；C2 parent为C1；已通过且未受影响case保持skipped并有原因。

失败判定：重新把task base以来全部diff当本轮增量、base不是C1、只看新增行而忽略影响链、C2 parent错误，或无关case被无理由全量重跑。

依赖：无。

标签：增量review, behavior回弹, selective-rerun。

### AGT-RC-006 review fail 时不创建 checkpoint

前置条件：独立run已准备有效review target；记录review前HEAD、commit count和targetTree。

步骤：reviewer返回含P1 remainingFinding和fail acceptance；等待run回弹code；读取Git log和behavior pane。

期望：HEAD和commit count不变；run回弹code；behavior不启动；pending target可被下一次修复覆盖，不被标记为checkpoint。

失败判定：review fail仍commit、behavior启动、P1被吞掉，或旧target被记为reviewed。

依赖：无。

标签：错误态, review门禁, 无commit。

### AGT-RC-007 reviewer 执行期间代码或 source 漂移时旧 pass 失效

前置条件：独立run正在等待review；保存base/target和plan/test SHA。

步骤：场景A在review outbox写入前修改一个非artifact源码文件；场景B只修改测试案例文件语义；随后提交原review pass outbox。

期望：A检测target tree漂移，B检测source SHA漂移；两者均不commit、不启动behavior，进入重新review或need_human，并记录old/new标识。

失败判定：旧pass推进、commit未审代码、旧case继续执行，或系统自动覆盖source文件。

依赖：无。

标签：异步, stale-verdict, source-drift。

### AGT-RC-008 同一 repo 的第二个 checkpoint run 被排他拒绝

前置条件：同一临时repo已有一个running `local_commit` run；另一个terminal/session指向同一repo。

步骤：第二个terminal调用start并开启 `local_commit`；读取响应、两个run和Git状态。

期望：第二次返回409并指出owner run；第一个run、branch、index、worker panes不受影响；disabled mode run仍按既有产品边界处理。

失败判定：两个run同时stage/commit、branch互相切换、第二次破坏第一个run，或错误owner不明确。

依赖：无。

标签：并发, repo排他, 隔离。

### AGT-RC-009 review pass outbox 已写但 commit 前 backend 重启时只提交一次

前置条件：隔离backend和真实run处于review pass outbox已落盘、run尚未记录checkpoint的故障窗口；记录targetTree。

步骤：停止并重启backend；等待startup reconciliation；读取Git log、run logs、active dispatch和behavior prompt。

期望：通过commit trailer或run target唯一恢复；只生成一个对应tree的checkpoint，只dispatch一次behavior；重复扫描不增加commit/round/prompt。

失败判定：零commit且永久停住、重复commit、重复behavior prompt，或恢复到错误target。

依赖：无。

标签：重启恢复, 幂等, completion。

### AGT-RC-010 checkpoint 已提交但 run JSON 未落盘时 backend 重启可恢复

前置条件：隔离run已创建带run/sequence/tree trailer的checkpoint commit，但模拟run JSON仍停在pending review。

步骤：重启backend并等待reconciliation；读取commit trailer、run JSON和pane输入。

期望：backend识别现有commit并补写checkpoint state；不创建第二个commit；HEAD/tree与target一致后只启动一次behavior。

失败判定：重复commit、错误增加sequence、把合法commit当外部漂移，或直接need_human而未使用唯一trailer证据。

依赖：无。

标签：重启恢复, commit-trailer, 幂等。

### AGT-RC-011 behavior 全部通过后 final 全量 review 通过才完成

前置条件：独立run至少有C1、C2两个checkpoint；全部behavior case在C2通过；final review尚未执行。

步骤：观察run状态和final review prompt；reviewer对taskBase到C2完整diff返回pass；读取最终run和Git状态。

期望：behavior全pass时run仍running并进入code_review(final)；scope为final，base为taskBase，target为C2；final pass且代码未变后run done；不重复behavior，不创建空checkpoint。

失败判定：behavior全pass后直接done、final只看C1..C2、final pass后又全量behavior，或额外创建无代码commit。

依赖：无。

标签：final-review, 完成门禁, 全量diff。

### AGT-RC-012 外部切 branch 或移动 HEAD 时暂停且不自动修复

前置条件：独立checkpoint run处于code、review、behavior三个代表状态之一；记录expected branch/HEAD。

步骤：分别在隔离场景人工切branch或创建外部commit；触发下一次dispatch/completion。

期望：run进入need_human并显示expected/actual branch或HEAD；不执行checkout/reset/rebase/stash；外部commit和文件保留。

失败判定：系统自动切回、覆盖外部commit、继续消费旧outbox，或错误信息无法定位漂移。

依赖：无。

标签：外部并发, Git漂移, 数据安全。

### AGT-RC-013 behavior outbox 必须绑定当前 checkpoint SHA

前置条件：独立run当前checkpoint为C2，behavior正在执行；准备C2、C1、空值和随机SHA四种outbox变体。

步骤：每次在独立fixture提交一个变体并触发completion；读取acceptance、round和active role。

期望：只有C2被消费；旧 outbox 先按 freshness 拒绝，当前 dispatch 的C1、空值、随机SHA新outbox均进入need_human；全部错误变体都不改变acceptance/round，不回弹或完成run。

失败判定：旧SHA或缺SHA结果推进、不同代码tree的证据被合并，或合法C2被拒。

依赖：无。

标签：协议, evidence绑定, stale-outbox。

### AGT-RC-014 disabled mode 与旧 run 保持现有流程

前置条件：准备一个新run显式disabled和一个缺少checkpoint字段的旧run fixture。

步骤：分别执行code -> review pass -> behavior；读取prompt、run JSON和Git log。

期望：两者沿用现有串行流程；不创建分支或commit；review outbox不要求reviewTarget，behavior outbox不要求verifiedCheckpointCommit。

失败判定：旧run解析失败、disabled被强制Git preflight、行为验收被final review新门禁阻断，或产生Git副作用。

依赖：无。

标签：向后兼容, disabled, 旧run。

### AGT-RC-015 真实侧栏展示 checkpoint 状态且不暗示已发布

前置条件：本地真实Runweave Web/backend已启动；准备处于首次review、增量review、need_human drift和done的checkpoint run状态。

步骤：使用 `$toolkit:playwright-cli` 打开terminal页面和Agent Team sidecar；逐个切换fixture/run并读取DOM、截图。

期望：启动区有显式checkbox和安全说明；执行区显示branch、task base、checkpoint、scope、target和drift；done文案区分“checkpoint/验收完成”与“已push/已发布”；disabled run不显示误导性SHA。

失败判定：用户无法判断当前review范围、checkpoint被展示成发布commit、drift只在日志不可见，或checkbox默认静默开启。

依赖：无。

标签：UI, Playwright, 可观测性。

## 验收通过标准

- AGT-RC-001 至 AGT-RC-015 全部通过并保留指定证据。
- review fail、stale verdict、source drift、branch/HEAD drift均不产生checkpoint或behavior副作用。
- 每个checkpoint commit tree与对应review target tree完全一致。
- 每个behavior结果绑定当前checkpoint SHA。
- 至少两个checkpoint的run必须经final full review后才done。
- backend两个commit故障窗口重启均保持exactly-once。
- dirty/non-Git/敏感文件/并发run均fail closed且不损坏工作区。
- disabled和旧run流程无Git副作用、无兼容回归。
- 当前用户repo在隔离fixture执行前后branch、HEAD、index和worktree不变。

## 2026-07-12 实施验证记录

本轮完成了实现门禁、隔离 Git fixture、API 边界和一条真实 Agent Team 主链路验证：

- `pnpm agent-team:verify-review-checkpoints`：21 项通过，覆盖 runtime/review artifact 排除、full/incremental/final target、commit tree、parent chain、commit recovery、empty diff、dirty/non-Git/detached/unborn、branch drift、review 后代码漂移、敏感路径及 rename 敏感路径拒绝。
- API 隔离 fixture：dirty 与非 Git 均返回 409；同 repo 第二个 checkpoint run 返回 owner run 409；`disabled` run 保持原 branch 且 `reviewCheckpoint=null`。
- 真实 run `atr_0e901d92_20260711232833`：在临时 repo 创建专用分支，首轮 full review target 仅含 `fixture.txt`，创建 C1 `84fb6625466f6f336224262630daa023018dd272`；behavior outbox 回传同一 SHA；final review 覆盖 task base `3ac32b58adf8e766405d34f064ad03ebf4914cd3` 到 C1，最终 `status=done`、`finalReviewedCommit=C1`。
- 真实流程首次运行暴露 `.runweave/**` 被纳入 staged tree，修复后 target 只含业务文件；final reviewer pane 复用又暴露 stale outbox 在 freshness 前校验 target，修复为先执行 mtime boundary。backend 热重启后旧 outbox 被忽略，新 final outbox 被消费且只完成一次。
- `$toolkit:playwright-cli`：确认 checkbox 默认关闭；开启后侧栏展示 branch、task base、C1、final reviewed SHA 和“本地 checkpoint 不代表发布”；最终 DOM 显示“Loop 已完成”。快照：`/tmp/agent-team-review-checkpoint-final.yaml`。
- `pnpm --filter @runweave/shared typecheck`、backend/frontend typecheck、`pnpm lint`、`git diff --check` 均通过。

### 2026-07-12 未执行项补跑

执行模式：`$toolkit:run-test-cases` 严格逐条模式。所有场景使用隔离 Git repo、真实 backend/tmux worker pane 和 pane-scoped outbox；为稳定制造 pass/fail/漂移窗口，在中断对应 worker 当前 turn 后写入确定性 outbox，再通过真实 `/internal/terminal-completion` completion feed 推进状态机。

- **AGT-RC-005 + AGT-RC-011：通过。** run `atr_3d74843e_20260712001120` 生成 C1 `de633a2434d982feb55ce8eeb0443fb3fd363a46`；behavior fail 回弹 code 后，incremental review 的 base 精确等于 C1，生成 parent=C1 的 C2 `0d622ddf7e316981e93406b63b15b631261f6ea4`；behavior 在 C2 通过后进入 final review，最终 `finalReviewedCommit=C2`、checkpoint 数仍为 2、run done。Playwright 快照：`/tmp/agent-team-remaining-c2-final.yaml`，DOM 显示 `C2`、最新/最终 SHA `0d622ddf` 和“Loop 已完成”。
- **AGT-RC-006：通过。** run `atr_3b590ad4_20260712001145` 的 reviewer 返回 P1/fail 后立即回弹 code；HEAD 保持基线 `816bb93700f73009cdf1ab87241156ebd40e8627`，checkpoint 数为 0，behavior outbox 不存在。
- **AGT-RC-007：通过。** A 场景 run `atr_e3ef4f15_20260712001209` 在 reviewer 执行期间修改 `app.txt`，进入 need_human，原因精确为 `Reviewer 执行期间代码 worktree 已变化：app.txt`；B 场景 run `atr_39c4b29c_20260712001238` 修改测试案例文件，old/new SHA 被记录，未 commit、未启动 behavior。
- **AGT-RC-009：通过。** run `atr_f6fa4a6d_20260712001319` 在 review pass outbox 已写、commit 前触发 backend 重启；`serviceInstanceId` 从 `backend:ca727ee3-b346-4dfd-827a-18b680729e11` 变化为 `backend:8aa5fa85-0813-47d9-8b40-8aeafee77a20`。恢复后只生成 commit `aee9b636a0eaa78bca707228217dd504689ea998`，commit count=1、checkpoint log count=1。
- **AGT-RC-010：通过。** run `atr_dd345366_20260712001402` 先创建带 trailer 的 commit `3e45500f70cdfa77948f9e2deaed5f68d496edd5`，同时保持 run JSON pending；backend `serviceInstanceId` 从 `backend:8aa5fa85-0813-47d9-8b40-8aeafee77a20` 变化为 `backend:c5ee40ff-010e-450c-b0cd-42e6d1fdd242`。启动恢复识别原 commit，commit count=1，没有生成 C1 副本。
- **AGT-RC-013：通过。** 当前 C2 SHA `e5139910b67ce1d9b7b7f6392bd9b67354c58337` 被消费并完成 final；旧 C1、null、随机 SHA 三个独立 run 均进入 need_human，acceptance 保持 pending、round 不变，错误记录 expected/actual SHA。
- **AGT-RC-014：通过。** disabled run `atr_4c721085_20260712001715` 和删除 `reviewCheckpoint`/`reviewCheckpointMode` 字段的旧 run fixture `atr_de3776ff_20260712001739` 均完成 code → review → behavior；review outbox 无 reviewTarget、behavior outbox 无 verifiedCheckpointCommit，branch 始终为 main，HEAD 不变且没有 checkpoint state。

补跑结论：此前未执行的 AGT-RC-005/006/007/009/010/011/013/014 均已通过；未修改任何用例判据或实现代码。
