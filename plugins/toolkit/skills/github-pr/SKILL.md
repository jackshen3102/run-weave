---
name: github-pr
description: 当用户要求提交代码并合并到 GitHub（提交 PR、走完 PR 全流程、合并到主分支）时使用。一键完成：提交工作区代码 → 创建 PR → 轮询状态并解决冲突/门禁失败 → CR 通过后合并。
---

# GitHub PR 全流程

一条命令把当前工作区的改动**提交、开 PR、跟到通过、合并进目标分支**。基于 `gh` CLI（GitHub）。

这是随插件安装的跨仓库技能，适用于 GitHub 仓库。目标仓库无需包含本技能、预检脚本或插件源码；所有 Git 操作都在用户要提交的目标仓库执行。

技能资源从实际加载的 `SKILL.md` 所在目录解析，使用绝对路径调用；不要到目标仓库寻找 `plugins/toolkit`，也不要硬编码某台机器的路径或缓存版本。辅助脚本仅依赖 Node.js 内置模块、Git 和 `gh`，不需要在目标仓库安装 npm/pnpm 依赖。没有 Node.js 或脚本资源缺失时，按下述规则逐项执行 Git/gh 只读检查，不要求目标项目引入 Node.js。

构建、lint、测试、提交格式及 PR 模板以目标仓库的说明和现有配置为准，不沿用技能开发仓库的命令。Husky 和提交钩子都可选，不存在时记录为缺省，不自动创建或安装。

## 参数

- 目标分支可选：用户指定则用指定分支；未指定默认远程主分支（`origin/HEAD`，回退 `main` → `master`）。
- 默认新建分支提交并基于它开 PR；仅当用户明确要求「当前分支」时在当前分支提交。
- 以下命令以 `origin` 为常见示例。使用其他 remote、fork/upstream 或 GitHub Enterprise 时，先从用户请求和远端配置确定发布仓库、PR 目标仓库及主机，再替换命令参数；不能把它们默认当作同一个仓库。非 GitHub 平台使用对应流程；仅在可用时转用 create_mr 技能。

## 前置检查

- 在目标工作区调用随技能分发的 [预检脚本](scripts/preflight.mjs)：`node "<技能安装目录>/scripts/preflight.mjs" "<目标工作区路径>"`；省略工作区参数时检查当前目录，不要为了运行脚本切换到技能目录。脚本只读，不执行 hook、fetch、暂存或账号切换；输出 JSON 和各项退出码，全部检查收集完成后才以 0/1 表示预检通过/存在失败。
- 检查内容包括当前提交、分支（允许 detached HEAD）、工作区与暂存区、worktree 占用、origin 的读取/推送目标、有效 hook 路径及 Husky 入口、活跃账号和目标仓库访问权限。脏工作区属于待确认范围，不自动判失败；`passed` 只表示预检完成且无失败，不代表已获写权限或可以合并。
- 认证使用 `gh auth status --active --hostname github.com`，并通过当前账号及目标仓库 API 验证。非活跃账号失效不阻断，不自动登出或切换账号。不要用普通 `gh auth status` 的整体失败判定当前账号失效；也不要用 `gh auth status --json` 的退出码判断认证成功，它可能在认证失败时仍返回 0。
- 脚本失败时检查 `failedChecks` 和 `hooks`；网络错误、超时、缺少 CLI 与权限不足分别处理。脚本隐藏认证原文，必要时单独重跑失败检查，不使用 `--show-token`。确实缺少当前身份或所需权限时才找用户授权。
- 独立只读检查分别保留结果，不用 `&&` 串联，也不用 `|| true` 吞错。依赖操作仍需前一步成功才能执行；异步命令返回运行中标识时，等待其真正完成。手动回退也遵守这些规则。
- 辅助脚本自动检查的范围是 `origin` 指向 github.com 且读写目标一致。其他 remote、fork、SSH 主机别名、Enterprise 等配置使用手动预检：独立检查工作区、暂存区、worktree 和实际钩子路径；解析真实主机与仓库后检查 `gh auth status --active --hostname <主机>`、当前身份及仓库权限。脚本不支持某种配置不等于该仓库不能使用本技能；目标能从现有配置确定时无需再次询问。

## 流程

### 1. 提交代码

- 根据用户请求和 diff 确定本次范围，检查已有暂存内容；使用 `git add -- <本次路径>`，同文件混有其他任务改动时按 hunk 暂存。只有用户明确要求全部改动且已核对范围时才用 `git add -A`。已有无关暂存内容也不能夹带提交或擅自取消暂存，必要时使用独立 worktree 承载本次补丁。
- `git fetch origin` 后核对目标分支与本次提交范围；如改动已合并，验证实际内容后报告，避免重复 PR。新分支不能夹带当前分支上无关的领先提交。脏工作区不要直接 rebase，也不要为方便操作而 stash、reset 或清理他人改动。
- 读 `git diff --cached` 复核最终范围，按目标仓库惯例生成 commit message；无明确惯例时使用 Conventional Commits，描述意图而非文件列表。
- 默认基于 commit subject 新建分支：`git checkout -b <type>/<slug>`；用户要求当前分支则跳过。
- `git commit`。pre-commit hook 失败时按输出处理依赖/环境问题或本次代码问题，复核 hook 生成的改动再重试。不修改无关代码来凑检查通过，不跳过 hook。
- 工作区无改动但分支已有领先提交时，直接进入开 PR。

### 2. 创建 PR

