# 2026-05-15 Terminal Tmux / Link Provider Re-Review 3

评审范围：用户再次优化后的当前未提交工作区 diff，包括未跟踪的新文件 `backend/src/terminal/tmux-orphan-scan.ts` 和 `backend/src/terminal/tmux-orphan-scan.test.ts`；不评审既有 `docs/review` 报告文件。

## 架构 / 策略发现

### P2 - tmux orphan 删除能力仍放在通用 terminal API 下

- 当前决策：启动阶段已经只做 scan/log，并且 `logOrphanedTmuxSessions` 对 tmux 不可用和 scan 失败做了容错；但 `DELETE /api/terminal/tmux/orphans?confirm=true` 仍作为普通 terminal API 暴露，且 `includeAttached=true` 允许显式删除 attached orphan。
- 为什么它在系统层面可能是错的：tmux session 是 Runweave 用来保活用户长任务的底座，删除 orphan 更像运维/维护操作，不应和普通产品 API 处在同一权限面。当前判断仍依赖“当前 backend session store 中没有记录”，没有 owner/lease、最小年龄、内部权限、锁边界或人工审计。如果多 backend/不同 store 共享 socket、store 与 socket 生命周期不同步，或者用户手动 attach 了一个 Runweave session，仍可能误删有价值的任务。
- 具体文件 + 行号：
  - `backend/src/routes/terminal.ts:608`
  - `backend/src/routes/terminal.ts:625`
  - `backend/src/terminal/tmux-service.ts:309`
  - `docs/architecture/terminal-tmux-recovery.md:424`
- 更好的候选方案：
  - 方案 A：只保留 scan/log，删除能力改为本地维护 CLI 或测试 helper。
  - 方案 B：将删除接口迁移到 internal/admin 路由，并加入 owner token/lease、最小年龄、session-level lock、审计日志，且禁止 HTTP 参数启用 attached kill。
  - 方案 C：先以后台 dry-run + 指标观察一段时间，再评估是否引入自动 GC。
- 迁移/过渡风险说明：短期 orphan 需要手动清理，资源泄漏压力会高一点；但这比误杀长任务更可接受。

### P3 - wrapped URL provider 仍可能是重复造轮子

- 当前决策：保留 `WebLinksAddon`，同时注册 `createTerminalWrappedWebLinkProvider` 处理跨行 URL。
- 为什么它在系统层面可能是错的：`@xterm/addon-web-links` 当前实现已经会读取 wrapped lines 并映射跨行 URL range。新增 provider 又维护一套 URL regex、window scan 和坐标映射，长期需要追平 addon 的宽字符、空白、URL 校验、range mapping 行为。现有 E2E 证明“跨行链接能点”，但没有证明只用 WebLinksAddon 不能满足这个场景。
- 具体文件 + 行号：
  - `frontend/src/components/terminal-page.tsx:188`
  - `frontend/src/components/terminal/terminal-surface.tsx:620`
  - `frontend/src/features/terminal/web-link-provider.ts:3`
  - `node_modules/.pnpm/@xterm+addon-web-links@0.12.0/node_modules/@xterm/addon-web-links/src/WebLinkProvider.ts:58`
- 更好的候选方案：
  - 方案 A：先删除自研 provider，只保留 WebLinksAddon，跑现有 wrapped URL E2E；若通过则不需要新增实现。
  - 方案 B：如果 addon 确实有缺口，把失败场景收窄成一个明确测试，再只补该场景。
  - 方案 C：把缺口上游化，项目侧保留临时 shim 并写明删除条件。
- 迁移/过渡风险说明：删除 provider 后需要重新跑 wrapped URL E2E；如果 addon 已覆盖，风险低且维护面下降。

## 代码 / 实现发现

### P3 - orphan cleanup 响应由两次扫描拼装，竞态下语义不稳定

- 为什么这是风险：DELETE 路由先调用 `listOrphanedSessions` 生成 `orphanedSessions`，再调用 `killOrphanedSessions`，而后者内部又重新扫描一次。两次扫描之间如果 session 被创建、attach、detach 或清理，响应里的 `killed/skipped` 不是基于同一次决策快照，容易误导维护者。
- 具体文件 + 行号：
  - `backend/src/routes/terminal.ts:626`
  - `backend/src/routes/terminal.ts:628`
  - `backend/src/terminal/tmux-service.ts:313`
- 可执行修复方向：把“同一快照下筛选 killed/skipped 并执行 kill”的逻辑下沉到 `TmuxService`，返回 `{ killed, skipped }`；路由只负责入参和响应。

## 已改善点

- `logOrphanedTmuxSessions` 新增 `isAvailable()` 探测，tmux 不可用时只记录 skip，不再阻塞启动。
- orphan scan 命令失败会被捕获并记录，不再让 backend startup 失败。
- 新增 `tmux-orphan-scan.test.ts` 覆盖 tmux unavailable、scan failure、known tmux session name 三个关键场景。
- 目标 Playwright E2E 使用独立 tmux socket 目录，降低跨测试污染。

## 验证记录

- `pnpm --filter ./frontend typecheck`：通过。
- `pnpm --filter ./frontend lint`：通过。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./backend lint`：通过。
- `pnpm --filter ./backend test -- terminal.test.ts tmux-service.test.ts tmux-orphan-scan.test.ts`：实际执行 backend 全量 Vitest，56 files / 350 tests 通过。
- `pnpm --filter ./frontend exec playwright test tests/terminal-preview.spec.ts --grep "terminal sidecar browser keeps global tabs in web mode"`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 剩余风险 / 测试缺口

- 还没有“只用 WebLinksAddon，移除自研 wrapped provider”的对照验证。
- 还没有 orphan cleanup 两次扫描状态变化时的返回语义测试。
