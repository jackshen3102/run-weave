# Agent Team 复盘基础设施加固计划

## 背景

基于终端 `e9d9da4e` 的真实 Agent Team 流程复盘，本轮流程最终成功，但暴露出 4 类高收益改进点：

1. 复盘需要人工拼接 run package、pane-scoped outbox、tmux history 和审查报告。
2. worker outbox 能表达 pass/fail，但不能稳定区分“发现过的问题”“已修复的问题”“仍残留的问题”。
3. Behavior Verify 构造 App Server ThreadRef 验收数据时需要临场手写事件 payload，容易踩 schema。
4. 多 pane/session 下容易把 run-bound panel、空闲 panel、既有脏改动混在一起。

本计划只加固 Agent Team 运行与复盘基础设施，不继续扩展 `状态查询` 业务功能。

## 当前代码事实

- Agent Team run 存在于 `.runweave/agent-team/<runId>.json`，数据模型定义在 `packages/shared/src/agent-team.ts`。
- Agent Team backend 路由位于 `backend/src/routes/agent-team.ts`，目前已有：
  - `GET /api/agent-team/runs`
  - `GET /api/agent-team/runs/:runId`
  - `POST /api/agent-team/runs/:runId/round`
  - `POST /api/agent-team/runs/:runId/focus-pane`
- Agent Team service 位于 `backend/src/agent-team/service.ts`，内部已经持有：
  - `terminalSessionManager`
  - `tmuxService`
  - `AgentTeamPaths`
  - `AgentTeamOutboxResolver`
- pane-scoped outbox 路径由 `backend/src/agent-team/storage/agent-team-paths.ts` 生成：
  - `.runweave/outbox/<sessionId>.panel-<panelId>.json`
  - `.runweave/outbox/<sessionId>.pane-<tmuxPaneId>.json`
  - legacy `.runweave/outbox/<sessionId>.json`
- outbox 读取和规范化集中在 `backend/src/agent-team/outbox-resolver.ts`，当前会按 `outboxPath -> panel outbox -> tmux pane outbox -> legacy session outbox` 解析。
- terminal panel history 已有 backend 能力：
  - `GET /api/terminal/session/:id/panels/:panelId/history`
  - `rw terminal history <terminalSessionId> --panel <panel|role>`
- CLI 当前只有 `app`、`app-server`、`auth`、`project`、`terminal` 命令组，没有 `agent-team` 命令组。
- App Server ThreadRef 验证逻辑主要在 `scripts/verify-app-server-state-sync.mjs`，其中已有合法 `source.app = "hook"`、`hookEvent()`、`completionEvent()`、`postEvent()` 等可复用模式。

## 目标

做 3 个优先级最高、能直接降低后续 Agent Team 成本的能力：

1. **Agent Team Export**：一条命令导出 run、run-bound panels、panel histories、outboxes 和合并验收结果。
2. **Outbox 状态表达加固**：让 review/verify outbox 能稳定表达 remaining/resolved findings，避免“已修复问题仍像残留风险”的歧义。
3. **App Server ThreadRef Fixture Helper**：给 behavior_verify 提供可复用验收数据构造脚本，避免临场手写事件 JSON。

## 非目标

- 不重做 Agent Team 编排状态机。
- 不改 `状态查询` UI 的业务能力。
- 不新增单元测试文件。本仓库仍使用 typecheck、lint、repo-local 脚本、Playwright E2E 和实际行为核对。
- 不默认导出完整敏感历史。history 默认只导出 tail，完整导出必须显式开启。
- 不把 legacy `.runweave/outbox/<sessionId>.json` 删除；只降低新流程对它的依赖。

## 方案选择

### 方案 A：Backend Export API + CLI + Fixture + Outbox Schema（推荐）

在 backend 增加 `GET /api/agent-team/runs/:runId/export`，CLI 增加 `rw agent-team export`，同时扩展 outbox schema 和 App Server fixture helper。

