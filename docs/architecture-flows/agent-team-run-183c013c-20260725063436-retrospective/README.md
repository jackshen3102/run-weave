# Agent Team run `atr_183c013c_20260725063436` 深度复盘

## 核心判断

这个 Run 最终成功，13 个唯一业务 Case 全部通过；正常产品修复只有 1 个：
`AGT-MC-003` 在同一 Browser Profile 重启后丢失全局模型配置。

主要人工成本不是产品实现，而是一个仍存在的框架分类缺陷：
`isReviewGateAcceptanceCase()` 会扫描整个 Case 文本，只要出现
`code_review`、`code review` 或“代码审查”就把业务 Case 当成 Review Gate。
`AGT-MC-002` 的步骤只是枚举四个产品角色，却因此两次被派给 `code_review`，
并从 `behavior_verify` 的自动集合中消失。

最终通过等价中文措辞和定向 `refresh_acceptance` 恢复，但这个动作没有修复分类器，
还触发了第二个当前缺陷：Run JSON 中保留了旧的误分类 Gate，再追加新的业务 Case，
因此当前存储为 14 行 acceptance、13 个唯一 Case，`AGT-MC-002` 重复两次。

## 事实基线

- Run：`atr_183c013c_20260725063436`
- Terminal：`183c013c`
- 创建：`2026-07-25T06:34:36.374Z`
- 完成：`2026-07-25T10:29:21.207Z`
- 总时长：`3h 54m 44.833s`
- 最终状态：`done`
- Completion：`succeeded / automatic`
- 当前 pane：main、code、code_review、behavior_verify 均为 `agent_idle`
- 验收：13/13 唯一业务 Case 通过；Run 内 14/14 行为 `pass`，其中 `AGT-MC-002` 重复
- Dispatch：7 个历史 outbox，7 个 dispatch 全部被消费
- 正式 intervention：3 次
- Human Gate：1 次正式 `need_human`
- 静默悬空：2 次 `running + activeWorkerRole=code_review + activeWorkerDispatch=null`
- Repair：1 个已收口产品修复，`behavior_verify:AGT-MC-003`
- Finding / disposition：0 个 P0/P1 finding，0 次人工 disposition
- Fixture cleanup：3 次 cleanup history 均为 `completed`，最终所有已知 Dev Session
  `ownedLiveFixtureRuns=0`

## 查看报告

在仓库根目录执行：

```bash
python3 -m http.server 6188 \
  --directory docs/architecture-flows/agent-team-run-183c013c-20260725063436-retrospective
```

然后打开：

```text
http://127.0.0.1:6188/
```

主报告是 [`index.html`](./index.html)，浏览器验收截图是
[`prototype-preview.png`](./prototype-preview.png)。

## 证据来源

### 控制面

- `.runweave/agent-team/atr_183c013c_20260725063436.json`
  - 最终状态、21 条 run 日志、3 次 intervention、7 个 consumed dispatch、
    completion、fixture cleanup、最终 acceptance
- `.runweave/outbox-history/atr_183c013c_20260725063436/`
  - Round 1–5 共 7 份 pane-scoped 历史 outbox
- `rw terminal panel list 183c013c --json`
  - 复盘时四个 pane 的 live idle 状态
- `rw terminal history 183c013c --panel <alias> --json`
  - worker 是否收到任务、503、outbox 写入、cleanup 卡住、人工续推与 interrupt

### 验收来源

- `docs/plans/2026-07-25-agent-team-global-role-model-config.md`
  - SHA-256：`c2b5e744969253b674633d0131c984b7d6f7a28ac146632f33a719f44d62a379`
- `docs/testing/agent-team/configuration/agent-team-role-model-config.testplan.yaml`
  - SHA-256：`2c3bf2773433def798716b98d11cca2c901441a5e59ead9b09af58f8802a6fed`
  - 13 个 required Case

### 真实产品证据

- `.runweave/evidence/AGT-MC-003-same-profile-backend-restart/dvs-411c86/`
  - 修复前 `config=null` 与修复后重启恢复的 Before/After
- `.playwright-cli/round4-agt-mc-003-project-a.yaml`
- `.playwright-cli/round4-agt-mc-003-project-b.yaml`
- `.playwright-cli/round4-agt-mc-003-after-restart.yaml`
- `.playwright-cli/round5-agt-mc-002-provider-cleared.yaml`
- `.playwright-cli/round5-agt-mc-002-traex-selected.yaml`
- `.playwright-cli/round5-agt-mc-002-after-cancel.yaml`
- `.playwright-cli/round5-agt-mc-002-after-save.yaml`
- `docs/review/2026-07-25-agt-mc-002-code-review-round-3.review.md`

### 当前代码链路

- `backend/src/agent-team/service-acceptance-refresh-policy.ts:7`
  - 整段文本正则误分类 Review Gate
- `backend/src/agent-team/service-acceptance-policy.ts:34`
  - `code_review` 与 `behavior_verify` 按误分类结果分流
- `backend/src/agent-team/service-round-execution.ts:99`
  - completion 后清空 dispatch，却保留旧 active role
- `backend/src/agent-team/service-round-execution.ts:321`
  - 只有 Review Gate `pass` 才进入 behavior；否则可直接持久化悬空状态
- `backend/src/agent-team/service-acceptance-refresh-policy.ts:125`
  - refresh 保留旧“Gate”并追加 refreshed product cases，产生重复 Case
- `backend/src/agent-team/service-completion-recovery.ts:12`
  - 缺 dispatch 的恢复只在后续 completion reconciliation 被触发；当前转换本身没有闭环

## 判断边界

- `AGT-MC-003` 是已由真实产品复现、修复并用 fresh Beta desktop 独立复验的
  `真实产品缺陷 / 已修复`。
- Stable Terminal Browser 当时没有目标 Dialog、`code_review` 又不允许创建产品
  fixture，是该错误 dispatch 的真实 `环境能力问题`，但不是根因；正确路由本就不该让
  `code_review` 执行这个行为 Case。
- 测试合同使用四个正式角色 ID 是合理的。把它改成等价中文是恢复 workaround，
  不是“原合同错误”的证据。
- Code worker 的长墙钟时间包含真实打包/重启验证和外部 Codex 503，不能直接解释为
  实现效率。
- 行为 worker 在完成真实验收后卡在 finally/outbox 阶段是已观察事实；其内部推理停顿
  原因未被复现，因此报告把“Agent 为什么停住”标为观察风险，把“控制面没有普通 worker
  liveness watchdog”标为当前韧性缺口。

## 浏览器验收

使用 `$toolkit:playwright-cli` 在 1440 × 900 视口打开本地静态报告：

- 页面标题与主结论正确；
- 6 个关键指标按 3 × 2 排列，6 条改进建议完整渲染；
- `scrollWidth === clientWidth === 1440`，无页面级横向溢出；
- 浏览器控制台为 0 error、0 warning；
- 验收截图：`prototype-preview.png`。
