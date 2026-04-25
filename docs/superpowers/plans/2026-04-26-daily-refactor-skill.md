# Codex 每日重构技能计划

**目标：** 在当前 Runweave 仓库内新增一个 repo-local Codex skill，用于每日固定时间触发后，分析 base branch 上次已分析位置到当前位置之间的提交，输出重构候选、风险、收益和验证建议。默认不改代码、不提交 PR；只有人工显式确认某个候选并进入执行模式时，才按该候选重构、验证、commit、push 并创建 GitHub PR。

**核心原则：** skill 只定义 Codex 被触发后的执行流程；“每天固定时间”必须由外部调度器触发，例如 GitHub Actions scheduled workflow、本机 cron/launchd、或团队已有的自动化平台。skill 本身不能独立定时运行。

---

## 当前项目约束

- 项目名是 Runweave，前端是 React + Vite，后端是 Express + WebSocket + Playwright 控制，Electron 客户端在 `electron/`。
- 前端 `src/` 不新增 Vitest/单测文件；前端正式自动化验证只使用 Playwright E2E。
- 变更必须局部、可解释、可回滚，不做“顺手优化”。
- 重构不得改变已有功能、路由、协议、交互和视觉结果，除非 PR 描述明确列出并解释。
- 默认不做 Windows 打包验证；Electron 打包只考虑本地 mac 客户端。

## 技能位置

计划新增：

```text
.agents/skills/daily-refactor/
└── SKILL.md
```

可选后续文件：

```text
.agents/skills/daily-refactor/
├── SKILL.md
├── scripts/
│   ├── collect-commit-window.mjs
│   ├── file-size-report.mjs
│   └── map-verification.mjs
└── references/
    ├── verification-matrix.md
    └── refactor-heuristics.md
```

第一版优先只写 `SKILL.md`。只有当命令重复且容易出错时，再把提交窗口收集、文件行数统计、验证映射沉到脚本里。

当前仓库同时存在根级 `skills/` 和 `.agents/skills/`。本计划采用 `.agents/skills/daily-refactor/SKILL.md` 作为 Codex repo-local skill 的发现路径；根级 `skills/` 不作为第一版目标，除非后续补充明确的安装/加载机制和验证命令。

## 触发方式

### 人工触发

用户可以对 Codex 说：

```text
使用 daily-refactor skill，分析最近提交并输出重构候选报告。
```

执行模式需要显式授权：

```text
使用 daily-refactor skill，基于候选 X 执行重构、验证并创建 PR。
```

### 定时触发

定时不写进 skill 执行体，另建一个外部入口触发 Codex：

- GitHub Actions: `schedule` 在固定时间运行，调用 Codex/自动化入口。
- 本机 launchd/cron: 在固定时间进入仓库，拉取指定 base branch，再触发 Codex。
- 现有 agent 平台: 固定时间发起同样的自然语言任务。

定时任务必须显式传入：

- 仓库路径。
- `base_branch`，默认 `main`。
- 分析范围，默认 `last_analyzed_sha..current_base_sha`。
- 运行模式，默认 `report-only`。
- 是否允许改代码、push 和创建 GitHub PR；默认不允许，且必须绑定人工确认过的候选 ID。

## 提交窗口定义

默认窗口使用 Git SHA range，而不是 wall-clock 时间：

```bash
base_branch="${BASE_BRANCH:-main}"
git fetch origin "$base_branch"
current_base_sha="$(git rev-parse "origin/$base_branch")"
last_analyzed_sha="<read from scheduler state>"
git log --oneline --decorate "$last_analyzed_sha..$current_base_sha"
git diff --name-only "$last_analyzed_sha..$current_base_sha"
```

`base_branch` 是分析和执行的单一事实来源。候选记录必须保存 `base_branch`；执行模式创建分支、验证 range、创建 PR 时的 target branch 都必须等于候选记录里的 `base_branch`，不能重新默认成 `main`。

状态来源固定为 GitHub Issue：

- `open_candidates` 和 `analysis_cursor` 的 source of truth 是一个固定 GitHub Issue 中的固定 comment。
- GitHub Actions artifact 只保存本次运行的临时报告、日志和截图链接，不保存候选状态，不作为执行模式输入。
- 不使用 gist、调度平台私有记录、本机 state file 或 Actions cache 作为候选状态来源；它们最多只能作为本地调试缓存。
- 没有固定 issue/comment 时，定时任务只能运行一次性 report-only，不推进 `analysis_cursor`，也不允许进入 execute。
- 没有 `analysis_cursor` 时才 fallback 到“昨天 00:00 到当前时间”的时间窗口，并在报告里标记为不完全幂等；fallback 产生的候选也必须写入固定 issue comment 后才能被批准执行。

