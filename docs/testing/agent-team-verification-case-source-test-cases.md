# Agent Team 验证用例来源测试案例

本文档由 `docs/plans/2026-07-08-agent-team-verification-case-source.md` 生成，用于验证 Agent Team 的 `behavior_verify` 验收来源从后端泛化默认用例改为可追溯的计划文件 / 测试案例文件合同。

## 范围

覆盖：

- 启动面板新增 `计划文件` 和 `测试案例文件` 两个输入。
- `测试案例文件` 优先于 `计划文件`。
- 没有测试案例文件时，主 Agent 必须调用 `$toolkit:write-test-cases` 生成 `docs/testing/*-test-cases.md`。
- 无法解析测试案例时阻止 worker split，不生成默认 acceptance。
- `behavior_verify` prompt、run JSON、UI 对来源文件和 case ID 的表达一致。
- 修复后按失败点、未执行项、依赖和影响面决定复验范围。
- 至少一个真实 Runweave UI + 真实 worker pane + `$playwright-cli` 的闭环验收。

不覆盖：

- 不穷举 Markdown parser 的所有格式变体；只覆盖 `docs/testing/*-test-cases.md` 主流三级标题格式。
- 不验证 Electron 桌面端；本需求的可观察入口在 Web terminal Agent Team sidecar。
- 不验证 `$toolkit:write-test-cases` 技能自身质量，只验证 Agent Team 是否要求使用技能并消费落盘产物。
- 不接受 mock worker、手写 outbox、伪造 completion 或直接调用 `/round` 作为最终通过依据。

## 前提事实

- 计划来源：`docs/plans/2026-07-08-agent-team-verification-case-source.md`。
- Agent Team UI 入口：`frontend/src/components/terminal/terminal-agent-team-panel.tsx`。
- Proposal / Executing 展示：`frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`。
- API 路由：`backend/src/routes/agent-team.ts`。
- Markdown case loader：`backend/src/agent-team/acceptance-case-loader.ts`，识别 `### [A-Z][A-Z0-9-]*-\d{3}`。
- 编排服务：`backend/src/agent-team/service.ts`。
- worker prompt：`backend/src/agent-team/prompt-builders.ts`。
- run 状态：`.runweave/agent-team/<runId>.json`。
- worker 证据：pane-scoped `.runweave/outbox/<session or panel>.json`。

## 必跑命令

任一失败即停：

```bash
pnpm --filter ./packages/shared typecheck
pnpm --filter ./backend typecheck
pnpm --filter ./frontend typecheck
pnpm --filter ./frontend lint
git diff --check
```

浏览器行为验证必须使用 `$playwright-cli` 打开真实 Web terminal 页面取证；静态检查不能替代 UI、worker pane、run JSON 或 outbox 证据。

## 覆盖清单

- 功能正确性：AGT-VERIFY-001 到 AGT-VERIFY-004 覆盖 UI、文件优先级、计划生成、任务生成。
- 边界与异常：AGT-VERIFY-005 到 AGT-VERIFY-007 覆盖不可解析文件、缺失路径、项目外路径。
- 状态与时序：AGT-VERIFY-008 到 AGT-VERIFY-010 覆盖 proposal/executing 来源、`behavior_verify` prompt 和复验范围。
- 数据与协议：AGT-VERIFY-002、AGT-VERIFY-003、AGT-VERIFY-008 验证 run JSON 中 `verification`、`acceptance[].sourceCaseId`、`sourceFilePath`。
- 安全与权限：AGT-VERIFY-007 覆盖项目目录边界；接口鉴权沿用现有 backend `requireAuth`，本轮不新增鉴权规则。
- 回归与兼容：AGT-VERIFY-005、AGT-VERIFY-009 防止回退到默认泛化 acceptance。
- 可取证性：每条用例均要求 DOM / 截图 / API 响应 / run JSON / pane capture / outbox 中至少一种真实证据。

## 用例

### AGT-VERIFY-001 启动面板展示计划文件和测试案例文件输入

前置条件：

- 本地 Runweave Web 与 backend 已启动。
- 存在一个 tmux-backed terminal session。
- 当前 terminal 没有 active Agent Team run，或已切到可新建 run 的项目终端。

步骤：

