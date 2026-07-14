# Terminal Activity Work History 测试案例评审

## 结论

测试案例文档可解析且具备基本可追溯性：当前 Agent Team run 已从 `docs/testing/terminal-activity-work-history-test-cases.md` 加载 AGT-WH-001 至 AGT-WH-024，并保存 `sourceFilePath`、`sourceHeading` 与生成文件 SHA-256。现有用例覆盖 Terminal/Run 档案、Thread detail、降级、分页、Round 归属、鉴权和旧 Activity 回归，主体结构成立。

但当前文档不能直接视为无歧义的最终验收基线。发现 4 项 P1、3 项 P2；其中本轮新暴露的 terminal agent prepare/串行 dispatch 故障没有任何正式 behavior case，只被受控 verifier 间接覆盖。

## P1 严重

### 1. 本轮 terminal agent prepare 与串行 review 恢复没有可追溯行为用例

- 风险：AGT-WH-001 至 AGT-WH-024 全部围绕 Work History 产品行为，完成判定也只要求这 24 项；当前真实故障是 existing panel respawn、固定 10000ms、单次完整命令提交、prepare 返回 `starting`、以及 Backend 随后建立 `code_review` dispatch。即使受控 verifier 通过，正式 `behavior_verify` 仍可以完全不执行这条产品路径并宣称验收完成。
- 定位：`docs/testing/terminal-activity-work-history-test-cases.md:72`、`docs/testing/terminal-activity-work-history-test-cases.md:820`；当前 run 的 behavior worker 也只绑定该文件，见 `.runweave/agent-team/atr_f4741241_20260713184034.json:99`。
- 修复方向：不要静默修改当前已冻结 SHA-256 的生成文件。新增独立、可追溯的 terminal-agent preparation 测试文档或通过正式重新提案纳入 acceptance，至少覆盖：新建/复用 panel；9999ms 前零发送；10000ms 后恰好一次完整命令；复用 panel 无条件 respawn；响应为 `starting` 且 `threadId=null`；后续 lifecycle/MCP 不阻断 prepare；code completion 后 Backend 串行建立 `code_review` dispatch；并发 prepare 被拒绝。

### 2. 同时间 Journal 事件的期望没有给出唯一顺序

- 风险：用例要求“固定类型优先级”，但没有定义类型顺序；`terminal → thread → turn → activity` 与任意其他固定顺序都能被验收者解释为通过，无法发现排序语义漂移。
- 定位：`docs/testing/terminal-activity-work-history-test-cases.md:197`、`docs/testing/terminal-activity-work-history-test-cases.md:211`；计划也只写“稳定类型优先级”，见 `docs/plans/2026-07-13-terminal-activity-work-history.md:372`。
- 修复方向：在计划和用例中冻结完整比较键，例如 `occurredAt asc → terminal/thread/turn/activity priority → sourceId asc`，并给出同一时间四类事件的明确期望 ID 序列。

### 3. 搜索和非法参数允许相反实现同时通过

- 风险：“Terminal ID、项目名、cwd 或可支持字段”没有冻结搜索字段；257 字符 search 和越界 limit 又允许“返回 400 或安全归一化”。验收者无法区分漏实现、截断、clamp 和拒绝，属于泛化 acceptance。
- 定位：`docs/testing/terminal-activity-work-history-test-cases.md:403`、`docs/testing/terminal-activity-work-history-test-cases.md:411`、`docs/testing/terminal-activity-work-history-test-cases.md:419`；计划只给出范围，见 `docs/plans/2026-07-13-terminal-activity-work-history.md:178`。
- 修复方向：先冻结精确搜索字段和规范化规则；对 search 长度 256/257、limit 0/1/100/101、非法 cursor 分别给出唯一 HTTP 状态与响应体期望，不使用“或”。

### 4. query 深链和刷新恢复只有描述，没有可执行步骤

