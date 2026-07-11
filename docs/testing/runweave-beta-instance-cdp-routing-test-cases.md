# Runweave Beta 多实例与 CDP 路由测试用例

## 范围

本文档验证两个或更多 Beta 实例并行运行时的身份、状态、生命周期和 CDP 路由隔离，覆盖：

1. `instanceId` 与实例路径解析。
2. 两个不同 revision 的 Beta 并行启动、更新和回滚。
3. Desktop 与 Terminal Browser 两类 CDP 的发现、归属和附着。
4. Agent terminal、全局 Playwright 配置和动态端口变化不会导致目标漂移。
5. 旧单 Beta 的兼容迁移和 Stable 零中断。

不覆盖跨机器远程 CDP、多用户权限系统和云端 Beta 调度；这些能力不属于本地开发实例范围。

## 前提事实

- 当前单 Beta 路径由 `scripts/runweave-beta.mjs` 和 `scripts/runweave-update-core.mjs` 管理。
- Beta Desktop CDP 与 Terminal Browser CDP Proxy 是不同 surface。
- 浏览器页面取证必须使用 `$toolkit:playwright-cli`；桌面窗口和系统应用身份使用 `$computer-use`。
- 仓库不新增单元测试文件；协议和路径规则通过现有或新增 verify 脚本验证。
- 测试使用两个独立 worktree，分别记为 `<worktree-a>`、`<worktree-b>`，实例名为 `agent-a`、`agent-b`。

## 必跑命令

按顺序执行，任一失败即停止：

```bash
pnpm typecheck
pnpm lint
pnpm runweave:update:test-cases
pnpm runweave:beta:verify
git diff --check
```

## 用例映射

- `BIC-001`：合法、非法和边界 instanceId。
- `BIC-002`：两个实例的全部可写路径互斥。
- `BIC-003`：两个不同 revision 同时运行。
- `BIC-004`：同一实例并发更新被实例 lock 拒绝。
- `BIC-005`：不同实例可并发更新且不串扰。
- `BIC-006`：A 的更新和回滚不改变 B 与 Stable。
- `BIC-007`：每个实例同时暴露 Desktop 与 Terminal Browser CDP。
- `BIC-008`：`instanceId + surface` 唯一选择目标。
- `BIC-009`：错误全局 CDP 配置不能劫持实例路由。
- `BIC-010`：动态端口占用时重新分配且不串实例。
- `BIC-011`：stale registry 和失效 PID fail closed。
- `BIC-012`：多个实例存在但未指定实例时拒绝猜测。
- `BIC-013`：Beta terminal 环境只指向所属实例的 Terminal Browser Proxy。
- `BIC-014`：group-scoped endpoint 不暴露其他实例或 group。
- `BIC-015`：旧单 Beta 迁移为 default 后可继续使用和回滚。
- `BIC-016`：删除一个实例只清理其拥有资源。
- `BIC-017`：状态、日志和 registry 不泄露秘密。
- `BIC-018`：Agent 重启或换 terminal 后可重新选择同一实例。

## 用例细则

### BIC-001 合法、非法和边界 instanceId 在写文件前得到确定结果

- 设计技术：等价类、边界值。
- 验证方式：自动化脚本。
- Given：实例解析命令可用，测试根目录为空。
- When：分别传入 `a`、32 字符合法 ID、空值、大写、含 `/`、含空格、以 `-` 开头和 33 字符 ID。
- Then：合法值稳定解析；非法值返回非零状态和具体规则；测试根目录没有产生 App、状态、lock 或 registry 文件。
- 失败判断：非法 ID 被截断/改写后继续，或失败前产生任何实例文件。

### BIC-002 两个实例的全部可写路径互斥

- 设计技术：判定表。
- 验证方式：自动化脚本。
- Given：解析 `agent-a`、`agent-b` 的实例目标。
- When：导出两份路径和身份 JSON。
- Then：app path、appId、userData、profile、runtime、update state、backup、App Server home、status 和 lock 均不同，且都不等于 Stable 路径。
- 失败判断：任一可写路径、bundle identity 或 lock 被共享。

### BIC-003 两个不同 revision 的 Beta 可同时运行

- 设计技术：场景、并发。
- 验证方式：自动化脚本 + `$computer-use`。
- Given：`<worktree-a>`、`<worktree-b>` 位于不同 revision，Stable 正常运行。
- When：分别更新并启动 `agent-a`、`agent-b`，读取 list/status。
- Then：两个 Desktop、backend、App Server 均 healthy；source root/revision 正确；两个窗口标题能区分实例和 revision；Stable 未退出或重启。
- 失败判断：后启动实例替换前一 App、复用 PID/profile，或 Stable 出现中断。

