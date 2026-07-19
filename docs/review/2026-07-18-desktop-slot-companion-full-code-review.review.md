# Desktop Slot Companion 完整 staged diff 代码审查

## 结论

未通过。完整 staged diff 存在 2 个未修复 P1，分别阻断 Slot 打开/退役握手与 macOS 打包态 Companion 路由；另有 2 个 P2 规格偏差。未发现 P0。

## Findings

### P1：在目标 Session/Panel/Agent Team 表面打开前已确认 Completion 并回报成功

`frontend/src/App.tsx:353` 先用列表确认 Session id 存在，但没有先导航并等待 Terminal workspace 选中目标 Session；随后在 `frontend/src/App.tsx:364` 写入 `acknowledgedCompletionRevision`，在 `frontend/src/App.tsx:369` 回报 `opened`，直到 `frontend/src/App.tsx:374` 才修改路由，并在 `frontend/src/App.tsx:380` 才打开 Agent Team 二路窗。这与计划明确冻结的“导航并等待 Session → Panel/二路窗 → Completion ack → result”顺序（`docs/plans/2026-07-18-desktop-slot-companion.md:393`、`:416`）相反。

影响：renderer 在 ack 后、导航前失败时 Completion 已永久退役；Terminal/Agent Team failed Slot 也可能在目标表面尚未打开时收到成功结果并写入 failure seen。直接违反 DSC-005、DSC-006、DSC-007。

修复方向：把 intent 交给 Terminal workspace 的现有 Session 选择链，等待目标 Session 实际选中；随后执行可靠 Panel focus 和可选 Agent Team sidecar 打开；最后才写精确 completionRevision 并回报成功。任何一步失败都必须返回失败且不写退役状态。

### P1：打包态在 renderer 启动后才切换 Companion 路由，Beta badge 会永久留在小窗口

`electron/src/desktop-companion-window.ts:55` 先加载 `runweave://app/index.html`，仅在 `loadURL()` 完成后于 `:56-58` 执行 `history.replaceState`。因此打包态首次执行 `frontend/src/main.tsx:8` 时 pathname 仍是 `/index.html`，Beta 构建会在 `frontend/src/main.tsx:37` 把 badge 追加到 body；之后切换路由不会重新执行或清理这段启动代码。

影响：macOS Beta 打包产物的 Companion 必然带 Beta badge，也不满足“路由在登录重定向前识别”的启动合同，直接违反 DSC-012。

修复方向：让 Companion 身份在 renderer bootstrap 前可判定，例如让自定义协议直接以 Companion 路径加载同一 index，或使用独立、启动前可读的窗口标识；不要在页面加载完成后再补路由。

### P2：Companion 全局 CSS 会污染主窗口

`frontend/src/components/desktop-companion/desktop-companion.css:1-3` 使用全局 `:root` / `body` 且带 `!important`，而该组件被 `App.tsx` 静态导入，CSS 会进入所有 renderer 的同一 bundle。主窗口的 body 背景和 overflow 因此也被覆盖。

修复方向：在 Companion 启动时给 `html/body` 增加窗口专属 class/data attribute，并将样式限定在该标识下，或拆成不会被主窗口入口加载的独立样式入口。

### P2：计划承诺的 Terminal event 即时刷新未实现

`frontend/src/features/attention/use-attention-snapshot.ts:24-44` 只有 4 秒轮询，没有 Terminal events WebSocket 订阅或 invalidate。与 `docs/plans/2026-07-18-desktop-slot-companion.md:283-287` 不一致，Completion/failed/working 最多延迟约 4 秒出现或退役。

修复方向：复用现有 Terminal events 订阅，在相关结构化事件到达时触发一次受 AbortController 保护的 refresh，同时保留 4 秒兜底轮询。

## 审查范围与证据

- `scope=full`
- `baseCommit=0a92b516f788dcc01d44faa78ff730ab77f56d05`
- `targetCommit=null`
- `targetTree=1b4e11f0c2eed548c3a331d9f6a5462d064dd286`
- `git write-tree` 精确等于 targetTree；25 个 staged 路径与 reviewTarget 完全一致。
- 计划 SHA-256：`1c4eeeb36c49570ee459118dd194fe1b680aedebb92cbfca485cb53e34216b71`
- 测试计划 SHA-256：`768070690bb15bb3f6536160a29442dc3252d012ea352baa99ae2776481b660f`
- `git diff --cached --check`：通过。
- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm testplan:validate docs/testing/platform/desktop-slot-companion.testplan.yaml`：通过，12 个 required cases。
- 静态 route harness：确认 packaged load 发生在 route replacement 之前，且 badge append 只受初始 pathname 判断。
- 静态 open-order harness：确认 ack 与 success result 均早于 route navigation，success result 也早于 Agent Team sidecar 打开。

本轮是代码审查，未执行 macOS 真实桌面行为验收；这不影响以上由 staged source 控制流直接确认的结构性结论。