状态更新规则：

- 状态必须拆成两类：`analysis_cursor` 和 `open_candidates`。
- `analysis_cursor.last_analyzed_sha` 只表示 base branch 已完成扫描到哪里，不表示候选已经处理完。
- `report-only` 模式：报告成功产出后可以把 `analysis_cursor.last_analyzed_sha` 更新为 `current_base_sha`，但必须同时持久化本次新增或更新的 `open_candidates`。
- `open_candidates` 中的每个候选必须有稳定 ID、`base_branch`、range、touched files、判断原因、验证建议、状态和报告链接。
- 候选状态至少包含：`open`、`approved`、`rejected`、`pr_opened`、`closed`。
- 候选只有在人工 reject、对应 PR 关闭/合并、或新分析证明候选已失效时，才能从 `open_candidates` 移除或标记关闭。
- `execute` 模式必须按候选 ID 读取 `open_candidates`，不能只依赖当前 `last_analyzed_sha..current_base_sha` 重新推导。
- 同一个 `current_base_sha` 重跑时应复用或更新同一批候选 ID，不创建重复候选或重复 PR。

固定 comment 建议保存一个 fenced JSON 块，外层人类可读摘要只做展示；Codex/Action 只读写 JSON 块。更新 comment 必须先读当前内容，基于候选 ID 做 merge，避免覆盖人工状态变更。

不要默认使用 `--no-merges`。如果 base branch 存在 merge commit，range diff 仍要覆盖 merge 引入的 touched files，避免漏掉非 squash 合并。

需要收集：

- commit 列表、作者、时间、标题。
- 每个 commit 的 touched files。
- touched code files 的当前行数。
- touched files 所属模块：frontend、backend、electron、packages/shared、scripts、docs。
- 是否触达路由、协议、WebSocket、认证、终端、Electron runtime、构建配置等高风险区域。

## 重构候选判定规则

### 强制进入候选分析

满足任一条件时必须进入候选分析，但不等于自动改代码：

- 被本次提交触达的代码文件超过 600 行。
- 本次提交使某个代码文件从不超过 600 行变成超过 600 行。
- 同一文件同时承担 UI、数据请求、状态管理、协议转换、持久化等多个职责。
- 公共逻辑在 3 个及以上位置重复，且重复不是刻意的业务差异。
- 模块修改后只能靠人工记忆理解调用链，缺少清晰边界或命名。

### 谨慎建议

满足以下条件时只建议重构，必须先评估收益/风险：

- 文件接近 600 行但拆分会引入更多跨文件跳转。
- 重复逻辑只有 2 处，且近期可能继续分化。
- 公共抽取会穿透 frontend/backend/electron 边界。
- 协议、认证、终端 runtime、Electron 打包链路受到影响。

### 禁止自动执行

以下情况不自动改代码，只在报告里说明：

- 只能通过大范围重写才能完成。
- 没有足够验证手段覆盖受影响功能。
- 重构需要改变公开协议、持久化数据结构或用户交互。
- 当前工作区存在与重构冲突的未提交用户改动。

## 执行流程

### 默认模式：report-only

1. 准备工作区。
   - 检查 `git status --short`。
   - 不创建分支，不修改文件，不运行 formatter。
   - 如果有未提交改动，在报告里说明，分析仍可继续，但不能进入执行模式。

2. 收集 SHA range。
   - 读取 `last_analyzed_sha`。
   - 解析 `current_base_sha`。
   - 生成 commit 列表和 touched files。
   - 如果 state 缺失，使用时间窗口 fallback 并明确标记。

3. 生成重构候选报告。
   - 标记超过 600 行的 touched code files。
   - 标记复杂模块、重复公共逻辑、高风险边界。
   - 对每个候选给出收益、风险、预计改动范围、验证建议。
   - 明确推荐：`do now`、`defer`、`do not refactor`。

4. 输出结果。
   - 没有候选时只输出“无建议重构”报告。
   - 有候选时不自动提交 PR，只等待人工选择候选。
   - 报告成功后由调度器更新 `analysis_cursor.last_analyzed_sha`，同时持久化 `open_candidates`。

### 显式模式：execute