### BIC-004 同一实例并发更新被实例 lock 拒绝

- 设计技术：并发、状态迁移。
- 验证方式：自动化脚本。
- Given：`agent-a` 更新处于执行中。
- When：第二个进程同时对 `agent-a` 执行 update 或 rollback。
- Then：第二个命令快速返回冲突，输出 lock owner/PID/action；第一个更新不受影响。
- 失败判断：两个写流程同时执行、状态文件损坏或命令静默等待无界时间。

### BIC-005 不同实例可并发更新且不串扰

- 设计技术：并发。
- 验证方式：自动化脚本。
- Given：A/B 使用独立 worktree 和 instanceId。
- When：并行执行两个 update。
- Then：两者可以同时推进；日志、pending/state、backup 和 release pointer 分属各自实例。
- 失败判断：使用全局锁互相阻塞，或任一状态写入另一实例目录。

### BIC-006 A 的更新和回滚不改变 B 与 Stable

- 设计技术：状态迁移、回归。
- 验证方式：自动化脚本 + `$computer-use`。
- Given：A/B/Stable 均 healthy，已记录路径 identity、PID、revision、页面和 App Server 状态。
- When：更新 A 到新 revision，再回滚 A。
- Then：只有 A 的 revision/release/PID 按预期变化；B 和 Stable 的基线逐项不变。
- 失败判断：B 或 Stable 的 App、runtime、App Server、profile、hooks/CLI、窗口或 CDP 被修改/重启。

### BIC-007 每个实例同时暴露两类可归属 CDP

- 设计技术：判定表。
- 验证方式：自动化脚本 + `$toolkit:playwright-cli`。
- Given：A/B 均 healthy，且各打开一个 Terminal Browser tab。
- When：查询 A/B 的 `desktop` 和 `terminal-browser` surface。
- Then：得到四个可用 endpoint；Desktop target 包含对应实例/revision 的 `runweave://app` 页面；Terminal Browser Proxy 只返回所属实例的 Browser target。
- 失败判断：surface 共用 endpoint、目标为空但报告 healthy，或返回另一实例页面。

### BIC-008 instanceId 与 surface 唯一选择目标

- 设计技术：判定表。
- 验证方式：`$toolkit:playwright-cli`。
- Given：A/B Desktop 分别显示唯一 DOM marker，A/B Browser tab 分别打开不同唯一 URL。
- When：依次解析并附着四种 `instanceId + surface` 组合。
- Then：每个 Playwright session 只读取预期 marker/URL，并记录 instanceId、surface、endpoint 和 revision。
- 失败判断：任一组合读取错误目标，或需要通过端口猜测才能区分。

### BIC-009 错误全局 CDP 配置不能劫持实例路由

- 设计技术：错误猜测、优先级判定。
- 验证方式：`$toolkit:playwright-cli`。
- Given：把 ambient `PLAYWRIGHT_MCP_CDP_ENDPOINT` 和全局 CLI config 指向 Stable `9224`。
- When：通过实例 resolver 选择 `agent-b + desktop` 并附着。
- Then：实际 target 属于 B Desktop，session/证据中没有 Stable Browser target。
- 失败判断：附着 Stable、使用全局 endpoint，或 resolver 只给 warning 后继续错误目标。

### BIC-010 端口占用时动态分配并写入正确实例状态

- 设计技术：依赖不可用、边界值。
- 验证方式：自动化脚本。
- Given：预先占用实现首选的 Desktop/Proxy 候选端口。
- When：启动 A/B。
- Then：实例选择其他可用 loopback endpoint，状态与真实监听 PID一致；不复用 Stable 或另一 Beta endpoint。
- 失败判断：启动失败但无明确错误、状态保留旧端口，或错误连接占用端口的进程。

### BIC-011 stale registry 和失效 PID 不会返回可附着 endpoint

- 设计技术：状态迁移、错误猜测。
- 验证方式：自动化脚本。
- Given：强制结束 A Desktop，保留其 registry/status；B 继续运行。
- When：执行 list/status/cdp 查询 A 和 B。
- Then：A 标记 stale/unhealthy 且 cdp 查询非零退出；B 仍 healthy；输出 A 的 status/log/cleanup 指引。
- 失败判断：A 返回旧 endpoint 为 healthy、误连复用该端口的新进程，或清理了 B。

### BIC-012 多实例存在但未指定实例时拒绝猜测

- 设计技术：判定表。
- 验证方式：自动化脚本。
- Given：A/B 均 active，当前 worktree 无实例绑定。
- When：执行需要目标的 status/cdp/update 命令但不传 `--instance`。
- Then：命令返回非零状态，列出 A/B 的 ID、revision、健康状态；不产生副作用。
- 失败判断：按最近启动、端口顺序或固定 `default` 静默选择。

