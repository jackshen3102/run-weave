---
name: runweave-dev-session
description: "Use whenever Codex needs to actually plan, start, inspect, open, attach to, recover, or stop a Runweave Dev Session, including any execution of pnpm dev:session, dev:status, dev:open, or dev:stop. Manage exact worktree and Session identity, planner-selected profiles, Beta slots, surfaces, and cleanup. Do not trigger for conceptual discussion that does not operate a runtime Session."
---

# Runweave Dev Session

把 Dev Session 作为运行环境事实源。始终从准确的源码 worktree 和 Stable 控制面操作，不按端口、最近启动时间或窗口外观猜测目标。

## 与其他技能组合

- `$toolkit:runweave-change-validation` 负责完整代码变更验收、patch 边界和证据合同；本技能负责其中的 Dev Session 生命周期。显式调用前者时，两者同时使用。
- 页面 DOM、点击、输入和截图需要 `$toolkit:playwright-cli`；只附着 `dev:open` 返回的目标 CDP。
- macOS 原生窗口、菜单或系统弹窗确实参与任务时，使用 `$computer-use`。

## 选择操作模式

- 只查询现有 Session：执行 `status` 或 `open`，不要创建或停止 Session。
- 创建环境：先 dry-run，再按 planner 结果启动。
- 管理指定 Session：后续每条命令显式传入同一个 `--session <id>`。
- 多 worktree 并行：分别在各自 worktree 执行并保存独立 Session ID；不得从一个 worktree 猜测或操作另一个 worktree 的 Session。

## 1. 固定 source root

在用户指定或任务实际修改所在的 worktree 中确认：

```bash
pwd
git status --short
```

不要自动切换到主 checkout。正常开发不覆盖 `RUNWEAVE_DEV_SESSION_HOME`；只有测试合同或用户明确要求隔离 registry 时才设置它。

## 2. 让 planner 先裁决

创建 Session 前先执行无显式 profile 的只读规划：

```bash
pnpm dev:session --dry-run --json
```

检查 `sourceRoot`、`changedFiles`、`impacts`、`requiredProfile`、service ownership 和 acceptance surface。profile 高于预期时先检查真实 diff，不得显式向下降级。

用户明确要求安装态、跨版本、Electron 或 Beta 目标时，可以在不低于 `requiredProfile` 的前提下提升 profile。只查询或操作既有 Session 时不重复 dry-run。

## 3. 启动并捕获身份

默认让 CLI 生成 Session ID：

```bash
pnpm dev:session --json
```

需要提升目标时才显式指定：

```bash
pnpm dev:session --profile <profile> --json
```

立即保存返回的 `devSessionId`、`profile`、`source.root` 和 services。不要自行生成随机 ID。只有用户明确指定，或上层复现/变更验证合同已经提供 `validationSessionId` 时，才传入该 ID。

Beta profile 使用全机共享的 `pool-01` 至 `pool-05`：

- 默认自动分配槽位，不传 `--instance`。
- 只有用户或测试合同明确要求固定槽位时才传 `--instance pool-0N`。
- dry-run 的容量快照不是租约承诺；真实 start 才原子获取槽位。
- 槽位占满或显式槽位已占用时按失败处理，不等待、不抢占、不清理其他 Session。

## 4. 核对状态

启动后和关键操作前使用精确 ID：

```bash
pnpm dev:status --session <id> --json
```

至少核对：

- `devSessionId`、`source.root` 和 revision 属于本次 worktree；
- state 满足当前操作要求；
- profile、dedicated/shared ownership 和 service identity 符合 planner；
- Beta 的 slot、lease 和 CDP identity 一致。

若没有 ID，只允许在准确 source root 中调用一次无 `--session` 的 `dev:status` 来解析唯一候选。出现多个候选时停止并列出候选，不选择“最新”的 Session。

## 5. 解析 surface

只通过 resolver 获取入口：

```bash
pnpm dev:open --session <id> --surface <surface> --json
```

surface 选择：

- `web`：Web 页面 URL；
- `desktop`：Electron 主窗口和终端标签 CDP；
- `terminal-browser`：终端右侧内嵌 Browser CDP。

浏览器验收时，同时使用 `$toolkit:playwright-cli`：

- `desktop` 和 `terminal-browser` 按返回的 `suggestedPlaywrightSession` 和 `endpoint` 执行 `attach --cdp=<endpoint>`；
- `web` 的 `endpoint` 是 URL，不是 CDP。需要自动化 Web 页面时，另外解析 `terminal-browser` CDP，在本次新建的内嵌 Browser tab 中导航到该 Web URL；目标 profile 不提供所需 CDP 时，按验收目标合法提升 profile 或报告阻塞。

禁止改用固定端口、ambient endpoint、系统浏览器、`playwright-cli open` 或既有无关 Playwright session。

## 6. 停止与清理

任务创建的 Session 在完成或失败后都应停止，除非用户明确要求保留：

```bash
pnpm dev:stop --session <id> --json
```

只停止该 manifest 拥有的 dedicated 服务，不停止 shared 服务或其他 worktree 的资源。不是本任务创建的 Session，除非用户明确要求，不得停止。

遇到 stale、PID 漂移、占用或清理失败时：

- 保存 `dev:status --session <id> --json` 和错误中的 recovery 指引；
- 只有 recovery 明确要求且目标身份可验证时，才执行 `dev:stop --session <id> --cleanup-stale --json`；
- 不删除 manifest、profile lock、Beta lease 或端口 lease；
- 不按端口盲杀进程，不重置其他 worktree，不无限轮询。

## 交付

报告实际操作结果：source root、Session ID、profile、关键 ownership；Beta 时包含 slot；打开页面时包含 surface 和目标 identity；最后说明 Session 已停止、按要求保留，或具体清理阻塞。