1. 准备工作区。
   - 检查 `git status --short`。
   - 必须由用户明确指定候选项，或由调度器传入已人工批准的候选 ID。
   - 如果有非本次任务产生的未提交改动，不覆盖、不回滚；必要时停止并报告。
   - 从候选记录里的 `origin/$base_branch` 创建分支：`codex/daily-refactor-YYYYMMDD`。
   - 创建 PR 时 target branch 必须等于候选记录里的 `base_branch`。

2. 分析提交与模块。
   - 按候选 ID 从 `open_candidates` 读取原始 SHA range、touched files、判断原因和验证建议。
   - 如果候选记录缺失或状态不是 `approved`，停止执行，不从当前时间窗口重新猜测。
   - 生成 touched files 和文件行数报告。
   - 标记超过 600 行的文件和复杂模块。
   - 确认本次只执行一个候选切片。

3. 选择最小可验证切片。
   - 每次 PR 只处理一个清晰主题，例如“拆分终端 workspace 文件”或“抽取连接认证公共逻辑”。
   - 如果候选过多，优先处理超过 600 行且验证路径明确的文件。
   - 不把多个无关模块塞进同一个 PR。

4. 重构实现。
   - 保持外部行为不变。
   - 优先移动/拆分现有代码，再做小范围命名修正。
   - 不引入新框架或新抽象层。
   - 删除由本次重构制造的无用 imports、变量和中间文件。

5. 验证。
   - 先跑静态门禁，再跑受影响模块的 E2E/截图/手工 smoke。
   - 如果验证无法覆盖，回退本次重构或停止并报告风险。

6. 提交与 PR。
   - commit message 使用 `refactor: ...`。
   - push 分支到 GitHub remote。
   - 用 `gh pr create` 创建 PR。
   - PR 描述必须包含：触发提交窗口、重构原因、超过 600 行文件处理情况、验证命令、截图路径或 E2E 结果。

## 验证机制

### 质量体系入口

验证选择不在本 skill 里维护第二套映射规则，统一复用仓库已有质量体系：

- 命令选择说明以 `docs/testing/command-matrix.md` 为准。
- 影响面测试选择以 `scripts/quality-gate.mjs` 为准。
- `pnpm quality:gate` 只负责按 changed files 选择 default/e2e/live 测试层，不替代 PR/CI 门禁。
- `execute` 模式创建 PR 前必须运行 `pnpm lint` 和 `pnpm typecheck`。
- 默认还要运行 `pnpm quality:gate`，用于选择受影响测试。
- 如果改动触达构建、打包、静态资源或发布链路，补跑 `pnpm build`。
- 如果改动触达 backend、packages/shared、质量脚本、测试门禁或 CI quality job 对应范围，补跑 `pnpm coverage`，与 CI 的 coverage gate 对齐。
- 如果 `quality:gate` 根据 changed files 选择为 minimal，PR 描述必须说明原因，并至少保留 `git diff --check`、`pnpm lint`、`pnpm typecheck` 作为基础校验。
- 如果重构触达高风险路径但 `quality:gate` 没有覆盖到，补充命令必须从 `docs/testing/command-matrix.md` 选择，并在 PR 描述中说明原因。

推荐基础命令：

```bash
pnpm lint
pnpm typecheck
pnpm quality:gate
```

只做 report-only 或计划文档变更时：

```bash
git diff --check
```

不要把 `docs/testing/command-matrix.md` 的内容复制进 skill。后续如果质量体系调整，只更新仓库质量文档和 `scripts/quality-gate.mjs`。

### 截图基线

UI 重构必须在改动前后保存截图：

默认存放位置按优先级选择：

- CI artifact：适合定时 report-only 或 PR 验证产物。
- PR 附件 / PR comment 链接：适合 reviewer 对比。
- 本地临时目录：适合人工执行前后对照，例如 `/tmp/runweave-daily-refactor/<candidate-id>/before` 和 `/tmp/runweave-daily-refactor/<candidate-id>/after`。

不要把日常验证截图默认写入 `docs/superpowers/plans/assets/`。只有长期设计说明图、稳定架构草图、需要随文档维护的图片，才允许进入 `docs/superpowers/plans/assets/`。

截图要求：

- desktop viewport 至少 1 张。
- mobile viewport 仅在触达移动布局时需要。
- 终端、预览、连接管理等核心页面必须覆盖主要状态。
- after 截图应和 before 对照，若有差异必须在 PR 描述中解释。
- PR 描述只记录 artifact/附件/临时路径引用，不把一次性截图纳入 git diff。

