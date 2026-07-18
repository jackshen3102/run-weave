# Terminal Browser per-tab displayScale 第 1 轮代码审查

## 结论

AGT-REVIEW-GATE 不通过。本轮独立审查确认 1 个仍开放的 P1：同一 Tab 的缩放请求虽然声明通过主进程队列串行化，但“目标 factor 等于当前已提交值”的请求会在进入队列前直接成功返回。较早的异步请求随后仍可提交，导致后发成功请求被覆盖。

审查边界为 `HEAD 11677eb` 加当前 Terminal Browser displayScale 工作区 patch；实现源码 patch 指纹（不含本审查报告与 outbox）为 `0b1300caa512eba80d798a0dedabd688a04e2305847bbac6e28cb6e52464c58c`。

## 阻断发现

- **P1 — 后发 reset 可成功返回 100%，随后却被先发 80% 请求覆盖。** `setTerminalBrowserDisplayScale` 在进入 `metricsMutationQueue` 前执行 `entry.displayScale === factor` 短路。review harness 让首个 80% 请求停在 metrics sender，再发 reset(100%)：reset 立即返回 `{ factor: 1 }`，释放首请求后最终 `entry.displayScale` 为 `0.8`，实际命令列表也只有 `scale=0.8`。这违反计划中“最后一个成功请求生效”和“并发设置按队列顺序 last-success-wins”的冻结规则，也使 TBZ-002 的 `Runweave.resetDisplayScale` 成功结果与最终页面/UI 状态不一致。定位：`electron/src/terminal-browser-display-scale.ts:194-226`；产品契约：`docs/plans/2026-07-18-terminal-browser-per-tab-display-scale.md:23-29,48-59,156-162`；Case：`docs/testing/terminal/terminal-browser-display-scale.testplan.yaml:24-37`。修复方向：把同值 no-op 判断移入 per-entry mutation queue，在所有先发请求完成后基于最新已提交值判断，并保证响应与 tab update 反映该串行位置的最终提交；修复后用相同并发 harness 及真实 TBZ-002 page-session set/reset 流程复核。

## 独立检查

- `node --experimental-strip-types --input-type=module -e '<displayScale concurrency review harness>'`：exit 0；输出 `resetResult.factor=1`、`factorWhenResetReturned=1`、`firstResult.factor=0.8`、`finalFactor=0.8`、`calls=[{method:"Emulation.setDeviceMetricsOverride",scale:0.8}]`。
- `pnpm typecheck`：exit 0。
- `pnpm lint`：exit 0。
- `pnpm architecture:check`：exit 0，`over600=0`、`runtimeCycles=0`、`forbiddenImports=0`、`sharedRootImports=0`。
- `pnpm testplan:validate docs/testing/terminal/terminal-browser-display-scale.testplan.yaml`：exit 0，6 条 required case。
- `git diff --check`：exit 0。

## 验证边界

本 reviewer 未启动 Dev Session，也未执行 Playwright/Electron 真实产品验收；TBZ-001～TBZ-006 的真实行为验证由本 run 已分配的 `behavior_verify` worker 独立负责。本轮 P1 是调用真实 `setTerminalBrowserDisplayScale` 的可执行结构化复现，不把静态门禁或代码阅读冒充产品运行时验收。
