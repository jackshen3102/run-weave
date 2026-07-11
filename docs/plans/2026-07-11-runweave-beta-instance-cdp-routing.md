# Runweave Beta 多实例与 CDP 路由实施计划

## 背景

Runweave 自身开发通常由 Stable 提供控制面，在隔离的 Beta 中验证最新源码。当前单 Beta 模型能够隔离 Stable 与 Beta，但仍有两个扩展性问题：

1. Beta Desktop CDP 与 Beta Terminal Browser CDP 是两个不同目标，当前状态和文档没有统一表达这一区别。
2. App 路径、userData、backend profile、App Server home、更新状态、Desktop CDP 端口和 status 文件都以单个 Beta 为前提，无法让两个 Agent 同时验证两个不同 revision。

CDP 选择必须由“被测 Beta 实例 + 被测 surface”决定，不能由 Agent 当前运行在哪个 Stable/Beta terminal 决定。

## 目标

1. 支持至少两个不同源码 revision 的 Beta 实例同时安装、启动、停止、更新、回滚和验证，彼此不覆盖状态。
2. 用稳定的 `instanceId` 标识被测 Beta；Agent 重启、换 terminal 或多人协作后仍可选择同一实例。
3. 明确区分 `desktop` 与 `terminal-browser` 两类 CDP surface，并通过实例状态实时发现 endpoint。
4. 提供不依赖 Stable 客户端版本的源码侧命令，让 `$toolkit:playwright-cli` 显式附着正确实例。
5. 多实例存在时禁止静默猜测目标；错误配置必须尽早失败并列出可选实例。
6. 保持现有单 Beta 命令可迁移，并保证 Stable App、profile、App Server、Terminal Browser 和 CDP 不受影响。

## 非目标

- 不把 Beta 变成远程或多人共享环境；本计划只覆盖同一台开发机上的本地实例。
- 不让两个实例共享 backend profile、App Server home、运行时指针、更新状态或 CDP Proxy。
- 不把 Desktop 原生 CDP 与 Terminal Browser CDP Proxy 合并成同一协议实现。
- 不新增单元测试文件；验证使用现有脚本、真实进程、`$computer-use` 和 `$toolkit:playwright-cli`。
- 不要求 Stable 客户端先升级才能发现或控制 Beta。

## 当前事实

- `scripts/runweave-beta.mjs` 的状态路径、App 路径和 App Server home 来自单例 `resolveBetaUpdateTargets()`。
- `electron/src/main.ts` 将 Beta Desktop remote-debugging endpoint 固定为 `127.0.0.1:9335`。
- 每个 Electron 实例还会启动独立 Terminal Browser CDP Proxy，并将其 endpoint 注入该实例 backend 和新建 terminal。
- 当前 `status.cdp` 只表示 Beta Desktop CDP，没有暴露 Terminal Browser CDP Proxy。
- `~/.playwright/cli.config.json` 和 `PLAYWRIGHT_MCP_CDP_ENDPOINT` 可以影响普通 `playwright-cli open`；它们描述执行环境，不能可靠表达本次被测实例。
- 当前 Beta builder 使用固定 `appId=com.runweave.desktop.beta`、`productName=Runweave Beta`，无法表达并行安装的不同 Beta 身份。

## 核心模型

### 1. 实例身份

引入显式 `instanceId`，规则如下：

- 格式：`^[a-z0-9][a-z0-9-]{0,31}$`。
- 身份属于被测 Beta，不属于 Agent、terminal session 或 Playwright session。
- 推荐由开发者按 worktree/任务命名，例如 `agent-a`、`pr-318`、`cdp-refactor`。
- 同一实例允许多个 Agent 协作；不同 revision 并行验证必须使用不同实例。
- 修改状态的命令以 `--instance <id>` 为最高优先级；已绑定 worktree 可从 gitignored 的 `.runweave/beta-instance.json` 读取默认值。
- 多个实例存在且无法唯一解析时必须报错并列出候选项，禁止选择最近启动或最低端口实例。

### 2. 实例隔离

每个实例至少独占以下资源：

| 资源                 | 建议身份                                                                       |
| -------------------- | ------------------------------------------------------------------------------ |
| App bundle           | `/Applications/Runweave Beta <instanceId>.app`                                 |
| bundle id            | `com.runweave.desktop.beta.<instanceHash>`                                     |
| userData             | `~/Library/Application Support/Runweave Beta/instances/<instanceId>/user-data` |
| backend profile      | `<userData>/browser-profile`                                                   |
| runtime/update state | `<userData>/runtime`、`<userData>/update`                                      |
| App Server home      | `~/.runweave/app-server-beta/<instanceId>`                                     |
| Desktop status       | `<userData>/desktop-status.json`                                               |
| update/rollback lock | 每实例独立 lock                                                                |
| Desktop CDP          | 动态分配并写入状态，不使用固定端口推导                                         |
| Terminal Browser CDP | 每实例独立 Proxy endpoint，并写入状态                                          |

