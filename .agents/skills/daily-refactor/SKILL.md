---
name: daily-refactor
description: 当 Codex 需要分析 Runweave 最近提交并产出重构候选时使用，尤其关注超过 600 行的文件或复杂公共逻辑；默认只生成报告，只有人工明确批准某个候选后，才允许重构、验证、push 或创建 GitHub PR。
---

# 每日重构

## 适用范围

仅在 Runweave 仓库内使用这个 skill。

这个 skill 有两种模式：

- `report-only`：分析 base branch 的近期提交，并发布重构候选。默认使用这个模式。
- `execute`：对一个已经人工批准的候选执行重构、验证、提交、push，并创建 GitHub PR。

这个 skill 不负责定时调度。调度器可以定时唤起 Codex，但 skill 只定义 Codex 被唤起后的执行流程。

## 硬规则

- 默认使用 `report-only`。在 `report-only` 中不要编辑文件、创建分支、commit、push 或创建 PR。
- `execute` 必须拿到固定 GitHub Issue 状态 comment 中已经人工批准的候选 ID。
- `base_branch` 是分析范围、执行分支基点和 PR target 的唯一事实来源。
- 如果候选记录中的 `base_branch` 不是 `main`，不得在执行时重新默认回 `main`。
- 超过 600 行的文件必须进入候选分析，但不等于必须改代码。
- 不要改变产品行为、路由、协议、交互或视觉结果；如果确实改变，必须在 PR 中明确说明。
- 前端 `src/` 变更不得新增 Vitest/unit tests：不要在前端源码路径下新增 `*.test.ts`、`*.test.tsx`、`*.spec.tsx` 或 `*.ui.test.tsx`。
- UI 重构使用 E2E 和截图证据。截图应保存为 CI artifact、PR 链接/comment 或本地临时路径；不要把日常验证截图提交到 `docs/superpowers/plans/assets/`。
- 如果验证无法覆盖受影响行为，不要执行重构。
- 每个 PR 只处理一个小而清晰、便于 review 的重构主题。

## 状态来源

唯一事实来源是一个固定 GitHub Issue comment，其中包含 fenced JSON 块。不要把 Actions cache、artifact、gist、本地文件或调度器私有状态作为候选状态来源。

状态结构要求：

```json
{
  "version": 1,
  "analysis_cursor": {
    "base_branch": "main",
    "last_analyzed_sha": "abc123"
  },
  "open_candidates": [
    {
      "id": "daily-refactor-main-abc123-def456-terminal-workspace",
      "status": "open",
      "base_branch": "main",
      "range": {
        "from": "abc123",
        "to": "def456"
      },
      "scope": "terminal workspace split",
      "touched_files": [
        "frontend/src/components/terminal/terminal-workspace.tsx"
      ],
      "reasons": ["file exceeds 600 lines"],
      "verification": ["pnpm lint", "pnpm typecheck", "pnpm quality:gate"],
      "report_url": "https://github.com/org/repo/actions/runs/...",
      "pr_url": null
    }
  ]
}
```

候选状态：

- `open`：已报告，尚未批准。
- `approved`：人工明确批准执行。
- `rejected`：人工拒绝，或无限期推迟。
- `pr_opened`：执行后已经创建 PR。
- `closed`：PR 已合并/关闭，或后续分析证明候选已失效。

如果固定 Issue/comment 不存在，只能产出一次性报告。不要推进 `analysis_cursor`，也不要进入 `execute`。

更新 comment 时，必须先读取当前 JSON，再按候选 ID 合并。不要覆盖人工修改过的候选状态。

## 提交窗口

有状态时使用 Git SHA range，不使用 wall-clock 时间：

```bash
base_branch="${BASE_BRANCH:-main}"
git fetch origin "$base_branch"
current_base_sha="$(git rev-parse "origin/$base_branch")"
last_analyzed_sha="<from analysis_cursor for base_branch>"
git log --oneline --decorate "$last_analyzed_sha..$current_base_sha"
git diff --name-only "$last_analyzed_sha..$current_base_sha"
```

默认不要使用 `--no-merges`；merge commit 也可能引入 touched files。

如果没有 cursor，只能在报告生成时 fallback 到 yesterday-to-now，并在报告中标记为非幂等。fallback 产生的候选必须先持久化到固定 Issue comment，之后才能被批准执行。

## 重构候选标准

满足任一条件时，文件或模块必须进入候选分析：

- 被触达的代码文件超过 600 行。
- 本次提交范围让某个被触达的代码文件从不超过 600 行变成超过 600 行。
- 一个文件混合多个职责，例如 UI、数据请求、状态、协议转换、持久化和副作用。
- 公共逻辑在 3 个或更多位置重复，且没有明确业务差异。
- 模块调用链必须依赖记忆或偶然知识才能理解。

