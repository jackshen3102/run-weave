# Toolkit Hook 入口

`runweave-hook-dispatch.cjs` 是 Toolkit 原生入口。
其余公共桥接脚本的权威源码位于 `packages/agent-bridge/hooks/`，本目录仅保留分发副本。
修改公共桥接时编辑权威源码，再从仓库根运行 `pnpm agents:build` 同步 Toolkit、Pi 和
Electron，使用 `pnpm toolkit:verify-hooks` 检查现有集成。
