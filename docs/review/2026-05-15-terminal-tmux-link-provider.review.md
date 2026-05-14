# 2026-05-15 Terminal Tmux / Link Provider Review

评审范围：当前未提交工作区 diff，包含 backend terminal route / tmux service、frontend terminal link provider、Playwright E2E 配置与相关测试。

## 架构 / 策略发现

### P1 - tmux GC 直接执行 kill，缺少生命周期所有权和锁边界

- 当前决策：新增 `/api/terminal/tmux/orphans` 扫描/删除接口，并在 `TERMINAL_TMUX_CLEANUP_ORPHANS=true` 时于 backend 启动阶段直接调用 `killOrphanedSessions`。
- 风险：当前实现只用“当前进程内 session store 的 tmuxSessionName 集合”判断 orphan，然后逐个 `kill-session`。这和现有架构文档里的约束不一致：GC 应先记录日志/指标，且需要和 create/attach/delete 共用 session-level lock，首期甚至建议只做 backend 启动 dry-run。缺少锁、owner/lease、age threshold 或 attached client 防护时，如果两个 backend 共享同一 socket、store 尚未落盘、E2E 并发复用固定 socket，或者用户手动 attach 某个 Runweave tmux session，当前清理会把仍在使用的 terminal 直接杀掉。
- 证据：
  - `backend/src/index.ts:145-159` 构造当前进程 known session 集合并直接调用 kill。
  - `backend/src/index.ts:231-232` 在启动阶段启用即执行清理。
  - `backend/src/terminal/tmux-service.ts:296-315` `killOrphanedSessions` 对所有“不在 known set”的 session 直接 kill，没有 lock、owner、age 或 attachedClients 判断。
  - `docs/architecture/terminal-tmux-recovery.md:424-431` 明确要求先记录日志/指标、共用 lock，首期可只做 dry-run。
- 更好的候选方案：
  - 方案 A：先落 dry-run scan + structured log/metric，只暴露 scan endpoint，不暴露 delete endpoint；确认生产/测试中的 orphan 特征后再打开 kill。
  - 方案 B：保留清理能力，但加入 session-level lock、session owner token/lease、最小存活时间、attachedClients 防护，并只清理可证明属于当前 Runweave 实例的 session。
  - 方案 C：把 kill 做成离线维护命令或测试专用 helper，业务 backend 启动只做观测，避免用户请求路径和后台 GC 抢同一个 tmux 生命周期。
- 迁移/过渡风险：短期会多留一些 orphan tmux session，需要额外观测和手动清理；但风险是资源泄漏，而当前方案的风险是误杀用户长任务。建议先选择 A，再按指标进入 B。

### P2 - 为跨行 URL 全量替换 WebLinksAddon，扩大了解析和安全面

- 当前决策：`TerminalPage` 和 `TerminalSurface` 都移除 `@xterm/addon-web-links`，改为自研 `createTerminalWebLinkProvider` 处理所有 http(s) URL。
- 风险：原问题看起来只是“跨行 wrapped URL 不能点击完整链接”，但当前方案接管了全部 URL 解析、range 计算和激活行为。URL 识别、终端 buffer 坐标、换行/硬折行、标点裁剪和外链打开都属于安全/兼容边界，局部需求不宜用全量自研替换成熟 addon。现在新增正则和硬折行启发式已经出现“真实换行被拼接”的风险，后续还要持续追平 addon 的边界行为。
- 证据：
  - `frontend/src/components/terminal-page.tsx:181-197` 使用自研 provider 替换 WebLinksAddon。
  - `frontend/src/components/terminal/terminal-surface.tsx:595-607` 同样替换。
  - `frontend/src/features/terminal/web-link-provider.ts:3-218` 新增完整 URL 正则、window scan、range mapping 和激活逻辑。