1. 使用 `$playwright-cli` 打开真实 terminal 页面。
2. 打开 Agent Team sidecar。
3. 查看开启流程区域。
4. 分别向 `计划文件` 和 `测试案例文件` 输入项目内相对路径后清空。

期望：

- 页面显示 `计划文件` 输入框。
- 页面显示 `测试案例文件` 输入框。
- 两个字段均可输入项目内相对路径，也可保持为空。
- 任务描述仍是启动流程所需的主要输入；空路径本身不触发错误。

失败判定：

- 任一输入框不存在、不可输入或 label / placeholder 无法定位。
- 仅因两个路径为空就阻止用户填写任务描述。
- UI 把空路径显示成文件不存在错误。

证据：

- `$playwright-cli` 截图或 DOM 摘要，包含两个输入字段。

### AGT-VERIFY-002 提供测试案例文件时 acceptance 来自该文件

前置条件：

- 存在项目内测试案例文件 `docs/testing/agent-team-verification-case-source-test-cases.md`。
- 该文件至少包含 `AGT-VERIFY-001` 和 `AGT-VERIFY-002` 两个三级标题 case。
- 当前 terminal 可启动新的 Agent Team run。

步骤：

1. 在 Agent Team 启动面板填写任务描述。
2. `测试案例文件` 填写 `docs/testing/agent-team-verification-case-source-test-cases.md`。
3. `计划文件` 留空。
4. 启动 Agent Team。
5. 读取 proposal / executing 面板和 `.runweave/agent-team/<runId>.json`。

期望：

- run JSON 的 `verification.acceptanceSource` 为 `test_case_file`。
- run JSON 的 `verification.testCaseFilePath` 为 `docs/testing/agent-team-verification-case-source-test-cases.md`。
- `acceptance[]` 中保留原始 case ID，例如 `caseId` 或 `sourceCaseId` 等于 `AGT-VERIFY-001`。
- acceptance 文案包含对应 case 的标题、步骤摘要、期望摘要和失败判定摘要。
- 默认泛化用例 `核心改动按任务目标落地`、`关键回归用例通过` 不出现在 behavior acceptance 中。

失败判定：

- acceptance 仍使用默认泛化用例。
- 原始 case ID 丢失或被替换成仅 `case_1` / `case_2`。
- run JSON 未记录来源文件。

证据：

- proposal / executing 面板 DOM 或截图。
- run JSON 中 `verification` 和 `acceptance` 片段。

### AGT-VERIFY-003 同时填写计划文件和测试案例文件时优先使用测试案例文件

前置条件：

- 存在计划文件 `docs/plans/2026-07-08-agent-team-verification-case-source.md`。
- 存在测试案例文件 `docs/testing/agent-team-verification-case-source-test-cases.md`，包含 `AGT-VERIFY-003`。

步骤：

1. 在 Agent Team 启动面板同时填写 `计划文件` 和 `测试案例文件`。
2. 启动 Agent Team。
3. 读取 run JSON 和 proposal / executing 面板。

期望：

- 系统使用测试案例文件拆分 acceptance。
- `verification.acceptanceSource` 为 `test_case_file`。
- `verification.planFilePath` 可以保留计划文件路径作为上下文。
- acceptance case ID 来自测试案例文件，包含 `AGT-VERIFY-003`。

失败判定：

- 有测试案例文件时仍改用计划文件生成 acceptance。
- 测试案例文件中的 case ID 未进入 acceptance。
- UI 或 run JSON 对来源显示互相矛盾。

证据：

- run JSON 的 `verification`、`acceptance` 片段。
- Agent Team 面板截图或 DOM 摘要。

### AGT-VERIFY-004 只有计划文件时主 Agent 生成 docs/testing 测试案例文件

前置条件：

- 存在计划文件 `docs/plans/2026-07-08-agent-team-verification-case-source.md`。
- 启动 run 时不填写测试案例文件。

步骤：

1. 启动 Agent Team run，任务描述说明“基于计划文件生成测试案例并拆分 worker”。
2. `计划文件` 填写 `docs/plans/2026-07-08-agent-team-verification-case-source.md`。
3. 观察主 Agent pane 的 prompt 或 run logs。
4. 等待主 Agent 调用 `$toolkit:write-test-cases` 并生成 `docs/testing/*-test-cases.md`。
5. 主 Agent 调用 `POST /api/agent-team/runs/:runId/propose-split`，payload 带 `generatedTestCaseFilePath` 和三类 worker。
6. 读取 run JSON。

