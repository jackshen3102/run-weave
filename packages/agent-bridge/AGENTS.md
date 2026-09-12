# Agent Bridge

本包保存 Node 桥接实现；跨运行时 DTO 仍在 `packages/shared`。

- `hooks/` 是公共 Hook 资产的唯一源码；Toolkit 与 Electron 同名文件是兼容分发副本。
- `src/transport.ts` 负责原生扩展的顺序投递和进程回收，不决定 provider 生命周期。
- `src/install-pi.mjs` 是 CLI 与桌面共用的 Pi 安装器；保留托管文件备份与非托管文件保护。
- 改动后运行根目录 `pnpm agents:build`，同时交付生成的 Toolkit/Electron 资源。
- Electron 打包和 Toolkit 同步调用同一构建入口；不得增加另一套手工复制流程。

验证使用 `pnpm toolkit:verify-hooks`、相关消费者 typecheck 和
[Pi 端到端合同](../../docs/testing/terminal/runtime/pi-agent.testplan.yaml)。
边界说明见 [Pi Agent 接入](../../docs/architecture/pi-agent.md)。