优点：

- backend 已有 run、panel、tmux、outbox 归属上下文，能最准地区分 run-bound panels 与空闲 panes。
- CLI/浏览器/后续 UI 都能复用同一个 export API。
- 能把 outbox schema、history 导出、fixture 验证形成闭环。

代价：

- 需要改 backend、shared、CLI、scripts、docs 多处。
- 需要认真处理 history tail、鉴权和敏感信息边界。

### 方案 B：CLI-only 本地导出

只在 CLI 里组合现有 `/api/agent-team/runs/:runId`、`/api/terminal/.../history` 和本地 `.runweave/outbox` 文件。

优点：

- 改动少，能快速解决个人复盘。

缺点：

- CLI 需要自行猜项目 root/outbox 路径，容易再次出现 profile/auth/path 偏差。
- 后续 UI 不能复用。
- 对 plan_review 这类非最终 workers 的归属恢复仍不够稳。

### 方案 C：先做 UI 复盘面板

在 Agent Team 侧边栏增加“导出/复盘”页面。

优点：

- 用户可见。

缺点：

- 依赖底层 export 和 schema 先稳定；现在直接做 UI 会把现有不确定性搬到前端。

推荐采用 **方案 A**。执行时按“先 API/CLI 导出，再 schema，再 fixture”的顺序推进。

## 数据结构设计

### Agent Team Export Response

在 `packages/shared/src/agent-team.ts` 增加：

```ts
export interface AgentTeamExportResponse {
  run: AgentTeamRun;
  generatedAt: string;
  projectRoot: string | null;
  panels: {
    runBound: AgentTeamExportPanel[];
    sessionOther: AgentTeamExportPanel[];
  };
  outboxes: AgentTeamExportOutbox[];
  acceptanceSummary: AgentTeamExportAcceptanceSummary[];
  warnings: string[];
}

export interface AgentTeamExportPanel {
  panelId: string;
  tmuxPaneId: string | null;
  alias: string | null;
  role: string | null;
  workerRole: AgentTeamWorkerRole | "main" | "unknown";
  workerId: string | null;
  source: "main" | "worker" | "session-other";
  history?: {
    mode: "tail" | "full" | "unavailable";
    tailLines: number | null;
    scrollback: string | null;
    error?: string;
  };
}

export interface AgentTeamExportOutbox {
  path: string;
  exists: boolean;
  scope: "panel" | "tmux-pane" | "legacy-session";
  panelId: string | null;
  tmuxPaneId: string | null;
  outbox: AgentTeamWorkerOutbox | null;
  error?: string;
}

export interface AgentTeamExportAcceptanceSummary {
  caseId: string;
  status: AgentTeamAcceptanceStatus;
  evidenceCount: number;
  sourceRoles: string[];
  remainingFindingCount: number;
  resolvedFindingCount: number;
}
```

### Outbox Finding 状态

扩展 `AgentTeamWorkerOutbox`，新增可选字段，保持向后兼容：

```ts
export type AgentTeamFindingStatus = "open" | "resolved" | "informational";

export interface AgentTeamOutboxFinding {
  severity: "P0" | "P1" | "P2" | "P3";
  status?: AgentTeamFindingStatus;
  title: string;
  summary: string;
  ref?: string;
}

export interface AgentTeamWorkerOutbox {
  schemaVersion?: 1;
  findings?: AgentTeamOutboxFinding[];
  resolvedFindings?: AgentTeamOutboxFinding[];
  remainingFindings?: AgentTeamOutboxFinding[];
  recommendations?: Array<{
    severity?: "P0" | "P1" | "P2" | "P3";
    summary: string;
  }>;
}
```

规则：

- `remainingFindings` 是 gate 判断的主来源。
- `resolvedFindings` 只做复盘展示，不阻断。
- 旧 outbox 只有 `findings` 时，backend 兼容读取；没有 `status` 的 P0/P1 默认按 open 处理。
- `summary` 不能再写“仅发现 P2”但报告里又写“已修复”。这类情况必须写入 `resolvedFindings` 或 `remainingFindings` 之一。