期望：

- 生成文件位于 `docs/testing/` 且以 `-test-cases.md` 结尾。
- 生成文件中的每条可执行用例为 `### AGT-VERIFY-xxx 标题`，并包含 `步骤`、`期望`、`失败判定`。
- split payload 包含 `generatedTestCaseFilePath`。
- split payload 的 workers 包含且只包含本轮要求的三类角色：`code`、`code_review`、`behavior_verify`。
- run JSON 的 `verification.acceptanceSource` 为 `plan_file_generated`。

失败判定：

- 未生成测试案例文件就进入 worker split。
- 生成文件不在 `docs/testing/` 或不以 `-test-cases.md` 结尾。
- payload 未带 `generatedTestCaseFilePath`。
- workers 缺少 `code`、`code_review` 或 `behavior_verify` 任一角色。

证据：

- 生成的测试案例文件路径。
- 主 Agent pane prompt / 输出片段。
- `propose-split` 请求 payload 或后端响应。
- run JSON 的 `verification` 和 `workers` 片段。

### AGT-VERIFY-005 两个文件都为空时主 Agent 从任务描述生成测试案例文件

前置条件：

- 启动面板不填写 `计划文件` 和 `测试案例文件`。
- 任务描述足够明确，包含页面 / 行为 / 期望。

步骤：

1. 填写明确任务描述并启动 Agent Team。
2. 观察主 Agent pane 或 run logs。
3. 等待主 Agent 调用 `$toolkit:write-test-cases` 生成 `docs/testing/*-test-cases.md`。
4. 主 Agent 调用 `POST /api/agent-team/runs/:runId/propose-split`。
5. 读取 run JSON。

期望：

- 主 Agent 明确基于任务描述生成测试案例文件。
- 生成文件位于 `docs/testing/` 且以 `-test-cases.md` 结尾。
- run JSON 的 `verification.acceptanceSource` 为 `task_generated`。
- behavior acceptance 来自生成文件中的 case ID。
- 默认泛化 acceptance 不出现。

失败判定：

- 两个文件为空时直接进入默认泛化 acceptance。
- 没有生成文件或没有回填 `generatedTestCaseFilePath`。
- 来源错误显示为 `test_case_file` 或缺失。

证据：

- 主 Agent pane prompt / 输出片段。
- 生成文件路径。
- run JSON `verification` 和 `acceptance` 片段。

### AGT-VERIFY-006 生成文件无法解析时阻止 split 并提示缺少可追溯测试案例文件

前置条件：

- 准备一个项目内 Markdown 文件，位于 `docs/testing/invalid-agent-team-test-cases.md`。
- 文件不存在任何 `### AGT-VERIFY-001 标题` 形式的三级标题，或缺少可执行 case 内容。

步骤：

1. 让主 Agent 尝试以该文件作为 `generatedTestCaseFilePath` 调用 `propose-split`。
2. 读取 API 响应、run JSON 和 worker pane 状态。

期望：

- API 返回明确错误，错误信息包含“缺少可追溯测试案例文件”或等价说明。
- run 不进入 `executing`。
- 不创建 `behavior_verify` worker pane。
- run JSON 的 `acceptance` 不包含默认泛化用例。

失败判定：

- 不可解析文件仍能进入 worker split。
- 后端补出 `核心改动按任务目标落地` 或 `关键回归用例通过`。
- 错误信息无法定位测试案例文件不可解析。

证据：

- API 响应体。
- run JSON 片段。
- worker pane 列表或 Agent Team 面板截图。

### AGT-VERIFY-007 路径不存在时阻止启动或 split

前置条件：

- 当前项目内不存在 `docs/testing/not-exist-test-cases.md`。

步骤：

1. 在 `测试案例文件` 输入 `docs/testing/not-exist-test-cases.md`。
2. 填写任务描述并点击启动 Agent Team。
3. 如果从主 Agent 发起 split，则用同一路径作为 `generatedTestCaseFilePath` 调用 `propose-split`。
4. 读取 UI 错误或 API 响应。