- 更好的候选方案：
  - 方案 A：保留 WebLinksAddon 作为默认 provider，只为确认为 hard-wrap 的跨行 URL 增加一个窄 provider，避免重新实现常规 URL 解析。
  - 方案 B：如果必须自研，先把 provider 抽成可单测的纯函数并覆盖末尾标点、真实换行、full-width 字符、OSC link 共存、viewport scroll 后坐标等边界。
  - 方案 C：向上游 xterm addon 补 wrapped URL 行为，项目侧只保留临时 shim。
- 迁移/过渡风险：回退到 addon + 窄 provider 需要重新验证跨行点击；但长期维护面更小，且更符合“最小代码解决问题”。

## 代码 / 实现发现

### P2 - E2E backend 启动被 `TERMINAL_TMUX_CLEANUP_ORPHANS=true` 变成硬依赖 tmux

- 为什么这是风险：Runweave 的 terminal 设计允许 tmux 不可用时降级到 pty；但 Playwright webServer 现在无条件设置 `TERMINAL_TMUX_CLEANUP_ORPHANS=true`。backend 启动时会先调用 orphan cleanup，而 cleanup 直接执行 `tmux list-sessions`，没有先走 `isAvailable()` 或容错。只要 CI/本机没有 tmux，或 tmux socket/配置异常，backend 会在启动阶段失败，连 pty fallback 和非 tmux E2E 都跑不起来。
- 文件与行号：
  - `frontend/playwright.config.ts:20`
  - `backend/src/index.ts:231-232`
  - `backend/src/terminal/tmux-service.ts:263-292`
- 修复方向：启动 cleanup 前先 `await tmuxService.isAvailable()`，不可用时只记录 skip；`listSessions` 对 `ENOENT`/不可用错误返回明确 unavailable 而不是抛穿启动；E2E 只有在测试 tmux GC 时再启用 cleanup，常规 E2E 保持 pty fallback 可用。

### P2 - URL provider 会把真实换行后的文本拼进链接

- 为什么这是风险：`shouldJoinHardWrappedUrl` 只要上一行长度接近 `terminal.cols` 或上一行以 `-` 结尾，且下一行以 URL continuation 字符开头，就把两行拼接。当前 E2E 用两个 `print` 输出制造 `https://example.com/...-` + `wrapped-link`，这并不能证明它是终端硬折行；相反它把“真实换行后下一行文本”当作同一个 URL 的一部分。用户输出 `https://example.com/foo-` 后下一行出现 `rm`、路径或日志 token 时，点击第一行可能打开被拼接后的错误 URL。
- 文件与行号：
  - `frontend/src/features/terminal/web-link-provider.ts:200-208`
  - `frontend/tests/terminal-preview.spec.ts:871-892`
- 修复方向：只在 xterm buffer 明确 `line.isWrapped` 时跨行拼接；如果要处理“刚好满列触发的隐式 wrap”，应基于 buffer wrap 状态或更严格的列宽证据，不要用 `previousText.endsWith("-")` 拼真实换行。补一个反向 E2E/单元覆盖：第一行 URL 以 `-` 结束，第二行是普通文本，点击不应拼接第二行。

## 验证记录

- `pnpm --filter ./frontend typecheck`：通过。
- `pnpm --filter ./frontend lint`：通过。
- `pnpm --filter ./backend typecheck`：通过。
- `pnpm --filter ./backend lint`：通过。
- `pnpm --filter ./backend test -- terminal.test.ts tmux-service.test.ts`：实际执行 backend 全量 Vitest，55 files / 347 tests 通过。
- `pnpm --filter ./frontend exec playwright test tests/terminal-preview.spec.ts --grep "terminal sidecar browser keeps global tabs in web mode"`：通过。
- `git diff --check -- . ':(exclude)docs/review'`：通过。

## 剩余风险 / 测试缺口

- 没有看到 tmux cleanup 在 tmux 缺失、tmux server 异常、两个 backend 共享 socket、metadata 尚未落盘时的测试。
- 没有看到 link provider 对真实换行、OSC link 共存、宽字符 URL、标点裁剪、viewport scroll 后链接坐标的测试。