## 任务拆分

### 任务 1：Shared 类型与 outbox 规范

修改文件：

- `packages/shared/src/agent-team.ts`
- `backend/src/agent-team/outbox-resolver.ts`
- `backend/src/agent-team/prompt-builders.ts`
- `backend/src/agent-team/service.ts`

实施要求：

1. 增加 Agent Team export DTO。
2. 扩展 `AgentTeamWorkerOutbox` 的 finding/recommendation 字段。
3. `AgentTeamOutboxResolver.normalizeOutbox()` 兼容旧 outbox，并规范化 `findings`、`resolvedFindings`、`remainingFindings`。
4. `summarizeBlockingReviewFindings()` 改为优先看 `remainingFindings`，只把 open P0/P1 当阻断。
5. worker prompt 中明确：
   - 已修复问题写 `resolvedFindings`
   - 仍存在问题写 `remainingFindings`
   - `acceptanceResults[].status=pass` 时不能在 `summary` 里留下未修复 P0/P1 暗示。

验证：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
```

验收标准：

- 旧 outbox 仍可被读取。
- P0/P1 open remaining finding 会阻断 gate。
- P2 resolved finding 不阻断 gate，也不会污染 acceptance summary。

### 任务 2：Backend Agent Team Export API

修改文件：

- `backend/src/agent-team/service.ts`
- `backend/src/routes/agent-team.ts`
- `packages/shared/src/agent-team.ts`

新增接口：

```text
GET /api/agent-team/runs/:runId/export?history=tail&tail=5000
```

query 规则：

- `history=none|tail|full`，默认 `tail`。
- `tail` 默认 `1000`，最大 `5000`。
- `includeSessionOther=true|false`，默认 `true`。
- `includeOutboxes=true|false`，默认 `true`。

导出规则：

1. `runBound` 必须包含：
   - main panel
   - `run.workers[].panelId` 对应 panels
   - plan_review 阶段产生但最终不在执行 workers 中的 panel，如果能从 outbox 或 panel role `agent-team:<runId>:plan_review` 恢复，也必须纳入。
2. `sessionOther` 只放同一 terminal session 下但不属于该 run 的 panels。
3. panel history 通过 `tmuxService.capturePane()` 获取；没有 tmux 或 pane 不存在时写 `history.mode="unavailable"`。
4. outbox 路径按 `AgentTeamPaths.workerOutboxPath()` 与 legacy path 枚举，不扫描项目任意 JSON。
5. response 不返回 token、env、App Server lock path。

验证：

```bash
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
curl -sS -H "Authorization: Bearer <token>" \
  "http://localhost:<backendPort>/api/agent-team/runs/<runId>/export?history=tail&tail=200" \
  | jq '.run.runId, (.panels.runBound | length), (.outboxes | length)'