### BIC-013 Beta terminal 只继承所属实例的 Terminal Browser endpoint

- 设计技术：隔离、并发。
- 验证方式：自动化脚本 + `$toolkit:playwright-cli`。
- Given：A/B 各创建新 terminal。
- When：读取两个 pane 的 `RUNWEAVE_BETA_INSTANCE`、`RUNWEAVE_DESKTOP_CHANNEL`、`PLAYWRIGHT_MCP_CDP_ENDPOINT` 并连接。
- Then：instance/channel 正确；endpoint 分别属于 A/B Terminal Browser Proxy；不能看到对方 targets。
- 失败判断：继承 Stable endpoint、Desktop endpoint或另一实例 Proxy。

### BIC-014 group-scoped endpoint 只暴露指定实例与 group

- 设计技术：权限隔离。
- 验证方式：`$toolkit:playwright-cli`。
- Given：A/B 各有两个 Agent Control Group 和不同页面。
- When：分别连接每个 group-scoped endpoint 并读取 targets。
- Then：每次只返回对应实例、对应 group 的页面。
- 失败判断：跨实例或跨 group target 可见/可操作。

### BIC-015 旧单 Beta 可迁移为 default 并回滚

- 设计技术：兼容、状态迁移。
- 验证方式：自动化脚本 + `$computer-use`。
- Given：存在旧 `/Applications/Runweave Beta.app`、旧 userData/update state 和可用 previous release。
- When：执行显式迁移，启动 `default`，再执行一次更新和回滚。
- Then：旧状态备份可取证；default healthy；更新/回滚只作用于 default；迁移失败可恢复旧 App。
- 失败判断：迁移静默删除旧状态、无法回滚，或覆盖 Stable/A/B。

### BIC-016 删除一个实例只清理其拥有资源

- 设计技术：场景、安全边界。
- 验证方式：自动化脚本 + `$computer-use`。
- Given：A/B 均存在并停止 A。
- When：显式删除 A。
- Then：A 的 App、userData、App Server home、registry 被删除；B 与 Stable 的身份、PID、文件和窗口不变。
- 失败判断：路径越界删除、仍有 A live 进程却继续删除，或影响 B/Stable。

### BIC-017 状态、日志和 registry 不泄露秘密

- 设计技术：安全、错误猜测。
- 验证方式：自动化脚本。
- Given：A/B 已登录并运行过更新、失败恢复和 CDP 查询。
- When：扫描实例 status、registry、update/app-server 日志和 CLI JSON 输出。
- Then：允许出现路径、PID、endpoint、revision；不出现 password、JWT、Authorization、hook token 或访问 token。
- 失败判断：任何敏感值明文出现。

### BIC-018 Agent 重启或换 terminal 后仍可选择同一实例

- 设计技术：重启恢复。
- 验证方式：自动化脚本 + `$toolkit:playwright-cli`。
- Given：Agent A 已使用实例 `agent-a`，记录实例状态后关闭 Playwright/Agent session。
- When：从 Stable 的另一个新 terminal 按 instanceId 重新查询并附着 A Desktop。
- Then：解析到同一 instanceId/revision/PID，读取到原页面；不依赖旧 terminal env 或 Playwright session。
- 失败判断：新 Agent 无法发现实例、选择最近实例，或必须复制旧端口才能连接。

## 覆盖说明

- 正常路径：BIC-003、BIC-007、BIC-008。
- 边界与非法输入：BIC-001、BIC-010。
- 并发与状态时序：BIC-004、BIC-005、BIC-006、BIC-011、BIC-018。
- 数据与协议：BIC-002、BIC-007、BIC-013。
- 安全与隔离：BIC-009、BIC-014、BIC-016、BIC-017。
- 兼容与回滚：BIC-006、BIC-015。
- 不覆盖远程鉴权：endpoint 仍限定 loopback，本计划未引入远程访问。

## 验收通过标准

必须同时满足：

- 必跑命令全部通过。
- BIC-001 至 BIC-018 全部通过；任一失败即停止并保留实例状态、日志和命令输出。
- 两个不同 revision 的 Beta 与 Stable 可同时运行，且 A/B/Stable 的所有隔离基线均成立。
- 四种 `instanceId + surface` 组合都有 `$toolkit:playwright-cli` 的 endpoint、target、DOM/URL 和 revision 证据。
- 桌面身份与 Stable 零中断有 `$computer-use` 证据。
- 错误全局 CDP、端口占用、崩溃、stale registry、并发更新和旧状态迁移均有确定的 fail-closed 结果。
