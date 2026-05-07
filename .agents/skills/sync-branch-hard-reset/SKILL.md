---
name: sync-branch-hard-reset
description: 当用户给出一个 Git 分支名，并要求先 fetch、切换到该分支、如有本地代码先 stash、再用 reset --hard 将该分支更新到 origin/main 最新代码，最后还原之前 stash 的本地改动时使用。
---

# 同步分支到 origin/main 最新

仅当用户明确给出目标分支名，并希望把该本地分支强制同步到远程主分支 `origin/main` 的最新代码时使用。这个流程会执行 `git reset --hard`，必须严格按顺序操作。

## 输入

- `branch_name`：用户给出的分支名。
- 如果用户给的是 `origin/<branch>`，本地分支名按 `<branch>` 处理，但 reset 基准仍然是 `origin/main`。
- 默认远端是 `origin`。用户明确指定其他 remote 时，才使用其他 remote。

## 固定流程

1. 检查当前状态：
   - `git status --short`
   - `git branch --show-current`
2. 如果 `git status --short` 有输出，先 stash 本地改动：
   - `git stash push -u -m "before hard reset <branch_name> $(date +%Y%m%d-%H%M%S)"`
   - 记录 `git stash list -1` 的输出，并记住最新 stash ref，例如 `stash@{0}`。
   - 如果 stash 失败，停止，不要继续 fetch、switch 或 reset。
3. 更新远端引用：
   - `git fetch --prune origin`
4. 确认远程主分支存在：
   - `git rev-parse --verify --quiet origin/main`
   - 如果不存在，停止，并说明 `origin/main` 不存在；不要执行 `reset --hard`。
5. 切换到目标分支：
   - 如果本地分支已存在：`git switch <branch_name>`
   - 如果本地分支不存在：`git switch -c <branch_name> --no-track origin/main`
6. 强制同步到 `origin/main` 最新：
   - `git reset --hard origin/main`
7. 如果第 2 步创建过 stash，还原本地改动：
   - `git stash pop <stash_ref>`
   - 如果还原时出现冲突，停止并报告冲突文件；不要继续做其他修复，除非用户明确要求。
8. 验证结果：
   - `git status --short`
   - `git branch -vv`
   - `git log -1 --oneline`

## 边界

- 不要在 stash 成功前执行 `reset --hard`。
- 如果本流程创建了 stash，reset 完成后必须尝试 `git stash pop` 还原；不要把用户的本地改动长期留在 stash 里不处理。
- 不要把 reset 目标改成 `origin/<branch_name>`，除非用户明确要求同步到同名远端分支。
- 不要 push。
- 不要删除分支。
- 不要处理和目标分支同步无关的改动。

## 回复

完成后简短说明：

- 当前分支。
- 已 reset 到 `origin/main` 的哪个最新 commit。
- 是否创建并还原了 stash；如果还原冲突，给出冲突文件和 stash 状态。
- `git status --short` 是否为空。