```

验收标准：

- 对 `e9d9da4e` 这类 run，导出结果能区分：
  - main panel
  - plan_review panel
  - code panel
  - code_review panel
  - behavior_verify panel
  - unrelated idle panel
- 默认 history 只含 tail，不是无限 scrollback。
- outbox 缺失时返回 warning，不抛 500。

### 任务 3：CLI `rw agent-team export`

修改文件：

- `packages/runweave-cli/src/index.ts`
- `packages/runweave-cli/src/commands/agent-team.ts`（新增）
- `packages/runweave-cli/src/client/terminal-http-client.ts` 或新增 `agent-team-http-client.ts`
- `docs/cli/terminal-cli.md` 或新增 `docs/cli/agent-team-cli.md`

命令设计：

```bash
rw agent-team export <runId> --tail 1000 --json
rw agent-team export <runId> --history none --json
rw agent-team export --project-id <projectId> --terminal-session-id <terminalSessionId> --tail 1000 --json
rw agent-team export <runId> --plain
```

输出规则：

- `--json` 输出完整 `AgentTeamExportResponse`。
- `--plain` 输出复盘摘要：
  - run 状态
  - panels 列表
  - acceptance summary
  - remaining/resolved findings
  - warnings
- 如果指定 terminalSessionId，需要先调用现有 `GET /api/agent-team/runs?projectId=&terminalSessionId=` 找 run；多 run 时要求用户显式给 runId。

验证：

```bash
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm cli:build
node packages/runweave-cli/dist/index.js agent-team export <runId> --history none --json
```

验收标准：

- `rw agent-team export` 不需要用户手动找 `.runweave/agent-team/*.json`。
- Unauthorized 时给出明确 profile/backend-port/token 提示，不静默回退到错误 backend。
- `--plain` 能直接作为复盘输入文本。

### 任务 4：App Server ThreadRef Fixture Helper

修改文件：

- `scripts/lib/app-server-threadref-fixture.mjs`（新增）
- `scripts/seed-app-server-threadref-fixture.mjs`（新增）
- `scripts/verify-app-server-state-sync.mjs`
- `package.json`
- `docs/testing/app-server-state-sync-test-cases.md` 或新增 runbook

脚本命令：

```bash
pnpm app-server:seed-threadref-fixture \
  --project-id <projectId> \
  --terminal-session-id <terminalSessionId> \
  --terminal-panel-id <panelId> \
  --run-id <runId> \
  --prefix status-lookup-recheck \
  --statuses running,starting \
  --print-json
```

输出：

```json
{
  "projectId": "...",
  "terminalSessionId": "...",
  "threads": [
    {
      "threadId": "...",
      "status": "running",
      "eventIds": [1, 2]
    }
  ]
}
```

实现要求：

1. 复用 `scripts/verify-app-server-state-sync.mjs` 中合法事件形状，抽出 builder，不复制粘贴。
2. `source.app` 必须来自 shared 枚举，默认使用 `"hook"`。
3. 脚本写完事件后必须读取 `/threads` 或 `/threads/:threadId` 自校验。
4. 支持 `RUNWEAVE_APP_SERVER_HOME`，避免误写用户默认 App Server 数据。
5. 默认生成唯一 threadId，避免污染现有验收数据。

验证：

```bash
pnpm app-server:verify-state-sync
RUNWEAVE_APP_SERVER_HOME="$(mktemp -d)" pnpm app-server:seed-threadref-fixture \
  --project-id fixture-project \
  --terminal-session-id fixture-terminal \
  --terminal-panel-id fixture-panel \
  --run-id fixture-run \
  --statuses running,starting \
  --print-json
```

验收标准：

- behavior_verify 不再需要手写 App Server event JSON。
- invalid `source.app` 这类 schema 错误在脚本内部不可发生。
- 输出里的 thread 可被 `/api/app-server/threads` 或 App Server `/threads` 查到。

### 任务 5：运行开始时记录 scope snapshot

修改文件：

- `packages/shared/src/agent-team.ts`
- `backend/src/agent-team/service.ts`
- `frontend/src/components/terminal/terminal-agent-team-panel-model.ts`
- `frontend/src/components/terminal/terminal-agent-team-panel-sections.tsx`

新增可选字段：

```ts
export interface AgentTeamRun {
  scopeSnapshot?: {
    capturedAt: string;
    gitStatusShort: string[];
    allowedPaths?: string[];
  };
}
```

规则：

- start run 时记录 `git status --short`，失败则写 warning，不阻断 run。
- 如果 planFile 存在，allowedPaths 可以先为空；后续由 plan 或用户显式补充。
- review/export 展示“本轮前已有改动”和“本轮涉及文件”，降低脏改动误判。

验证：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter ./frontend typecheck
```

验收标准：

- run package 中能看到 start 时的 dirty snapshot。
- code/review worker prompt 或 export summary 能提示既有脏改动。
- snapshot 失败不导致 Agent Team 无法启动。

## 推荐执行顺序

1. 先做任务 1 和任务 2：解决 outbox 表达与 export API。
2. 再做任务 3：让复盘入口变成稳定 CLI。
3. 再做任务 4：减少 behavior_verify 的临场造数错误。
4. 最后做任务 5：补齐 dirty worktree 与 scope 可观测性。

原因：

- 没有 export API，后续复盘仍要人工拼接。
- 没有 outbox 状态表达，export 也只能导出含糊结论。
- fixture helper 独立收益高，但依赖 export/outbox 后，验证闭环更清楚。
- dirty snapshot 是长期质量项，风险低但优先级低于前 3 个能力。

## 端到端验收场景

### 场景 1：复盘导出 `e9d9da4e` 类似 run

步骤：

1. 准备一个已完成的 Agent Team run，包含 main、plan_review、code、code_review、behavior_verify 和一个无关 idle pane。
2. 执行：

```bash
rw agent-team export <runId> --tail 200 --json > /tmp/agent-team-export.json
```

预期：

- `.run.runId` 等于目标 run。
- `.panels.runBound` 包含 main/plan_review/code/code_review/behavior_verify。
- `.panels.sessionOther` 包含 idle pane。
- `.outboxes` 包含 pane-scoped outbox，并标出缺失 warning。
- `.acceptanceSummary` 能显示 pass/fail、evidenceCount、resolved/remaining finding 数量。

### 场景 2：Review 已修复风险不会污染 Gate

步骤：

1. 构造 code_review outbox：
   - `acceptanceResults[0].status = "pass"`
   - `resolvedFindings` 包含 P2
   - `remainingFindings` 为空
2. 让 backend resolver 读取该 outbox。

预期：

- gate 不阻断。
- export summary 显示 resolved finding。
- summary 不把 resolved finding 计入 remaining finding。

### 场景 3：ThreadRef fixture 支撑 behavior_verify

步骤：

1. 启动本地 App Server。
2. 执行 `pnpm app-server:seed-threadref-fixture ... --statuses running,starting --print-json`。
3. 打开 Web 页面，用 `状态查询` 查 terminalSessionId。

预期：

- UI 命中两条候选。
- running 默认排在 starting 前。
- Thread ID 命中和 404 分支可继续按 Playwright 验收。

## 验证命令总表

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/backend lint
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/cli lint
pnpm --filter ./frontend typecheck
pnpm cli:build
pnpm app-server:verify-state-sync
git diff --check -- backend frontend packages/shared packages/runweave-cli scripts docs package.json
```

如果改动触达浏览器 UI，再补：

```bash
playwright-cli open http://localhost:5173/
playwright-cli snapshot
```

## 风险与回滚

- Export history 可能包含敏感内容：默认 tail，full 必须显式开启；后续如要上传飞书或外部系统，应先做脱敏。
- CLI 新增命令组会影响 usage 文案：需要保持旧命令不变。
- Outbox schema 扩展必须保持可选字段，避免旧 worker outbox 失效。
- Fixture helper 可能写入默认 App Server home：脚本必须支持并文档化 `RUNWEAVE_APP_SERVER_HOME`，验证中优先使用临时 home。

## 完成定义

满足以下条件才算完成：

1. `rw agent-team export` 能直接导出一次完成 run 的完整复盘材料。
2. Export 结果能区分 run-bound panel 和 session-other panel。
3. Outbox 能区分 open/resolved/informational findings，P0/P1 gate 只看 open remaining findings。
4. Behavior Verify 可用 fixture helper 构造 ThreadRef 验收数据，不再手写事件 JSON。
5. 上述验证命令全部通过；若未执行 Playwright，需要明确说明原因，因为本计划的核心能力主要是 backend/CLI/script，不默认触达浏览器 UI。
