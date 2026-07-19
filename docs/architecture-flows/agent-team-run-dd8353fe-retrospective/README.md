# Agent Team Run dd8353fe 深度复盘

## 核心判断

`atr_dd8353fe_20260719020754` 最终成功完成，7 个 required acceptance case 全部通过。这个 run 同时证明了两件事：

1. 独立 code review 与 behavior verify 有效识别并推动修复了 RuntimeTrace 的 3 个产品不变量。
2. 第一次 review 失败后的 repair bounce 因 code pane 生命周期没有收敛而停止，造成 7 小时 28 分 51 秒 Human Gate 等待，占总时长 78.2%。

最终 `done` 只证明产品 repair 与验收闭环；本次没有修改或重新验证 lifecycle/bounce 框架缺陷，因此不能把该框架问题标记为已修复。

## 查看方式

```bash
python3 -m http.server 6188 --directory docs/architecture-flows/agent-team-run-dd8353fe-retrospective
```

浏览器打开 `http://127.0.0.1:6188/`。

## 事实快照

- 快照时间：`2026-07-19T12:04:01Z`
- Run：`atr_dd8353fe_20260719020754`
- Terminal：`dd8353fe`
- 创建：`2026-07-19T02:07:54.629Z`
- 完成：`2026-07-19T11:42:14.215Z`
- 总时长：`9h 34m 19s`
- Human Gate 等待：`7h 28m 51s`，占 `78.2%`
- 恢复后到完成：`1h 22m 33s`
- 最终 acceptance：`7 pass / 0 fail / 0 pending / 0 skipped`
- Optional：`ASEA-008 required=false`，未进入 run
- Dispatch：`9` 个已消费，构成为 `code 4 / code_review 4 / behavior_verify 1`
- 独立 review：`3 fail → 1 pass`
- Human/Agent intervention：`1`
- 最终 pane：main、code、code_review、behavior_verify 全部 `agent_idle`
- 完成方式：automatic

## 端到端事实主线

1. 测试计划以 `test_case_file` 进入 run，自动 split 为 code、code_review、behavior_verify 三个 worker。
2. Round 1 code outbox 自报 ASEA-001～007 pass，watchdog 成功消费；完成证据没有丢失。
3. Code Stop 于 `02:42:40Z` 到达，但 direct hook 与 App Server hook 都因 `inactive_agent` 被忽略。
4. Round 1 reviewer 通过两个 review harness 复现 ASEA-004 的两个 P1，正确覆盖 code worker 的自判 pass。
5. Backend 尝试把失败 bounce 回 code pane；pane 仍是 `agent_starting`，同一 recorded thread 未进入 ready，安全门禁拒绝投递并进入 `need_human`。
6. Code pane 后续自行收敛为显式 `agent_idle`，但 run 没有自动恢复。`2026-07-19T10:19:40.586Z` 通过精确 `code / ASEA-004` intervention 建立 fresh dispatch。
7. Round 2～4 依次闭合 asset assignment、dispatch feedback attribution 和 RuntimeTrace run/dispatch discoverability；Round 4 review 通过。
8. Round 5 behavior worker 在 owner-scoped Beta Session `dvs-756687` 完成生产 verifier 与 desktop CDP 认证 API 验证，资源清理完成，run 自动结束。

## 根因分类

### 已确认框架缺陷

完成 outbox 已被消费，但 Stop 在 current agent identity 已清理后被视为 inactive，pane 没有及时收敛为 idle。随后 `submitWorkerDispatchPrompt()` 对 `agent_starting + lastThreadStatus=idle` 执行 readiness 等待，等待失败后按安全合同拒绝 bounce。

影响：一次 lifecycle 故障阻断串行 repair loop，并让其余 6 个当时 pending 的 required case 无法继续。

### 已修复 / 部分修复

最终 review 记录 3 个 resolved P1 invariant：

- `evolution.assignment-stable-per-run-asset`
- `evolution.runtime-trace-dispatch-attribution`
- `evolution.runtime-trace-discoverable-by-run-dispatch`

当前代码证据：

