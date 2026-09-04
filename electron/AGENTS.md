# Electron 桌面端

`electron/` 是 macOS 桌面壳，负责窗口、内嵌 Terminal Browser、IPC/preload、后端进程、
更新和桌面级诊断。

## 先看哪里

- 主进程装配：`src/main.ts`
- Renderer bridge：`src/preload.ts`
- Bridge 类型合同：`../packages/shared/src/desktop/bridge.ts`
- 主窗口与自定义协议：`src/desktop/window.ts`
- 内置 Backend 生命周期：`src/backend/packaged/controller.ts`
- Terminal Browser：`src/browser/`
- 打包配置：`electron-builder.yml`、`electron-builder.beta.yml`

## 边界

- Renderer 可用能力必须通过 `preload.ts` 暴露的窄 IPC bridge；不要开启 Node integration，
  也不要让 `frontend/` 直接导入 Electron 主进程模块。
- Electron 与其他运行时共享的 IPC payload、状态和协议进入 `packages/shared`。
- Terminal Browser 的 tab、BrowserView、CDP proxy 和网络策略属于主进程；Web 前端只消费 bridge。
- 默认只验证和打包当前 mac 客户端，不新增 Windows 打包工作。
- 更新、Stable/Beta/Dev Session 的真实边界从
  `../docs/deployment/README.md` 和 `../docs/architecture/README.md` 进入。

## 验证

```bash
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/electron lint
pnpm dist:electron:mac
```

仅文档或类型边界改动不默认执行完整打包；需要真实桌面验收时遵守根 `AGENTS.md` 的
Dev Session、CDP surface 与清理门禁。