以下情况优先建议 `defer`，不要急于执行：

- 拆分接近 600 行的文件会制造更多跳转成本，而不是提升清晰度。
- 重复逻辑只有 2 处，并且可能有意分化。
- 抽象会跨越 frontend/backend/electron 边界。
- 候选触达协议、认证、终端 runtime、Electron 打包或 CI，并且验证覆盖较弱。

以下情况不要执行：

- 只能通过大范围重写完成。
- 验证不足。
- 重构会改变公开协议、持久化数据、用户可见行为或交互。
- 工作区中存在会与本次重构冲突的无关本地改动。

## Report-Only 流程

1. 检查 `git status --short`。
2. 读取固定 GitHub Issue 状态 comment。
3. 解析 `base_branch`、`last_analyzed_sha` 和 `current_base_sha`。
4. 收集 commits、touched files、行数和高风险区域。
5. 生成稳定候选 ID，ID 应包含 base branch、range 和 scope。
6. 对每个候选给出建议状态：`do now`、`defer` 或 `do not refactor`。
7. 更新固定 Issue comment：
   - 只有报告已经产出后，才推进 `analysis_cursor.last_analyzed_sha`；
   - 持久化或更新 `open_candidates`；
   - 保留已有的人工设置状态。
8. 输出简洁报告。不要创建分支或 PR。

## Execute 流程

只有当用户提供已批准候选 ID，或调度器传入的 ID 已经在固定 Issue 状态中标记为 `approved` 时，才能继续。

1. 按 ID 从 `open_candidates` 读取候选。
2. 如果候选缺失、未标记为 `approved`，或没有 `base_branch`，停止。
3. 检查 `git status --short`；如果有冲突的无关本地改动，停止。
4. 从候选的 base branch 创建分支：

   ```bash
   git fetch origin "$base_branch"
   git switch -c "codex/daily-refactor-YYYYMMDD" "origin/$base_branch"
   ```

5. 重新确认候选文件、行数、风险和验证计划。
6. 执行最小重构切片，并保持行为不变。
7. 只删除由本次重构制造的无用 import、变量或文件。
8. 按下面的质量规则验证。
9. 使用 `refactor: ...` 提交。
10. push，并创建 target 为候选 `base_branch` 的 PR。
11. 更新固定 Issue 状态：把候选设为 `pr_opened`，并写入 `pr_url`。

## 质量门禁

不要把 `pnpm quality:gate` 当成完整 PR/CI 门禁。它只会根据 changed files 选择 default/e2e/live 测试层。

在 `execute` 中创建 PR 前，必须运行：

```bash
pnpm lint
pnpm typecheck
pnpm quality:gate
```

还需要按影响面补充：

- 变更触达 build、package、静态资源、发布或 bundling 链路时，运行 `pnpm build`。
- 变更触达 backend、`packages/shared`、质量脚本、测试门禁或 CI quality scope 时，运行 `pnpm coverage`。
- 当候选风险没有被 `quality:gate` 覆盖时，从 `docs/testing/command-matrix.md` 选择补充命令。

对于 report-only 或 docs-only 变更，除非改了代码，否则 `git diff --check` 足够。

如果 `quality:gate` 选择了 minimal 覆盖，需要在报告或 PR 中解释原因；已执行代码变更时，至少保留 `git diff --check`、`pnpm lint` 和 `pnpm typecheck`。

## 截图证据

UI 重构需要采集 before/after 截图：

- 定时或 report 运行优先使用 CI artifacts。
- 需要 reviewer 对比时，优先使用 PR comment 或附件链接。
- 人工执行时使用本地临时路径，例如 `/tmp/runweave-daily-refactor/<candidate-id>/before` 和 `/tmp/runweave-daily-refactor/<candidate-id>/after`。

不要提交日常验证截图。只有长期设计图或架构说明图才应该放到 `docs/superpowers/plans/assets/`。

## PR 流程

PR body 必须包含：

```markdown
## Trigger Window

- Base branch:
- Last analyzed SHA:
- Current base SHA:
- Fallback time window, if state was missing:
- Commits analyzed:

## Why Refactor

- Candidate ID:
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

## 停止条件

遇到以下情况时，停止并报告，不要改代码：

- 执行模式无法读取固定 GitHub Issue/comment 状态。
- 候选 ID 缺失、未批准、已过期，或不匹配目标 base branch。
- 工作区存在与重构冲突的无关改动。
- 重构无法保持在一个小候选内。
- 验证覆盖不足。
- 必要的 CI 对齐检查无法运行，且没有可接受的说明。
