---
name: github-pr
description: 当用户要求提交代码并合并到 GitHub（提交 PR、走完 PR 全流程、合并到主分支）时使用。一键完成：提交工作区代码 → 创建 PR → 轮询状态并解决冲突/门禁失败 → CR 通过后合并。
---

# GitHub PR 全流程

一条命令把当前工作区的改动**提交、开 PR、跟到通过、合并进目标分支**。基于 `gh` CLI（GitHub）。

适用于 GitHub 仓库（`git remote get-url origin` 指向 github.com）。非 GitHub 仓库（如内部 GitLab）改用 create_mr 技能。

## 参数

- 目标分支可选：用户指定则用指定分支；未指定默认远程主分支（`origin/HEAD`，回退 `main` → `master`）。
- 默认新建分支提交并基于它开 PR；仅当用户明确要求「当前分支」时在当前分支提交。

## 前置检查

- `gh auth status` 确认已登录；未登录则提示用户授权，不要硬闯。
- `git remote get-url origin` 确认是 GitHub 仓库。

## 流程

### 1. 提交代码

- `git status --porcelain` 检查改动；有改动则 `git add -A` 暂存全部。
- 读 `git diff --cached` 理解改动，生成语义化 commit message（Conventional Commits，描述意图而非文件列表）。
- 默认基于 commit subject 新建分支：`git checkout -b <type>/<slug>`；用户要求当前分支则跳过。
- `git commit`。pre-commit hook 失败时按 hook 输出修复后重试（husky 需要 node 在 PATH）。
- 工作区无改动但分支已有领先提交时，直接进入开 PR。

### 2. 创建 PR

- `git push -u origin <branch>`。被拒（non-fast-forward）先 `git fetch` 再 `git rebase origin/<branch>` 后重推。
- `gh pr create --base <目标分支> --head <branch> --title <subject> --body <说明>`。
- body 写清改动要点与验证情况。
- 若同 head/base 已存在 open PR，用 `gh pr view --json url` 复用，不重复创建。
- 记录 PR 编号/URL 供后续轮询。

### 3. 轮询状态，解决冲突与门禁失败

目标：把 PR 推进到「可合并 + CR 通过」。用 JSON 读权威状态，不要靠页面文本猜：

```bash
gh pr view <pr> --json number,state,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks <pr>   # 门禁明细
```

关键字段：

- `mergeable`：`MERGEABLE` 可合 / `CONFLICTING` 有冲突 / `UNKNOWN` 计算中（稍等重查）。
- `mergeStateStatus`：`CLEAN` / `BLOCKED`（缺 CR 或门禁）/ `BEHIND`（落后基线）/ `DIRTY`（冲突）。
- `reviewDecision`：`APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`。
- `statusCheckRollup`：各 CI check 的 `state`（SUCCESS/FAILURE/PENDING）。

处理策略：

- **CI pending**：间隔轮询（如每 15–30s，`gh pr checks <pr>`），不要忙等空转；超时则报告当前状态。
- **代码冲突（CONFLICTING/DIRTY）**：本地 `git fetch origin && git rebase origin/<目标分支>`，解决冲突后 `git push --force-with-lease`（GitHub 仓库允许 `--force-with-lease`）。
- **落后基线（BEHIND）**：同上 rebase 到最新目标分支后重推。
- **门禁失败（statusCheckRollup 有 FAILURE）**：拉取失败 check 的日志，定位并修复（如 lint/类型/测试），提交后重新推送触发重跑。
- **CHANGES_REQUESTED**：这是人工评审要求改动；总结评审意见，做出修改后重推，不要绕过评审。
- 每轮处理后重新查询状态，直到 `mergeable=MERGEABLE` 且 `reviewDecision=APPROVED`（或仓库未要求评审时 `mergeStateStatus=CLEAN`）。

### 4. CR 通过后合并

- 满足合并条件后执行：`gh pr merge <pr> --squash --delete-branch`（默认 squash + 删源分支；按仓库惯例可改 `--merge`/`--rebase`）。
- 若启用了合并队列或必需 check 仍在跑，可用 `gh pr merge <pr> --auto --squash` 让其满足条件后自动合并。
- 合并后 `gh pr view <pr> --json state,mergedAt` 确认 `state=MERGED`，输出最终结果。

## 安全与边界

- 只在确认 GitHub 仓库且已登录时执行；缺权限就停下找用户要授权。
- **不用 `--admin` 绕过门禁，不跳过人工评审**（CHANGES_REQUESTED 必须真实改完）。
- 冲突/落后用 `--force-with-lease`，不用 `--force`。
- 检测到疑似敏感信息（密钥/密码）时警告用户再继续。
- 全程可观测：每一步输出分支、commit、PR URL、当前状态；失败不静默，报出关键字段与错误。