- 风险：计划明确要求 query 保存子导航和选中 ID，刷新后恢复；现有 AGT-WH-001 只验证无 query 的默认页，AGT-WH-012 仅写“保持各自选择或按 query 合约恢复”，没有直接访问 URL、刷新、前进/后退或 event 选择断言。实现即使完全忽略 query，也可能通过现有步骤。
- 定位：`docs/plans/2026-07-13-terminal-activity-work-history.md:349`、`docs/plans/2026-07-13-terminal-activity-work-history.md:352`；`docs/testing/terminal-activity-work-history-test-cases.md:103`、`docs/testing/terminal-activity-work-history-test-cases.md:432`、`docs/testing/terminal-activity-work-history-test-cases.md:449`。
- 修复方向：增加 terminals/runs 两条直接深链用例，固定 `view`、对象 ID、event ID；验证首次加载、刷新、浏览器前进/后退和无效 ID 恢复后的 URL、列表选择、Journal 与 Inspector 一致。

## P2 一般

### 5. `thread_not_found` 合约分支没有正向用例

- 风险：Thread detail availability 定义了 `thread_not_found`，但现有用例只覆盖 available、provider_unavailable、provider_unsupported；AGT-WH-018 仅把误报 `thread_not_found` 当失败，没有验证真实 Thread 不存在时的 API/UI 行为。
- 定位：`docs/plans/2026-07-13-terminal-activity-work-history.md:180`、`docs/testing/terminal-activity-work-history-test-cases.md:227`、`docs/testing/terminal-activity-work-history-test-cases.md:260`、`docs/testing/terminal-activity-work-history-test-cases.md:599`。
- 修复方向：增加 ThreadRef 仍存在但 Provider 返回 not found 的场景，断言 Terminal/ThreadRef 元数据保留、availability 精确为 `thread_not_found`、不误报 provider unavailable，也不使 archive 整体失败。

### 6. 响应式断点没有验证 1380px 边界

- 风险：计划冻结 `>=1380px` 内嵌、`<1380px` 抽屉；用例只测 1440 和 1100，无法发现 1380 的包含关系或 1379/1380 off-by-one。
- 定位：`docs/plans/2026-07-13-terminal-activity-work-history.md:45`、`docs/testing/terminal-activity-work-history-test-cases.md:374`、`docs/testing/terminal-activity-work-history-test-cases.md:382`。
- 修复方向：至少补 1379 与 1380 两个 viewport，并保留 Escape、焦点恢复和页面滚动断言。

### 7. 数据源失败场景缺少确定性的故障注入与恢复步骤

- 风险：AGT-WH-006 写“停止 Provider 或置为不可用”，AGT-WH-007 写“Activity Query 暂时失败”，但没有规定只作用于隔离 Dev Session 的方法、失败持续时间和恢复断言。不同验收者可能使用 mock、停错 Stable 服务，或只阅读代码即判定。
- 定位：`docs/testing/terminal-activity-work-history-test-cases.md:260`、`docs/testing/terminal-activity-work-history-test-cases.md:290`；环境约束见 `docs/testing/terminal-activity-work-history-test-cases.md:41`。
- 修复方向：给出 Dev Session 内可复现的故障注入入口和恢复步骤，分别断言故障期间 API/UI 降级、`/health`、恢复后重新读取，以及 dedicated 资源清理；禁止用静态阅读或 Stable 服务停机替代。

## 已确认无问题的部分

- 当前文件是可解析的生成测试案例文档，不存在“缺少可追溯测试案例文件”。
- 24 个业务 case 均有前置条件、步骤、期望、失败判定和证据要求。
- 严格首败停止、选择性重跑、Dev Session/CDP/Playwright 证据和资源清理规则写得明确。
- AGT-WH-015 已明确要求 `unavailable` 进入未归属事件且 Inspector 展示归属来源，能够捕获此前真实产品失败。

## 更简单的修复路径

保持原 Work History 文档冻结，不在当前执行中的 run 内直接改 SHA-256。先为 terminal-agent preparation 建一份窄范围测试文档并由独立 behavior verifier 执行；原文档只补齐排序、参数、深链、not-found 和断点这 5 类歧义后，再通过正式 acceptance 更新流程生成新哈希。这样比把基础设施故障混入 AGT-WH-001 至 AGT-WH-024 更容易追踪，也不会让现有 C1-C4 checkpoint 在中途失效。

## 检查证据

- 读取计划、测试案例、当前 run package 与实际 Journal 排序实现。
- 当前 run package：24 个 AGT-WH case 均包含 `sourceFilePath` 和 `sourceHeading`；另有独立 code review gate `case_25`，它不是 terminal-agent behavior case。
- 未修改计划、测试案例、源码或 run/outbox。