不同实例可以并行更新；同一实例的并发更新、回滚和删除必须由实例 lock 串行化并返回明确冲突。

### 3. CDP surface

实例状态将现有单值 `cdp` 升级为：

```json
{
  "instanceId": "agent-a",
  "channel": "beta",
  "source": {
    "root": "/path/to/worktree-a",
    "revision": "<git sha>"
  },
  "cdp": {
    "desktop": {
      "endpoint": "http://127.0.0.1:<dynamic>",
      "healthy": true,
      "pid": 123
    },
    "terminalBrowser": {
      "endpoint": "http://127.0.0.1:<dynamic>",
      "healthy": true,
      "pid": 123,
      "targetCount": 0
    }
  }
}
```

语义固定：

- `desktop`：操作 `runweave://app/...` 的 Electron 主窗口，用于 Runweave 自身 UI 验收。
- `terminal-browser`：操作 Runweave 内嵌 Browser tab；需要隔离 Agent Control Group 时继续使用 group-scoped WebSocket endpoint。
- endpoint 只能从健康状态或明确的 scoped endpoint 读取，不能依赖 `9224 + n`、`9335 + n` 等端口算术。

### 4. 稳定触发方式

触发入口放在当前源码仓库，而不是依赖可能较旧的 Stable `rw` CLI：

```bash
pnpm runweave:beta:list --json
pnpm runweave:beta:status --instance agent-a --json
pnpm runweave:beta:cdp --instance agent-a --surface desktop --json
pnpm runweave:beta:cdp --instance agent-a --surface terminal-browser --json
```

`runweave:beta:cdp` 输出至少包含：`instanceId`、`surface`、`endpoint`、`pid`、`sourceRevision`、建议的 Playwright session name。它必须校验 endpoint 监听进程、实例 PID、channel、source revision 和目标页面身份。

日常附着使用显式 endpoint 和实例化 session：

```bash
playwright-cli -s=beta-agent-a-desktop attach --cdp="<resolved endpoint>"
```

后续可增加 `--attach` 便利模式，但解析和校验仍复用同一个状态入口。普通 `playwright-cli open` 不作为 Runweave 自身开发的验收入口。

## 兼容与迁移

1. 现有无 `--instance` 的 `runweave:beta:update/status/rollback` 在过渡期映射到 `default` 实例，并输出迁移提示。
2. 现有 `/Applications/Runweave Beta.app` 和 `~/Library/Application Support/Runweave Beta` 通过显式迁移命令转为 `default`；迁移前保留可回滚备份。
3. 新 CDP 命令不读取全局 `~/.playwright/cli.config.json` 作为目标选择依据；显式解析的 endpoint 必须覆盖错误的全局配置和 ambient env。
4. 不静默删除用户全局 Playwright 配置。文档给出备份和移除旧 `9224` 默认值的步骤，并在检测到它可能劫持 Runweave 验收时提示。
5. 状态 schema 增加版本；读取旧 schema 时只识别为 `default`，不得伪造不存在的 Terminal Browser endpoint。

## 实施任务

### 任务 1：定义实例与状态合约

修改范围：

- `scripts/runweave-update-core.mjs`：将 Beta 路径解析改为接收并校验 `instanceId`。
- `scripts/runweave-beta.mjs`：增加实例解析、registry、list/status 输出和 schema 迁移。
- `packages/shared/`：仅在 frontend/Electron/backend 都需要消费状态类型时增加纯数据合约；否则保留在脚本/Electron 边界，避免无实际调用方的共享抽象。

验收：两个实例解析出的所有可写路径不同；非法、空或超长 ID 在产生文件前失败；registry 使用原子写和 `0600` 权限。

### 任务 2：隔离构建、安装与生命周期

修改范围：

- `electron/electron-builder.beta.yml` 及构建脚本：按实例生成唯一 appId、productName、artifact/app path。
- `electron/src/main.ts`：在 `requestSingleInstanceLock()` 前解析实例，设置独立 userData、App Server home、profile 和状态路径。
- `scripts/runweave-beta.mjs`、`scripts/runweave-update.mjs`：更新、停止、回滚、健康检查和备份全部限定实例。

验收：两个不同 revision 可同时运行；更新/回滚 A 不改变 B 或 Stable 的文件、PID、状态和页面。

