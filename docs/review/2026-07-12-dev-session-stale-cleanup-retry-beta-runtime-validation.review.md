# Dev Session Stale Cleanup Retry Beta Runtime Validation

## Conclusion

此前关于 “`betaControl` 路径会让 `cleanup-stale` 永远不收敛” 的判断，经过真实运行态验证，**未能复现**。按实际执行结果，这条路径当前不是可证实的 bug。

## Runtime Validation

1. 真实启动 `beta` Dev Session：`pnpm dev:session --profile beta --json`，得到 `devSessionId = dvs-a85ed9`，manifest 进入 `state = "ready"`。
2. 人工篡改 `beta-desktop-status.json` 的 `sourceRevision`，仅制造 Electron status identity drift，不杀进程。
3. 运行 `pnpm dev:status --session dvs-a85ed9 --json`：
   - session 真实进入 `state = "stale"`
   - `services.electron.health = "stale"`
   - `services.electron.healthFailureReason = "Electron status identity drifted"`
4. 第一次运行 `pnpm dev:stop --session dvs-a85ed9 --cleanup-stale --json`：
   - `frontend/backend/appServer` 被停止
   - `electron.cleanupStatus = "skipped-stale-identity"`
5. 第二次再次运行同命令：
   - 返回 `state = "stopped"`
   - **没有再次进入 cleanup**
   - manifest 保持 `electron.cleanupStatus = "skipped-stale-identity"`
   - 由于 Electron 进程在第一次 cleanup 后已不再存活，第二次不会被选入 `retryServiceNames`

## Why The Hypothesis Failed

- 实际运行中，第一次 `cleanup-stale` 后 Electron 进程已经退出。
- 第二次 `stop --cleanup-stale` 的重试筛选要求 `cleanupStatus === "skipped-stale-identity"` 且 `processIdentityMatches(service.process)` 仍为真。
- 由于进程已退出，这个条件不成立，命令直接走 stopped-session 的 no-op 返回，而不是再次进入重试分支。

## Evidence Summary

- `pnpm dev:session --profile beta --json`：成功，session `dvs-a85ed9`
- `pnpm dev:status --session dvs-a85ed9 --json`：成功把 session 打成 stale，且仅 `electron` stale
- 第一次 `pnpm dev:stop --session dvs-a85ed9 --cleanup-stale --json`：`cleanup.stoppedServices = ["frontend","backend","appServer"]`，`cleanup.skippedStaleServices = [{ service: "electron", reason: "Electron status identity drifted" }]`
- 第二次相同命令：返回 stopped manifest，无新的 cleanup 执行

## Check Scope

- `scripts/dev-session/cli.mjs`
- `scripts/dev-session/services.mjs`
- `scripts/dev-session/service-runtime.mjs`
- `scripts/dev-session/beta-service.mjs`
- 真实运行态 `beta` Dev Session：`dvs-a85ed9`

## Outcome

- 这条问题在真实运行态下**未复现**。
- 因此它当前**不能作为 bug 成立**。