期望：

- 启动或 split 被阻止。
- UI 或 API 错误包含不存在的路径。
- 不创建新的 worker pane。
- run 不进入 `executing`。

失败判定：

- 系统忽略不存在路径并进入 worker split。
- 错误只显示通用失败，无法定位路径。
- 仍生成默认 acceptance。

证据：

- UI 错误截图 / DOM，或 API 响应体。
- `.runweave/agent-team/<runId>.json` 的 `phase`、`workers`、`acceptance` 片段。

### AGT-VERIFY-008 项目外路径被阻止且不读取文件内容

前置条件：

- 准备一个项目外路径，例如 `/tmp/external-agent-team-test-cases.md`。
- 该文件即使存在，也不应被当前项目读取。

步骤：

1. 在 `测试案例文件` 输入项目外绝对路径。
2. 填写任务描述并启动 Agent Team。
3. 如果从主 Agent 发起 split，则用同一路径作为 `generatedTestCaseFilePath` 调用 `propose-split`。
4. 读取 UI 错误或 API 响应。

期望：

- 启动或 split 被阻止。
- 错误说明路径必须位于当前项目目录内。
- backend 不把项目外文件内容转换成 acceptance。

失败判定：

- 项目外文件被读取并生成 acceptance。
- UI 或 API 未提示项目目录边界。
- run JSON 记录项目外路径为 `testCaseFilePath` 或 `generatedTestCaseFilePath`。

证据：

- UI 错误截图 / DOM，或 API 响应体。
- run JSON 中未进入 executing 的片段。

### AGT-VERIFY-009 Proposal 和 Executing 面板展示 acceptance 来源与原始 case ID

前置条件：

- 使用 `docs/testing/agent-team-verification-case-source-test-cases.md` 或生成文件成功启动 Agent Team。
- run 已进入 proposal 或 executing。

步骤：

1. 使用 `$playwright-cli` 打开 Agent Team sidecar。
2. 查看 proposal / executing 面板中的 acceptance 区域。
3. 读取 `.runweave/agent-team/<runId>.json`。

期望：

- 面板展示来源，例如 `来源：测试案例文件 docs/testing/...` 或 `来源：计划文件生成 docs/testing/...`。
- 面板展示原始 case ID，例如 `AGT-VERIFY-001`。
- run JSON 的 `verification` 来源、文件路径与 UI 一致。
- acceptance 的 `sourceFilePath` 和 `sourceHeading` 可追溯到 Markdown 文件。

失败判定：

- UI 只显示 `case_1` / `case_2`，没有原始 case ID。
- UI 和 run JSON 对来源文件不一致。
- `sourceFilePath` 或 `sourceHeading` 缺失，无法追溯到文件。

证据：

- `$playwright-cli` 截图或 DOM 摘要。
- run JSON `verification` 和单条 acceptance 片段。

### AGT-VERIFY-010 behavior_verify prompt 包含来源、case ID、证据 schema 和 outbox 路径

前置条件：

- run 已按 `code -> code_review -> behavior_verify` 串行门禁推进到 `activeWorkerRole=behavior_verify`。
- behavior_verify worker pane 已收到 prompt。

步骤：

1. 捕获 behavior_verify pane prompt。
2. 读取 run JSON 的 `acceptance`。
3. 定位 pane-scoped outbox 路径。

期望：

- prompt 包含 acceptance 来源文件路径。
- prompt 列出每条原始 case ID。
- prompt 要求使用 `$playwright-cli` 对浏览器路径取证。
- prompt 要求把结果写入 pane-scoped outbox 的 `acceptanceResults`。
- prompt 说明 evidence schema：`type`、`label`、`summary`、`ref`、可选 `detail`。

失败判定：

- prompt 未说明来源文件。
- prompt 未列原始 case ID。
- prompt 未要求 `$playwright-cli` 或 pane-scoped outbox。
- `acceptanceResults` schema 缺失，导致结果不可折叠。

证据：

- tmux capture 或浏览器 pane 截图。
- pane-scoped outbox 路径片段。
- run JSON acceptance 片段。

### AGT-VERIFY-011 修复后只重跑失败、未执行、依赖或影响面 case