### 任务 3：拆分并发现两类 CDP

修改范围：

- `electron/src/main.ts`：动态分配 Desktop CDP，状态同时记录 Desktop CDP 与 Terminal Browser Proxy endpoint。
- `electron/src/terminal-browser-cdp-proxy*.ts`：保持每实例 Proxy，提供可归属验证的信息。
- `scripts/runweave-beta.mjs`：增加 `cdp --surface` 查询及 endpoint 归属、健康、target 身份验证。

验收：A/B 的两个 surface 共四个 endpoint 可唯一识别；端口占用时重新分配并更新状态，不回退到另一实例；stale endpoint 不得被返回为 healthy。

### 任务 4：提供 Agent 可重复使用的触发协议

修改范围：

- `package.json`：增加 `runweave:beta:list`、`runweave:beta:cdp` 等源码侧入口。
- `plugins/toolkit/skills/playwright-cli/` 或 Runweave 专属验证 skill：补充 Runweave 自身开发时的实例/surface 解析规则；不要修改通用 Playwright 命令语义。
- `docs/deployment/runweave-beta.md`：记录实例创建、发现、附着、并发和清理流程。

验收：Agent 只凭 `instanceId + surface` 即可附着；即使 shell 中存在错误的 `PLAYWRIGHT_MCP_CDP_ENDPOINT=9224`，也不会操作错误实例。

### 任务 5：迁移、诊断与清理

修改范围：

- `scripts/runweave-beta.mjs`：增加旧 default 迁移、stale registry 清理和实例级诊断输出。
- `docs/README.md`、部署和测试文档：更新唯一入口与风险说明。

验收：旧单 Beta 可迁移和回滚；崩溃实例保留可诊断状态但不会阻塞其他实例；删除实例只删除该实例拥有的路径。

## 错误处理与安全边界

- registry 和 status 不记录 token、Authorization、密码或 hook secret。
- endpoint 只允许 loopback 地址；非本机 endpoint 直接拒绝。
- 返回 endpoint 前交叉验证 PID、监听端口、app path、instanceId、channel 和 source revision。
- 同一实例已有 live desktop 时再次启动应聚焦该实例或明确拒绝，不得启动到另一实例 userData。
- registry 记录存在但 PID 已失效时标记 `stale`；只有显式 cleanup/delete 才删除实例数据。
- 实例删除、迁移和回滚必须验证路径仍位于该实例允许的根目录，沿用现有 Beta target isolation 的 fail-closed 原则。

## 风险与回滚

### 高风险点

- 动态 appId/productName 可能影响 macOS LaunchServices、签名、Dock 身份和 single-instance lock。
- 多 App Server 并行会增加端口、进程和磁盘占用。
- 全局 Playwright 配置与实例化路由并存时可能误连 Stable。
- registry 写入时序落后于 Electron/backend 启动会产生短暂 stale 状态。

### 回滚策略

- 保留 `default` 单实例兼容路径，功能开关关闭多实例后仍可使用现有 Beta 更新流程。
- schema 迁移前备份原状态和 App bundle；迁移失败不删除旧 Beta。
- 每个实例独立回滚，禁止用 A 的 previous release 恢复 B。
- 新 CDP resolver 失败时返回明确错误和原始 status 路径，不回退到全局 `9224`。

## 验证

完整用例见 `docs/testing/runweave-beta-instance-cdp-routing-test-cases.md`。

前置门禁：

```bash
pnpm typecheck
pnpm lint
pnpm runweave:update:test-cases
git diff --check
```

门禁通过后，必须实际执行：

- 两个不同 worktree/revision 的 Beta 并行更新、启动、状态查询和独立回滚。
- `$computer-use` 核对两个 Beta 窗口、标题、Dock/应用身份和 Stable 零中断。
- `$toolkit:playwright-cli` 分别附着 A/B Desktop 与 Terminal Browser，保存 target、DOM、source revision 和 endpoint 证据。
- 注入错误全局 CDP 配置、制造端口占用、崩溃和 stale registry，确认解析器 fail closed。

## 完成标准

- 两个 Agent 可同时用显式实例名验证两个不同 Beta revision，不共享任何可写运行状态。
- `instanceId + surface` 能唯一解析 CDP，且不会因为 Agent 所在 terminal 或全局 Playwright 配置而漂移。
- 旧单 Beta 有明确兼容、迁移和回滚路径。
- Stable 的 App、backend/profile、App Server、hooks/CLI、Terminal Browser 和 CDP 全程不被修改或重启。
- 配套测试用例全部执行通过并保留真实桌面、CDP、状态文件和进程证据。
