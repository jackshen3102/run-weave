# Agent Team Completion Outcome 改动范围评审

> 状态：已按本报告先将核心切片由 29 个生产源码文件收缩为 14 个。随后用户明确要求 Acceptance Case
> 人工裁决，增加了 route、前端 service、面板卡片和裁决展示；另根据实现复核修复 mutation 误用只读投影。
> 当前共 22 个生产源码文件，Activity/export/Work History、failed/cancelled outcome 和 Phase 2
> `follow_up` 仍未进入本 patch。

## 后续必要扩展

- 14 文件核心切片只能阻止假完成，不能满足“人工确认环境问题或 Case 不合理后继续完成”的目标。
- 新增的 7 个裁决垂直切片文件分别对应 API route、前端请求、状态模型、裁决卡片、面板接线和证据展示；
  没有加入通用 complete 按钮或 follow-up 预留。
- `service-completion.ts` 是实现复核发现的 P1 修复：mutation 必须读取原始 store Run，不能把只读历史投影
  回写为真实 observation。该文件不属于功能扩张，而是 completion outcome 的审计正确性门禁。

## 结论

**评审时范围过大，不建议以当时状态继续进入第二阶段。** 根因不是 completion outcome 天然需要一次修改
29 个生产文件，而是第一阶段同时包含了核心状态机、所有读模型/UI 投影、failed/cancelled 全终态统一、
历史迁移和完整两阶段文档。应先收缩为可独立发布的核心切片。

## 发现

- **P1：第一阶段混入三个可独立发布的影响闭包。** 当前 tracked diff 涉及 29 个生产文件、
  374+/135-，另有 249 行新策略模块；其中约 12 个文件属于 Activity/export/Work History/UI 投影，
  3 个文件属于 failed/cancelled 终态补齐。它们不是封死 `/complete` 绕过所必需，扩大了回归与回滚
  面。定位：`backend/src/agent-team/service-lifecycle.ts:452-545`、
  `backend/src/agent-team/service-round-execution.ts:159-273` 以及当前 `git diff --numstat`。修复方向：
  第一提交只保留 observation、统一 evaluator、自动/人工 completion 与 pending reset；读模型和全终态
  投影分别后置。
- **P1：第一阶段共享合同提前声明尚不存在的 follow-up exception。** `follow_up` exception 引用了
  尚未实现的 workItemId，使 Phase 1 wire contract 对外承诺 Phase 2 能力，也增加旧消费者影响闭包。
  定位：`packages/shared/src/agent-team-run-contract.ts:28-31`。修复方向：Phase 1 只声明当前真实产生的
  exception；`follow_up` 在 Work Item 实现时随同加入。
- **P2：单个 completion policy 承担了五种职责。** 249 行模块同时处理 observation resolver、历史读
  投影、completion predicate、history append 和 legacy terminal migration；后续再加入 work item closure
  会继续膨胀。定位：`backend/src/agent-team/service-completion-policy.ts:39-249`。修复方向：核心切片只保留
  resolver/evaluator/finalize；legacy read projection 在单独后续切片接入。
- **P2：`completeRun` 串行化造成大段机械 diff。** 为增加 `enqueue`，原方法整体缩进，单文件形成
  103+/84-，降低评审信噪比。定位：`backend/src/agent-team/service-lifecycle.ts:452-545`。修复方向：公开
  方法只 enqueue 到小型 unlocked helper，保留原完成主体的行结构。
- **P2：自证材料本身也超过当前实现粒度。** 新 verifier 353 行，计划、评审和两份 YAML 合计约
  876 行；它们覆盖了尚未实现的第二阶段和真实 UI，全量材料不应与最小核心 patch 混为同一提交。
  定位：`scripts/verify-agent-team-completion-outcome.mjs:1-353` 及 `docs/plans` / `docs/testing` 新文件。
  修复方向：核心 patch 保留 4 个否决性检查：skipped 阻断、manual/auto 同 predicate、blocked complete
  零 cleanup/零写、pending reset 清 observation；第二阶段合同独立提交。

## 推荐收缩边界

建议将第一阶段收缩到约 13 个生产文件：共享 observation/outcome 合同、loop 写 observation、统一
completion evaluator、auto/manual 两个完成入口、三个 Run 读取边界，以及 serial/recheck/refresh 的
observation 清理。暂时撤出 Activity、export、Work History、六个前端投影和 failed/cancelled outcome；
这些作为第一阶段后续小提交逐个接线。这样不会重新开放 `/complete` 绕过，也不会提前实现 follow-up。

## 检查范围

- 只读检查当前 `git diff --numstat`、共享协议、completion policy、自动/人工完成链路和 verifier。
- 未修改实现代码、配置或测试。
