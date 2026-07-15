# update-runweave-desktop 对 Computer Use 的依赖评审

## 结论

可以把 Computer Use 从常规升级流程的硬依赖改成条件式兜底，但不能只改技能文案。

现有 `pnpm runweave:update` 已经能在没有 Computer Use 的情况下完成规划、构建、退出旧客户端、安装 runtime 或完整 App、更新 App Server，并重新启动客户端。Computer Use 当前只承担升级后的桌面可见性与“进入终端页面”验收。

然而，现有 Stable 安装态没有由统一更新器稳定返回的 Electron 主窗口 CDP 身份。直接移除 Computer Use 后，升级动作仍能完成，但技能要求的最终 UI 完成条件无法可靠证明。

## 发现

- **P1 严重：不能直接删除 Computer Use 依赖，否则会把“进程已启动”误当成“客户端升级完成”。** 统一更新器的 `waitForInstalledAppStart()` 只检查 `/Applications/Runweave.app` 进程路径；技能却明确要求到达终端页面。两者之间没有机器可验证的主窗口就绪握手。影响是打包、替换、进程启动成功，但初始化错误、空白窗口、隐藏窗口或错误路由仍可能被报告为成功。定位：`plugins/toolkit/skills/update-runweave-desktop/SKILL.md:48`、`scripts/runweave-update-operations.mjs:58`、`scripts/runweave-update-operations.mjs:82`。修复方向：由统一更新器启动时声明临时 desktop CDP endpoint 和 status path，返回进程、版本、source revision、窗口可见性、主 renderer URL 等身份，再用 Playwright 显式附着验收。

- **P1 严重：技能里的 `9224` 降级路径不能替代 Electron 主窗口验收。** `9224` 是 Terminal Browser 自研 CDP proxy 的默认起始端口，并且端口冲突时会向后漂移；Stable 主 renderer 的 desktop CDP 默认是关闭的，只有显式设置 `RUNWEAVE_DESKTOP_CDP_PORT` 才会启用。因此连接 `http://127.0.0.1:9224` 既不保证端口身份，也不能证明主终端页面已经可见。定位：`plugins/toolkit/skills/update-runweave-desktop/SKILL.md:56`、`electron/src/terminal-browser-cdp-proxy-port.ts:3`、`electron/src/terminal-browser-cdp-proxy-port.ts:53`、`electron/src/desktop-config.ts:63`。修复方向：不要复用 Terminal Browser proxy 作为主窗口证据；为本次升级分配独立 desktop CDP endpoint，并校验 PID、App 路径、版本和 source revision。

- **P2 一般：升级执行与桌面验收应解耦，Computer Use 只保留在原生系统边界。** 当前技能把所有桌面 UI 检查统一绑定到 Computer Use，但页面 DOM、路由点击、终端输入框、可见 viewport 更适合 Playwright/CDP。Computer Use 真正不可替代的是 Finder、Dock、原生菜单、macOS 权限弹窗、Gatekeeper/TCC 等 CDP 看不到的系统表面。定位：`plugins/toolkit/skills/update-runweave-desktop/SKILL.md:12`、`plugins/toolkit/skills/update-runweave-desktop/SKILL.md:40`。修复方向：常规成功路径固定为 CLI 更新 + desktop CDP/Playwright；仅在出现原生弹窗、窗口无法激活、菜单级场景或 CDP 与窗口状态矛盾时调用 Computer Use。

## 建议的最小闭环

1. `pnpm runweave:update --dry-run` 决定 runtime、app 与 App Server action。
2. `pnpm runweave:update` 完成构建、替换、App Server 切换和重启；升级器自身负责干净启动环境。
3. 升级器为本轮启动分配 desktop CDP endpoint 和 status path，并输出结构化身份：App 路径、PID、版本、source revision、backend/runtime release、App Server release、窗口可见状态。
4. Playwright 显式附着该 desktop endpoint，进入或恢复终端路由，并断言：主 renderer URL 属于 Runweave、`document.visibilityState === "visible"`、viewport 非零、终端工作区和输入区可交互。
5. CDP 不可用、身份不一致、窗口不可见或出现原生系统交互时，才切换到 Computer Use；不能静默把进程检查当作 UI 通过。

## 方案权衡

| 方案                                            | 改动 | 常规升级无需 Computer Use | 能证明主窗口终端页 | 原生弹窗覆盖 |
| ----------------------------------------------- | ---- | ------------------------- | ------------------ | ------------ |
| 仅删除技能中的 Computer Use 文案                | 很小 | 是                        | 否                 | 否           |
| 保持现状                                        | 无   | 否                        | 是                 | 是           |
| CLI + 身份化 desktop CDP，Computer Use 条件兜底 | 中等 | 是                        | 是                 | 仅兜底时覆盖 |

推荐第三种。它把常规路径变成确定性的机器闭环，同时没有假装 CDP 能覆盖 macOS 原生 UI。

## 残余风险与待确认项

- 如果“整个客户端升级完成”的定义必须包含 Gatekeeper、TCC、原生菜单或 Finder 启动体验，Computer Use 不能完全删除，只能降为条件式验收。
- 如果完成定义只要求 `/Applications/Runweave.app` 已替换、目标 runtime/App Server 已生效、真实主 renderer 可见且终端页可交互，则不需要 Computer Use。
- 本次为只读评审；未修改技能或更新器，未执行实际升级。
