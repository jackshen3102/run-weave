# 2026-05-15 Terminal Tmux / Link Provider Re-Review

评审范围：用户优化后的当前未提交工作区 diff，不包含既有 `docs/review` 报告文件。重点复核上次发现的 tmux orphan 清理边界和 terminal wrapped URL link provider。

## 架构 / 策略发现

### P2 - tmux orphan 删除能力仍暴露在通用 API，生命周期所有权边界偏弱

- 当前决策：启动阶段已从自动 kill 改成 scan/log，这是正确收敛；但仍保留 `DELETE /api/terminal/tmux/orphans?confirm=true`，由普通 terminal API 直接触发 orphan kill，且 `includeAttached=true` 可以显式杀 attached session。
- 为什么它在系统层面可能是错的：tmux session 是“用户长任务保活”的底座，清理策略应该是运维/维护能力，而不是常规产品 API。当前接口只用当前 backend 的 session store 生成 known set，再按 tmux server 当前状态清理；如果多 backend/不同 store 共享 socket、旧 backend 退出后用户手动 attach、或 store 与 socket 生命周期不同步，仍可能把对用户有价值的 detached session 当 orphan 删除。`confirm=true` 降低误触发，但没有解决所有权、lease、age threshold、内部权限和锁边界。
- 具体文件 + 行号：
  - `backend/src/routes/terminal.ts:608-633`
  - `backend/src/terminal/tmux-service.ts:309-324`
  - `docs/architecture/terminal-tmux-recovery.md:424-431`
- 更好的候选方案：
  - 方案 A：只保留 `GET /tmux/orphans` scan/log；删除能力改为本地维护 CLI 或测试 helper，不进入通用 HTTP API。
  - 方案 B：保留 HTTP 删除，但放到 internal/admin 路由，并加入 owner token/lease、最小年龄、session-level lock 和默认禁止 attached kill 的硬约束。
  - 方案 C：由后台 GC 周期性 dry-run + 指标观察，达到明确误删保护后再分阶段启用自动清理。
- 迁移/过渡风险：短期会留下更多 orphan tmux session，需要手动清理；但这个风险小于误删用户长任务。推荐先落 A 或 B，再根据观测决定是否自动化。

### P3 - wrapped URL provider 仍在重复实现 WebLinksAddon 已有能力

- 当前决策：优化后已恢复 `WebLinksAddon`，再额外注册 `createTerminalWrappedWebLinkProvider` 只处理跨行链接。
- 为什么它在系统层面可能是错的：`@xterm/addon-web-links` 当前实现本身会读取 wrapped buffer lines 并把跨行内容映射回 buffer range；新增 provider 复制了 URL regex、window scan 和 range mapping，长期需要追平 addon 对宽字符、空白、URL 校验和坐标映射的边界。并且 provider 注册在 WebLinksAddon 之后，xterm 会按 provider 顺序选择 link，新增 provider 实际只在 addon 不返回 link 时生效；现有 E2E 只证明“最终能点”，没有证明 addon 原本不能满足需求。
- 具体文件 + 行号：
  - `frontend/src/components/terminal-page.tsx:188-209`
  - `frontend/src/components/terminal/terminal-surface.tsx:620-633`
  - `frontend/src/features/terminal/web-link-provider.ts:3-181`
  - `node_modules/.pnpm/@xterm+addon-web-links@0.12.0/node_modules/@xterm/addon-web-links/src/WebLinkProvider.ts:58-100`
- 更好的候选方案：
  - 方案 A：先删除自研 provider，只用 WebLinksAddon，并保留当前 wrapped URL E2E；如果测试通过，就不需要新增实现。
  - 方案 B：如果确有 addon 覆盖不了的 case，先把失败用例收窄成注释和测试，再只补那个 case。
  - 方案 C：向上游 addon 修复，项目侧保留短期 shim，并设删除条件。
- 迁移/过渡风险：删除 provider 后需要重新跑 wrapped URL E2E；如果 addon 已覆盖，风险很低，代码量和维护面会下降。

## 代码 / 实现发现

### P2 - E2E backend 启动仍因 orphan scan 硬依赖 tmux 可用

- 为什么这是风险：`frontend/playwright.config.ts` 无条件设置 `TERMINAL_TMUX_SCAN_ORPHANS_ON_START=true`，backend 启动时会调用 `logOrphanedTmuxSessions`，而该函数直接执行 `tmux list-sessions`。如果 CI 或开发机没有 tmux，或者 tmux socket/config 初始化异常，backend 会在启动阶段失败，pty fallback 的设计无法生效。优化后已经不再误 kill，但“无 tmux 时无法跑常规 E2E”的风险仍在。
- 具体文件 + 行号：
  - `frontend/playwright.config.ts:20`
  - `backend/src/index.ts:139-145`
  - `backend/src/index.ts:234-235`
  - `backend/src/terminal/tmux-service.ts:267-297`
- 可执行修复方向：启动 scan 前先 `await tmuxService.isAvailable()`；不可用时只记录 skip。或者常规 Playwright webServer 不设置 `TERMINAL_TMUX_SCAN_ORPHANS_ON_START`，只在专门验证 tmux GC 的 E2E 中开启。

### P3 - orphan cleanup 响应基于两次 scan，竞态下 killed/skipped 可能不一致

- 为什么这是风险：DELETE 路由先 `listOrphanedSessions` 得到 `orphanedSessions`，随后 `killOrphanedSessions` 内部又重新 scan 一次。两次 scan 之间如果 session 被创建、attach、detach 或清理，响应中的 `skipped` 是第一轮快照减去第二轮 killed，不能准确描述本次实际决策。这个问题不一定造成误删，但会让运维/测试判断错误。
- 具体文件 + 行号：
  - `backend/src/routes/terminal.ts:626-639`
  - `backend/src/terminal/tmux-service.ts:313-324`
- 可执行修复方向：把“基于同一快照筛选 killed/skipped 并执行 kill”的逻辑下沉到 `TmuxService`，返回同一次决策的 `{ killed, skipped }`；路由不要自己拼两次扫描结果。

## 已改善点

- 启动阶段从 `killOrphanedSessions` 改为 `listOrphanedSessions` + log，已消除上次最严重的“启动即误杀”路径。
- 默认 cleanup 跳过 `attachedClients > 0` 的 orphan，并要求 `confirm=true`，比上一版更保守。
- 前端恢复了 `WebLinksAddon`，没有继续用自研 provider 接管所有 URL。

## 验证记录

- `pnpm --filter ./frontend typecheck`：通过。
- `pnpm --filter ./frontend lint`：通过。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./backend lint`：通过。
- `pnpm --filter ./backend test -- terminal.test.ts tmux-service.test.ts`：实际执行 backend 全量 Vitest，55 files / 347 tests 通过。
- `pnpm --filter ./frontend exec playwright test tests/terminal-preview.spec.ts --grep "terminal sidecar browser keeps global tabs in web mode"`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 剩余风险 / 测试缺口

- 缺少“tmux 不存在时，E2E/backend 启动仍可降级或跳过 scan”的测试。
- 缺少“只用 WebLinksAddon 是否已满足 wrapped URL”的对照验证。
- 缺少 orphan cleanup 在两次 scan 状态变化时的返回语义测试。