- `git push -u origin <branch>`；等待 hook 与推送成功退出后再开 PR。被拒（non-fast-forward）先 fetch 并检查远端新增提交的归属，再在工作区安全时 rebase，不能覆盖其他人的更新。
- 创建前按明确仓库、head/base 查询 open PR；存在则复用。命令超时或返回不确定时先查询远端是否已成功，避免盲目重试。
- 把说明写入临时文件，再用 `gh pr create --repo <仓库> --base <目标分支> --head <branch> --title <subject> --body-file <文件>`，保留换行和字面量。body 写清改动要点与实际验证情况。
- 记录 PR 编号/URL 供后续轮询。

### 3. 轮询状态，解决冲突与门禁失败

目标：把 PR 推进到「可合并 + CR 通过」。用 JSON 读权威状态，不要靠页面文本猜：

```bash
gh pr view <pr> --repo <仓库> --json number,state,headRefOid,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup
gh pr checks <pr> --repo <仓库> --json name,state,bucket,link
```

关键字段：

- `mergeable`：`MERGEABLE` 可合 / `CONFLICTING` 有冲突 / `UNKNOWN` 计算中（稍等重查）。
- `mergeStateStatus`：`CLEAN` / `BLOCKED`（缺 CR 或门禁）/ `BEHIND`（落后基线）/ `DIRTY`（冲突）。
- `reviewDecision`：`APPROVED` / `CHANGES_REQUESTED` / `REVIEW_REQUIRED`。
- `statusCheckRollup` 同时可能包含 CheckRun 的 `status/conclusion` 和 StatusContext 的 `state`，不能统一只读 `state`。可用 `gh pr checks` 的 `bucket` 归类：`pass/fail/pending/skipping/cancel`。

处理策略：

- **CI pending**：优先 `gh pr checks <pr> --repo <仓库> --watch --interval 20 --fail-fast`，通过异步执行等待并定期更新进度。普通 checks 的退出码 8 表示 pending，不是失败；查询/API 错误也不能当作 CI 失败。检查尚未注册、返回为空时核对仓库工作流，不能直接认定通过。等待超时报告仍在等待，不宣称完成。
- **代码冲突（CONFLICTING/DIRTY）**：本地 `git fetch origin && git rebase origin/<目标分支>`，解决冲突后 `git push --force-with-lease`（GitHub 仓库允许 `--force-with-lease`）。
- **落后基线（BEHIND）**：仓库门禁要求更新时，同上 rebase 后重推；仅目标分支有新提交且仍可正常合并时不重复 rebase。每次重推后，旧 SHA 的检查和评审结论不能替代新 SHA 的状态。
- **门禁失败**：拉取失败 check 的日志，定位并修复，提交后重新推送触发重跑；取消的检查、非预期跳过的必需检查也要查明原因。只在明确瞬时故障时有限重试，同一错误无新证据不循环重跑。
- **CHANGES_REQUESTED**：这是人工评审要求改动；总结评审意见，做出修改后重推，不要绕过评审。
- 合并前重新读取 `headRefOid`：当前提交的应运行检查已通过、评审要求已满足、无冲突且无其他阻塞才允许直接合并。`APPROVED` 不代表 CI 通过，`CLEAN` 不替代检查明细；`UNKNOWN` 继续等待。不要仅查 `--required` 而漏掉本次应运行的检查。若读取期间 head 改变，重新验证新 head。

### 4. CR 通过后合并

- 满足条件后执行 `gh pr merge <pr> --repo <仓库> --squash --match-head-commit <刚验证的headRefOid>`；按仓库惯例可改合并策略。远端合并与本地清理分步执行，默认不加 `--delete-branch`，避免 main 被其他 worktree 占用或脏工作区使整个操作表现为失败。
- 若启用了合并队列或仍需等待门禁，可登记 auto-merge/入队，登记时同样使用 `--match-head-commit`，并继续跟进当前 head；登记成功不等于已合并，不绕过门禁。
- 不论合并命令成功、失败或超时，都单独运行 `gh pr view <pr> --repo <仓库> --json state,mergedAt,mergeCommit,headRefOid` 确认远端事实。只有 `state=MERGED` 才报告合并完成；未知状态先查明再重试。

### 5. 合并后清理

- 先确认已合并，再 fetch 并重读 `git status`、分支指向及 `git worktree list`。只处理本次创建的分支/worktree；操作前再次确认没有新增提交或用户修改。
- 目标分支在其他 worktree 或当前目录变脏时，不自动切换/拉取该分支，不 stash、reset 或删除该 worktree。保留现场并明确报告“远端已合并，本地清理待完成”。干净的当前任务 worktree 可在核对后 detach 到最新目标分支，再安全删除本次本地分支；squash 后 `git branch -d` 拒绝时不直接升级为 `-D`。
- 远端源分支只在确认属于本次任务、仍指向已合并的 head 时删除。若用 `git push --delete`，须带针对该 ref 和已验证 SHA 的显式 `--force-with-lease`；该操作可能触发 pre-push，不能为省检查禁用 hook。分支已被自动删除则无需再处理。
- 最终分别报告 PR/合并提交、实际验证结果和清理状态。清理失败不改写已合并事实，也不触发重复合并。

## 安全与边界

- 只在确认 GitHub 仓库且已登录时执行；缺权限就停下找用户要授权。
- **不用 `--admin` 绕过门禁，不跳过人工评审**（CHANGES_REQUESTED 必须真实改完）。
- 冲突/落后用 `--force-with-lease`，不用 `--force`。
- 检测到疑似敏感信息（密钥/密码）时警告用户再继续。
- 全程可观测：每一步输出分支、commit、PR URL、当前状态；失败不静默，报出关键字段与错误。