前置条件：

- 测试案例文件至少包含 4 个独立 case。
- 首轮 `behavior_verify` 已通过至少 1 个 case，在后续 case 失败并停止。
- code worker 完成修复并触发复验。

步骤：

1. 捕获 recheck prompt。
2. 让 `behavior_verify` 按 recheck prompt 执行。
3. 读取 behavior_verify outbox 和 run JSON。

期望：

- recheck prompt 明确列出上轮失败 case。
- recheck prompt 明确列出上轮未执行 case。
- 已通过且不受本轮 diff 影响的 case 被保留 pass 或标记 skipped，并带 `skipReason`。
- 如果本轮 diff 影响已通过 case，相关 case 被纳入补跑。
- 不出现无理由全量重跑。

失败判定：

- 修复后总是从第一条开始全量重跑且没有原因。
- 失败 case 未重跑。
- 未执行 case 被直接标记 pass。
- 跳过已通过 case 时没有 `skipReason` 或等价说明。

证据：

- recheck prompt 片段。
- behavior_verify outbox 中 `acceptanceResults`。
- run JSON acceptance 状态。

### AGT-VERIFY-012 真实 Runweave UI 闭环验证 code、code_review、behavior_verify 三类 worker

前置条件：

- 本计划实现已完成。
- 当前仓库或独立 worktree 可运行一个小而真实的可见页面变更需求。
- Runweave Web 和 backend 可用。

步骤：

1. 优先基于当前仓库创建独立 worktree；如不可用，记录原因并创建临时静态 HTML / Vite 项目。
2. 准备一个真实需求，例如修改 `docs/prototypes/*` 页面上的可见交互文案或状态展示。
3. 准备项目内测试案例文件，至少包含主路径、首轮失败后修复路径、已通过且修复后应跳过路径。
4. 用真实 Runweave Web 打开该项目 terminal。
5. 在 Agent Team UI 填写任务和测试案例文件路径。
6. 启动 Agent Team，等待真实 `code -> code_review -> behavior_verify` 流程。
7. 让 code worker 真实修改文件。
8. 让 code_review worker 真实审查。
9. 让 behavior_verify worker 使用 `$playwright-cli` 打开真实页面取证。
10. 如果首轮失败，修复后观察 recheck 范围。

期望：

- run JSON 显示 acceptance 来源为测试案例文件或生成文件。
- code、code_review、behavior_verify 三类 worker pane 均有真实 prompt 和输出。
- worktree 或临时项目产生真实 git diff。
- behavior_verify outbox 由 worker pane 产出，包含 `$playwright-cli` 截图、DOM、API 或命令证据。
- 修复后 recheck 不默认全量重跑；跳过已通过 case 时给出理由。
- Agent Team UI、run JSON、worker pane、outbox 和 git diff 能互相对应。

失败判定：

- 使用 mock worker、手写 outbox、伪造 completion 或直接调用 `/round` 代替真实闭环。
- code worker 没有真实修改文件。
- code_review worker 没有真实审查。
- behavior_verify 没有使用 `$playwright-cli` 验证真实页面。
- recheck 范围无理由全量重跑。

证据：

- worktree或临时项目路径、Runweave URL、`projectId`、`terminalSessionId`、`runId`。
- Agent Team UI 截图或 DOM。
- code / code_review / behavior_verify pane capture。
- git diff。
- pane-scoped outbox 和 `$playwright-cli` 证据。

## 验收通过标准

- `AGT-VERIFY-001` 到 `AGT-VERIFY-012` 全部通过，或对明确不适用项写出阻塞原因和替代路径。
- 所有浏览器路径均有 `$playwright-cli` 证据。
- `pnpm --filter ./packages/shared typecheck`、`pnpm --filter ./backend typecheck`、`pnpm --filter ./frontend typecheck`、`pnpm --filter ./frontend lint`、`git diff --check` 全部通过。
- run JSON、UI、worker prompt 对 acceptance 来源和原始 case ID 的表达一致。
- 缺少可追溯测试案例文件时必须阻断 worker split，不得回退到默认泛化 acceptance。
- 最终闭环不得使用 mock worker、手写 outbox、伪造 completion 或直接调用 `/round` 作为通过依据。