- `backend/src/evolution/injection/memory-provider.ts` 以 `assetId` 进入 assignment hash。
- `backend/src/evolution/injection/outcome-observer.ts` 使用 `recordForDispatch()` 和 `recordAgentFeedbackForDispatch()`。
- `backend/src/routes/evolution-activation.ts` 提供 `GET /runtime-traces?runId=&dispatchId=`。
- Round 4 review outbox 没有 open P0/P1；Round 5 behavior outbox 完成真实 Beta/API 验证。

这里的“部分修复”只针对产品链；lifecycle/bounce 框架缺陷仍未关闭。

### 验收合同问题

`ASEA-004` 同时要求：

- 同一 run/asset assignment 幂等；
- dispatch 级 outcome 与 Agent feedback 归因；
- 真实任务能够按 run/dispatch 读取 RuntimeTrace。

三个独立不变量共享一个 caseId，导致 Round 1～3 每次修复后继续以同一 ASEA-004 暴露下一层边界。合同方向正确，但不利于选择性重跑和进度解释。

### 环境能力问题

未发现阻断性环境能力问题。Beta Session、dedicated Backend、desktop CDP、认证 API 和资源清理均成功。Round 5 记录：`dvs-756687` 最终 stopped，`ownedLiveFixtureRuns=0`。

## 精确证据来源

### Run 与验收来源

- `.runweave/agent-team/atr_dd8353fe_20260719020754.json`
- `docs/plans/2026-07-19-agent-self-evolution-v1.md`
  - SHA-256：`78336793ed2b962879472416018bdb80e957b38f079bba7b0440e7317583309f`
- `docs/testing/evolution/agent-self-evolution-activation.testplan.yaml`
  - SHA-256：`c3053ae1e750b9ea346b11d8b4ada483e9085a13591abb5491f21ac0424ef1cb`

上述两个当前文件 SHA 与 run JSON 内固定值一致。

### Worker 产物

- `.runweave/outbox-history/atr_dd8353fe_20260719020754/round-0001/`
  - 初始 code 完成与第一次 reviewer 两条 P1。
- `.runweave/outbox-history/atr_dd8353fe_20260719020754/round-0002/`
  - 第一次 repair 及 asset revision / missing feedback 新边界。
- `.runweave/outbox-history/atr_dd8353fe_20260719020754/round-0003/`
  - 第二次 repair 及 RuntimeTrace 不可发现新边界。
- `.runweave/outbox-history/atr_dd8353fe_20260719020754/round-0004/`
  - RuntimeTrace 查询入口修复与最终 review pass。
- `.runweave/outbox-history/atr_dd8353fe_20260719020754/round-0005/`
  - Behavior verify、Beta Session/CDP 证据与资源清理。

### 框架故障

- `$HOME/.runweave/browser-profile/8a5edab2/logs/backend/backend-2026-07-19.jsonl`
  - `02:42:09Z`：code outbox completion reconciled。
  - `02:42:40Z`：Stop 被 App Server/direct hook 以 inactive agent 忽略。
  - `02:50:48Z`：`agent-team.bounce.failed`，明确拒绝向 agent_starting pane 投递。
- `backend/src/agent-team/service-worker-dispatch-support.ts:193`
  - Worker prompt 的 agent/thread readiness 安全门禁。
- `backend/src/agent-team/service-intervention.ts:187`
  - 精确 code repair case 选择与 fresh bounce 路径。

## 指标解释边界

- 9 个 consumed dispatch 不等于 9 次人工操作；只有 1 次 intervention。
- 3 次 review fail 是 3 个 reviewer dispatch，不等于 3 个相同失败。每轮都收敛了新边界。
- 历史上共出现 5 个 P1 finding 实例，但最终可归并为 3 个 unique invariant，不能按实例数夸大根因数量。
- Code worker 的 requestedAt → recordedAt 包含 Agent 工作、outbox 写入和 watchdog 消费等待，不能直接解释为纯编码效率。
- `UI 已抛回` 只表达调度意图；只有新 dispatch、pane UserPromptSubmit 和 active thread 状态能证明 worker 实际收到消息。

## 浏览器验收

- 页面：`index.html`
- 截图：`prototype-preview.png`
- 视口：`1440 × 900`
- 结构检查：标题、核心判断、关键指标和建议均存在；默认页面无横向溢出。
- Console：0 error。