## SKILL.md 结构

`.agents/skills/daily-refactor/SKILL.md` 应保持精简，建议结构：

```markdown
---
name: daily-refactor
description: Use when Codex should analyze recent Runweave commits for refactor candidates, especially files over 600 lines or complex shared logic; default to report-only, and only refactor, verify, push, or create a GitHub PR after a human explicitly approves a candidate.
---

# Daily Refactor

## Scope

## Hard Rules

## Commit Window

## Refactor Criteria

## Report-Only Workflow

## Execute Workflow

## Quality Gate

## PR Workflow

## Stop Conditions
```

`SKILL.md` 必须写清楚：

- 文件超过 600 行是进入候选分析的硬门槛。
- 定时触发默认是 report-only。
- 改代码、push、创建 PR 必须基于人工确认过的候选。
- 前端不新增 Vitest/单测，只使用 E2E 和截图做 UI 回归。
- 没有足够验证手段时不自动重构。
- 每个 PR 只做一个最小可验证切片。
- PR 创建前必须运行 `pnpm lint`、`pnpm typecheck` 和 `pnpm quality:gate`；如跳过 `build/coverage`，需要说明原因。

## PR 模板

PR 描述建议固定为：

```markdown
## Trigger Window

- Base branch:
- Last analyzed SHA:
- Current base SHA:
- Fallback time window, if state was missing:
- Commits analyzed:

## Why Refactor

- Files over 600 lines:
- Complexity/reuse issue:
- Scope chosen:

## Changes

- ...

## Verification

- [ ] pnpm lint
- [ ] pnpm typecheck
- [ ] pnpm quality:gate
- [ ] pnpm build, if build/package/static asset paths changed
- [ ] pnpm coverage, if backend/shared/quality gate/CI quality scope changed
- [ ] supplemental commands from docs/testing/command-matrix.md, if needed
- [ ] screenshots artifact/link/temp path, if UI changed
- Quality gate selection reason:
- Build skipped reason, if skipped:
- Coverage skipped reason, if skipped:

## Regression Notes

- Behavior changes: none / listed below
- Screenshot artifact/link/temp path:
- Residual risk:
```

## 验收标准

- 仓库中存在 `.agents/skills/daily-refactor/SKILL.md`。
- skill 被触发后能按 `last_analyzed_sha..current_base_sha` 收集 commits 和 touched files，并输出候选重构清单。
- 分析状态拆成 `analysis_cursor` 和 `open_candidates`，并存放在固定 GitHub Issue comment 的 fenced JSON 块中。
- Actions artifact 只保存临时报告、日志和截图链接，不作为候选状态或执行输入。
- 没有固定 issue/comment 时只能 report-only，不能推进游标，也不能执行候选。
- 每个候选有稳定 ID、`base_branch`、原始 SHA range、touched files、判断原因、验证建议、状态和报告链接。
- 执行模式只能读取已批准的候选 ID；候选记录缺失时停止，不从新 range 重新猜测。
- 超过 600 行的 touched code files 会被强制纳入候选分析。
- 定时触发默认只产出报告，不改代码、不创建 PR。
- 只有人工确认后的显式执行模式才允许修改代码、commit、push、创建 GitHub PR。
- 重构前明确验证路径；没有验证路径时停止。
- UI 重构有 before/after 截图或等价 E2E 证据。
- 前端不新增 `src/**/*.test.ts`、`src/**/*.test.tsx`、`src/**/*.spec.tsx`。
- 如果没有值得重构的候选，只输出报告，不创建空 PR。

## 实施顺序

1. 先确定固定 GitHub Issue/comment 位置和 fenced JSON schema。
2. 新增 `.agents/skills/daily-refactor/SKILL.md`，只写核心流程和硬规则。
3. 手工用最近提交跑一次 report-only dry run，只分析不改代码，确认候选清单质量。
4. 实现 `analysis_cursor` 读取/更新规则、`open_candidates` merge 规则和候选生命周期。
5. 确认候选 ID 生成规则，保证同一 SHA range 重跑不会制造重复候选。
6. 针对一个低风险候选，在人工确认后执行完整闭环：重构、验证、commit、PR。
7. 如果 dry run 中命令重复且稳定，再补 `scripts/collect-commit-window.mjs` 和 `scripts/file-size-report.mjs`。
8. 最后再接入外部定时触发；不要在 skill 本体里混入调度实现。
