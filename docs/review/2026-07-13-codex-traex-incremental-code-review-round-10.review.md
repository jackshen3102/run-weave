# Codex / TraeX capability parity 增量代码复审（Round 10）

## 结论

`case_14` **PASS**。本轮以 index tree `f0e9d9fc17eea8809a3651ac6614221114bc04f0` 为唯一审查对象，完整阅读相对 `dc3929aecb8791439d964d30c0580f5d95e47fca` 的 12 个 staged path，并检查 Hook 资源选择、开发态/安装态 Backend、tmux/PTY terminal、Electron 打包、更新规划及既有身份消费者。未发现仍开放的 P0/P1。

## Review checkpoint

- scope: `incremental`
- base commit / HEAD: `dc3929aecb8791439d964d30c0580f5d95e47fca`
- target tree / index: `f0e9d9fc17eea8809a3651ac6614221114bc04f0`
- requestedAt: `2026-07-13T06:42:52.277Z`
- staged paths: 12 个，与 prompt 和 run package 完全一致
- `git diff --cached --check`: 通过

## 增量审查结论

- 开发态 `createBackendEnv()` 先清除可能继承的 stale `RUNWEAVE_TOOLKIT_PLUGIN_ROOT`，再按实际 `sourceRoot` 固定为 `electron/resources`；dedicated Backend 显式传入隔离 source root。
- 安装态把 `electron/resources/hooks` 外置复制到 `Contents/Resources/runweave-hook-runtime/hooks`；packaged Backend 无论使用 bundled、active external 或 rollback runtime release，都使用当前 Electron shell 的 Hook root，不把 Hook 版本错误绑定到 external runtime manifest。
- `runtime-launcher` 将该 root 传入新建 tmux session 与 PTY terminal；Hook command 因而优先执行当前 source/shell 同源 bridge，而不是 provider 缓存中的旧副本。
- 外置 Hook root 不包含 `.codex/.trae/.claude` 路径语义时，bridge 只在 source 为 `unknown` 时按当前 pane 的精确 command basename 恢复 provider；`trae/traecli/traex` 归一为 `trae`，`codex/claude` 保持各自 provider，其他命令不猜测。
- 当前 pane 的 `@runweave_panel_id` 仍覆盖继承的 stale panel env；App Server scope/payload 与 Backend terminal metadata 继续消费同一真实 panel/thread/tmux pane。
- Electron resource 与 Toolkit 的 Hook 资产 fixture 保持逐文件一致；Hook resource 路径继续命中 app-sensitive 更新分类，要求 full App/Beta 更新。

## Resolved findings 回归

- **Hook root 版本漂移**：已修复。真实失败中的 pane option/threadId 原本正确，错误来自 TraeX provider cache 的旧 bridge；当前 source/shell root 现在在 Backend → terminal → Hook resolver 全链路优先。
- **stale panel env 跨 pane 归属**：保持修复。Hook fixture 使用 stale panel env 与 pane-local `panel-pane-3`，App Server 与 Backend 最终都记录 `panel-pane-3`。
- **外置 root provider 丢失**：已修复。不存在的旧 Trae/Claude plugin root 与未设置 `RUNWEAVE_HOOK_SOURCE` 时，fixture 仍分别得到 `trae` 与 `claude`。
- **跨 provider、lifecycle/fallback 消费端回归**：未回退。Hook fixture、App Server state-sync 与 review checkpoint verifier 均通过。

## 已执行检查

- `pnpm toolkit:verify-hooks`: 通过。
- `pnpm runweave:update:test-cases`: 18/18 通过。
- `pnpm typecheck`: 通过。
- `pnpm lint`: 通过。
- `pnpm app-server:verify-state-sync`: 通过。
- `pnpm agent-team:verify-review-checkpoints`: 21 项检查通过。
- 安装态 env 独立 harness: stale base env 被 `/Applications/Runweave.app/Contents/Resources/runweave-hook-runtime` 覆盖。
- `pnpm dev:session:verify`: 首次与其他 4 个 pnpm 门禁并发运行时，在未改动的 `verify-registry.mjs:433` 得到 `undefined !== 5`。该 fixture 用固定 100ms 假设 status 子进程已进入 session lock；并发调度下子进程启动晚于锁释放，正常读取 `stopped` 后返回 0。随后在同一 targetTree 上独立串行连续 4 次均返回 `ok=true`、22 checks 全过；本轮新增的 source-root env 断言也通过。因此记录为 fixture 调度竞态，不判为产品或本增量阻断。

本轮只新增此 review 文档与 pane outbox；未修改源码、测试、Git index 或 HEAD。
