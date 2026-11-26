# Review changes 相对主分支 Diff 与本分支提交审阅实施计划

当 Agent 在 Worktree 内执行 `git commit` 后，桌面端与原生 iOS 的 `Review changes` 仍可通过切换「相对主分支」或「本分支提交」完整只读审阅本分支改动，不再出现提交后变更面板变空的问题。本计划仅实施机制 2 的**第一阶段（纯只读 Git 对比）**，产品交互以 [可视化方案](../prototypes/t3code-borrowings-plan/index.html#mech-2) 为准。

## 1. 目标与非目标

### 目标

- 在桌面/Web 右侧 `Preview → Review changes` 与原生 iOS `ChangesView` 新增三档变更范围（`scope`）切换：
  1. `working`（默认）：保持现有 `Staged`（`HEAD → index`）与 `Working`（`index → 工作区`）行为与写操作完全不变；
  2. `branch`：对比**项目主分支与当前 `HEAD` 的共同祖先（`merge-base`）到当前工作区**的净文件变更（同时覆盖已提交与未提交改动，且排除分叉后远端主分支新增的他人改动）；
  3. `commits`：列出 `mergeBaseOid..HEAD` 之间最近最多 50 个本分支独占提交，选中单条提交后只读查看该提交（`commit^ → commit`）的文件列表与单文件 Diff。
- 复用 `HomeBranchStatusService` 已有的项目 `mainBranch` 配置与远端基准解析规则，不引入第二套主分支配置。
- 文本、Markdown、SVG、HTML、重命名及图片版本预览在 `branch` 与 `commits` 下沿用现有 `file-diff` / `change-asset` 能力。

### 非目标（不做什么）

- **明确不实施第二阶段**：不引入 `.git` 隐藏检查点引用（如 `refs/runweave/checkpoints/*`）、不建立按 Agent 对话轮次（Turn）隔离的临时索引快照、不做会话或工作区一键回滚。
- 不在 `branch` 或 `commits` 模式下提供 stage、unstage、commit、单文件 Reset、单文件删除/重命名、rebase 或 merge 等任何 Git/磁盘写操作。
- 切换 `scope` 时不主动执行联网 `git fetch`（仅复用本地已有远端跟踪引用，或在用户显式点击刷新时沿用既有只读引用更新策略）。

## 2. 用户可见行为与业务规则

1. **范围切换与计数展示**：
   - `Review changes` 顶部提供 `未提交 (Working)`、`相对 <baseBranch>`、`本分支提交` 三档切换；同一 `effectiveProjectId` 内切换终端保留当前所选 `scope`，切换项目时按项目隔离恢复。
   - 当 Agent 已提交全部修改使 `working` 为 0 项时，`working` 空态文案提示可切换到「相对主分支」查看本分支已提交改动（不自动强跳，尊重用户当前选择）。
2. **`branch` 相对主分支净变更规则**：
   - 基准分支取所属父项目的 `mainBranch` 设置；未设置时取 `origin`（或唯一 remote）的默认分支跟踪引用（如 `refs/remotes/origin/main`）。
   - 计算 `mergeBaseOid = git merge-base <baseOid> HEAD`，对比 `mergeBaseOid` 与当前工作区（包含未跟踪普通文件）：若某文件在某次提交中新增又在后续提交或工作区中还原回与 `mergeBaseOid` 完全一致，则净变更为无，不出现在列表中。
   - 若当前已在主分支本身且无领先提交、或工作区与 `mergeBaseOid` 完全一致，明确显示「相对 `<baseBranch>` 暂无变更」。
3. **`commits` 本分支提交审阅规则**：
   - 读取 `git log --first-parent=false --date-order --max-count=50 <mergeBaseOid>..HEAD`，展示短 SHA、标题、作者与提交时间；超过 50 条时标注「仅展示最近 50 个提交」。
   - 点击某条提交展开其变更文件树（根提交或 merge commit 使用 `git diff-tree --root -m --first-parent -r --name-status -z -M <commitOid>`，统一对比第一父提交 `commitOid^1 → commitOid`），点击文件右侧展示只读 Diff。
4. **不可比较与陈旧版本保护**：
   - 非 Git 目录、浅克隆（`--is-shallow-repository=true`）、无可用远端基准或无共同历史（`merge-base` 退出码非 0）时，返回明确的 `state: "unavailable"` 与原因枚举（`not-repository | shallow-repository | base-unavailable | no-merge-base`），前端与 iOS 显示具体原因，**严禁当作空数组显示「0 个变更」**。
   - 单文件 Diff 与图片资源请求必须携带列表返回的 `expectedBaseOid`（`branch` 下为 `mergeBaseOid`，`commits` 下为 `commitOid`）；若请求期间用户执行了 `rebase / commit --amend` 导致目标失效或当前 `branch` 视图下 `mergeBaseOid` 已改变，返回 `409`（`code: "terminal_preview_stale_diff"`），沿用前端单次协调刷新机制，不返回拼凑的跨版本内容。
5. **只读权限门禁**：
   - 在桌面文件树右键菜单与 iOS `ChangesView` 长按菜单中，仅当 `scope === "working"` 时渲染 `Reset` 与 `删除文件` / `重命名`；后端 `POST /git-change/reset` 仍硬性校验 `kind: "staged" | "working"`。

## 3. API 合约与数据结构

### 3.1 共享 DTO（`packages/shared/src/terminal/preview.ts`）

```ts
export type TerminalPreviewChangeScope = "working" | "branch" | "commits";
export type TerminalPreviewChangeKind =
  | "staged"
  | "working"
  | "branch"
  | "commit";

export type TerminalPreviewComparisonUnavailableReason =
  | "not-repository"
  | "shallow-repository"
  | "base-unavailable"
  | "no-merge-base";

export interface TerminalPreviewBranchCommitItem {
  oid: string;
  shortOid: string;
  subject: string;
  authorName: string;
  committedAt: string;
}

export interface TerminalPreviewBranchChangesResponse {
  kind: "git-branch-changes";
  projectId: string;
  projectPath: string;
  repoRoot: string | null;
  state: "ready" | "unavailable";
  reason?: TerminalPreviewComparisonUnavailableReason;
  baseRef?: string; // 例如 "origin/main"
  baseOid?: string;
  mergeBaseOid?: string;
  headOid?: string;
  files: TerminalPreviewChangeFile[];
}

export interface TerminalPreviewBranchCommitsResponse {
  kind: "git-branch-commits";
  projectId: string;
  projectPath: string;
  repoRoot: string | null;
  state: "ready" | "unavailable";
  reason?: TerminalPreviewComparisonUnavailableReason;
  baseRef?: string;
  mergeBaseOid?: string;
  headOid?: string;
  truncated: boolean;
  commits: TerminalPreviewBranchCommitItem[];
  selectedCommitOid: string | null;
  files: TerminalPreviewChangeFile[];
}
```

### 3.2 HTTP 路由（均位于 `/api/terminal/project/:id/preview/`，沿用现有登录与项目路径边界）

1. **`GET /git-changes`**（保持原响应结构不变，供旧客户端与 `scope=working` 使用）。
2. **`GET /git-branch-changes`**（新增）：
   - 查询参数：无任意 Git ref 输入（基准完全由服务端根据父项目 `mainBranch` 设置解析，防止客户端注入任意 ref 探测仓库对象）。
   - 返回：`TerminalPreviewBranchChangesResponse`。
3. **`GET /git-branch-commits`**（新增）：
   - 查询参数：`commitOid?: /^[0-9a-f]{40,64}$/`（省略时默认取最新一条分支提交并返回其 `files`；若传入的 `commitOid` 不在当前 `mergeBaseOid..HEAD` 集合内，返回 `409 terminal_preview_stale_diff`）。
   - 返回：`TerminalPreviewBranchCommitsResponse`。
4. **`GET /file-diff` 与 `GET /change-asset` 扩展**：
   - `kind` 扩展支持 `"branch"`（必传 `baseOid=<mergeBaseOid>`，对比 `mergeBaseOid:<oldPath> → working:<path>`）与 `"commit"`（必传 `commitOid=<oid>`，核对该 `commitOid` 属于当前仓库可达历史后对比 `<commitOid>^1:<oldPath> → <commitOid>:<path>`，根提交旧侧记为 `missing`）。
   - 严格校验 `baseOid` / `commitOid` 为 40/64 位十六进制哈希且使用 `--end-of-options`，杜绝 Git 参数注入。

## 4. 修改与新增文件清单

| 文件路径                                                                               | 操作 | 职责说明                                                                                                                                                 |
| :------------------------------------------------------------------------------------- | :--- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/terminal/preview.ts`                                              | 修改 | 新增 `TerminalPreviewChangeScope`、`TerminalPreviewBranchChangesResponse`、`TerminalPreviewBranchCommitsResponse` 并扩展 `file-diff` 请求参数类型        |
| `backend/src/terminal/git/home-branch-status.ts`                                       | 修改 | 提取只读远端基准引用解析 helper（不强制触发远端 fetch），供分支状态与 Preview 分支 Diff 共享同一基准逻辑                                                 |
| `backend/src/terminal/preview/change-content.ts`                                       | 修改 | 支持从经校验的 `commitOid` / `mergeBaseOid` 读取历史侧文本与原始图片字节（保持 1 MiB 文本、5 MiB 图片硬上限）                                            |
| `backend/src/terminal/preview/git.ts`                                                  | 修改 | 实现 `getPreviewGitBranchChanges`、`getPreviewGitBranchCommits` 及 `branch/commit` 两侧 `readComparison`（含工作区未跟踪文件与 `mergeBaseOid` 合并逻辑） |
| `backend/src/routes/terminal/preview/index.ts`                                         | 修改 | 注册 `/git-branch-changes`、`/git-branch-commits` 并扩展 `/file-diff`、`/change-asset` 的 Zod 严格校验                                                   |
| `frontend/src/features/terminal/preview/store.ts`                                      | 修改 | 按 `projectId` 保存当前 `changesScope`、`selectedCommitOid` 与各 scope 下的文件选择                                                                      |
| `frontend/src/features/terminal/queries/preview.ts`                                    | 修改 | 新增分支变更与分支提交查询 hook，绑定连接与 `projectId` 隔离缓存                                                                                         |
| `frontend/src/components/terminal/preview/changes/view.tsx` 与 `tree.tsx`              | 修改 | 增加三档范围切换器、提交选择器与不可比较状态提示；非 `working` 下隐藏写操作菜单                                                                          |
| `packages/app-ios/Sources/RunweaveIOS/Contracts/` 对应 Preview DTO                     | 修改 | 对照 `packages/shared` 同步新增分支变更与提交列表 Swift 结构体                                                                                           |
| `packages/app-ios/Sources/RunweaveIOS/Features/Preview/ChangesView.swift` 及关联 Model | 修改 | 支持 `未提交 / 相对主分支 / 本分支提交` 切换，复用现有 `FilePreview` / `DiffView`，非 `working` 禁用长按 Reset/删除                                      |
| `docs/architecture/terminal-code-preview.md`                                           | 修改 | 更新 `Review changes` 当前能力与只读边界说明                                                                                                             |
| `docs/testing/terminal/branch-and-commit-diff.testplan.yaml`                           | 新建 | 覆盖分支净 Diff、提交切换、版本漂移 409 与浅克隆/越界防护的标准验收计划                                                                                  |

## 5. 高风险点与安全/兼容回滚

- **任意 Git 对象探测与参数注入风险**：客户端传入的 `baseOid` / `commitOid` 必须匹配 `/^[0-9a-f]{40,64}$/`，且服务端必须先核实 `baseOid` 等于当前实时计算的 `mergeBaseOid`（或 `commitOid` 位于当前 `mergeBaseOid..HEAD` 列表内），否则一律返回 `409`，防止客户端凭猜测 SHA 读取其他脱节分支对象。
- **子目录 Project 路径裁剪**：当登记的 `project.path` 是 Git 仓库的子目录时，`git diff --name-status` 与 `git diff-tree` 输出的是仓库根相对路径，必须复用 `git.ts` 现有的 `stripProjectPrefix` 与 `resolvePreviewGitPath` 包含校验，禁止泄露项目子目录之外的仓库文件。
- **兼容与回滚**：原有 `/git-changes` 和 `kind=staged|working` 保持原字段兼容；旧版 iOS 连接新版 Backend 不受影响；新版 iOS 连接旧版 Backend 遇到新路由 `404` 时在「相对主分支 / 本分支提交」页显示「当前电脑服务端版本暂不支持，请升级 Backend」，不影响 `working` 使用。

## 6. 验收标准与验证方式

配套新增测试计划：[docs/testing/terminal/branch-and-commit-diff.testplan.yaml](../testing/terminal/branch-and-commit-diff.testplan.yaml)，同时回归既有 [docs/testing/app/change-preview-capabilities.testplan.yaml](../testing/app/change-preview-capabilities.testplan.yaml)（`CHGPREVIEW-001` 至 `CHGPREVIEW-006`）。

- [ ] `pnpm testplan:validate docs/testing/terminal/branch-and-commit-diff.testplan.yaml` 与 `pnpm docs:check` 通过。
- [ ] `pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`、`pnpm --filter @runweave/frontend typecheck`、`pnpm lint`、`pnpm architecture:check` 及 `pnpm ios:build` 全部通过。
- [ ] 在受管 Dev Session 桌面端（`$toolkit:playwright-cli`）与 iOS 模拟器（`$toolkit:agent-device`）逐条通过 `BRDIFF-001` 至 `BRDIFF-006`：确认 Agent `git commit` 后 `working` 为空而 `branch` 准确显示相对 `main` 的全部净改动（含先增后删抵消场景）、`commits` 可逐条审阅、浅克隆显式报 `unavailable`、且整个过程 `git status` 与 `.git/refs` 无任何副作用写入。
