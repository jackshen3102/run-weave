# ATFR-006 Case 合理性评审

## 结论

ATFR-006 应保留，不属于可忽略的边界 Case。它覆盖 framework repair 的两个主恢复决策之一 `rerun` 的正常路径。本轮已从真实产品入口复现失败；失败点不是新 Run 创建或数据隔离，而是 terminal-bound 当前 Run 与 Agent Team 面板继续选择旧 failed predecessor，隐藏了正在运行的 successor。

## 评审发现

- **P1：ATFR-006 当前失败真实且影响核心 rerun 闭环，不应降级为边界问题。** Round 8 真实执行创建了旧 Run `atr_2fbcddd2_20260717225217` 和 running successor `atr_08cd2103-2fbcddd2_20260717225319`；双向关联、输入继承、执行结论清空和新 dispatch 都成立，但 terminal-bound 查询仍返回旧 failed Run，面板也展示旧失败态。用户点击主路径“重新运行”后看不到正在执行的新 Run，可能误判 rerun 失败、重复创建 Run，或无法继续观察和控制新 Run。证据：`.runweave/agent-team/atr_a07db00d_20260717170123.json`、`.runweave/evidence/dvs-ad769e-round8-atfr006-ui-stuck-on-predecessor.png`。
- **P3：UI 截图的等待时间证据不够独立，但不推翻总体复现。** 页面轮询周期为 4000ms，而验收记录写的是等待 3.5 秒；仅凭截图不能证明经过完整轮询仍未切换。不过 terminal-bound CLI/API 已确定返回旧 predecessor，且旧算法从按 `updatedAt` 降序的列表直接取同 terminal 第一条，predecessor 在关联写入后更新时间更晚，因此错误是确定性的，不依赖截图等待时长。定位：`frontend/src/components/terminal/terminal-agent-team-panel-model.ts:8`、`backend/src/agent-team/storage/run-store.ts:58`。
- **P3：Case 同时包含数据隔离与 UI 选择两个层次，报告时应分层，不应删除 UI 断言。** 数据隔离已经通过，当前唯一失败是 active successor 选择。计划虽然没有逐字写“自动切换”，但要求 rerun 创建并启动全新 Run、保留新旧关联；前端动作响应也明确优先采用 `successorRun`。如果 terminal-bound 查询随后返回旧 Run，会破坏该产品语义。定位：`docs/plans/2026-07-17-agent-team-framework-repair-recovery.md:99`、`frontend/src/components/terminal/terminal-agent-team-panel.tsx:201`。

## 能否复现

可以，当前证据为一次完整真实产品复现，而不是静态推断：

1. 从真实 beta desktop 创建并 begin framework repair Run。
2. 通过产品入口重启 Backend，在面板点击“重新运行”。
3. successor 成功创建并处于 `running`，使用独立新 dispatch。
4. terminal-bound 查询仍选择旧 `failed` predecessor，面板展示旧失败态。

旧实现的选择逻辑也能解释稳定性：Run 按 `updatedAt` 降序排列，rerun 最后更新 predecessor 的 `successorRunId`，随后按 terminal 直接取第一条，因而会稳定选中 predecessor。当前工作区已有“优先选择非 `done`/`failed` Run”的候选修改，但真实 packaged runtime 验证尚未完成，不能提前判定已修复。

## 合理性与重要性

- 在全部 Agent Team 使用中，framework repair rerun 的触发频率不高。
- 但进入 framework repair 后，rerun 是仅有的两个用户决策之一，是正常主路径，不是错误注入或极短崩溃窗口。
- 在旧实现上，该路径的选错条件是确定性的；不是低概率竞态。
- 影响是“后台已有新 Run 运行，但用户看到旧 Run 已失败”，属于控制面状态错误，不是纯视觉瑕疵。

因此应按“低频功能中的核心路径缺陷”处理，而不是按边界 Case 忽略。

## 更简单的验收表达

不必拆成更多 Case。保留 ATFR-006，但把结论分成两层即可：

1. 存储层：新旧 Run 双向关联、输入继承、执行结论清空、新 dispatch 隔离。
2. 当前 Run 选择层：rerun 返回后以及至少一个完整轮询周期后，terminal-bound 查询与面板都指向 running successor；旧 predecessor 仍可按 runId 或历史入口回看。

这样可以精准定位失败，同时避免把已通过的数据隔离部分反复描述成“rerun 整体未修复”。

## 残余风险

- 候选选择修复仍需在包含当前 patch 的真实 runtime 中用同一 scenario 复验。
- UI 证据应等待至少一个完整 4000ms 轮询周期，建议使用 5 秒以上的确定等待或轮询到 successor runId，而不是固定 3.5 秒截图。
