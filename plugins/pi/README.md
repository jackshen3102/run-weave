# Runweave Pi 插件

Pi 原生扩展和 `runweave` skill 的独立入口。完整运行合同见
[Pi Agent 接入](../../docs/architecture/pi-agent.md)。

在仓库根目录执行：

```bash
pnpm agents:build
pnpm pi:install
```

`agents:build` 生成 `dist`，可将整个目录复制到仓库之外；不能只复制扩展入口而遗漏
`bridge`。原生 Pi package manifest 指向生成目录，使用 `pi install` 前也需先构建。
`pi:install` 安装到已有的 `~/.pi/agent`，或 `PI_CODING_AGENT_DIR` 指定目录。
已有 Pi 进程执行 `/reload` 后生效。

修改 `extensions/runweave.ts` 和 `skills/runweave/SKILL.md`；公共桥接修改
`packages/agent-bridge`。不要手工修改 `dist` 或 Electron 生成副本。
