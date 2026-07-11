# Runweave Beta 自举开发通道测试用例

## 需求来源

目标是在正式版 Runweave 中开发 Runweave，并把当前源码部署到独立 Beta。Beta 的更新、重启、故障和回滚不能中断正式版，也不能污染正式 Desktop、backend、App Server 或全局集成。

对应计划：`docs/plans/2026-07-10-runweave-beta-self-hosting.md`。

## 范围

覆盖：

- Stable 与 Beta Desktop 并存和身份隔离；
- Beta Runtime、backend profile、App Server、更新状态、日志与 CDP 隔离；
- Beta update、dry-run、status、rollback；
- runtime、完整 App、App Server 三类更新选择；
- 更新失败、进程崩溃和连续迭代；
- 全局 hook、`rw` 和更新源不被 Beta 污染；
- `$computer-use` 桌面证据与 `$toolkit:playwright-cli` Beta 页面证据。

不覆盖：

- 公共 Beta 分发、签名公证和外部用户升级；
- Windows、Ionic/Capacitor App；
- Stable 数据导入 Beta；Beta 第一阶段使用全新状态；
- 多于 Stable/Beta 两个通道；
- 与通道隔离无关的终端业务和 Agent Team 功能。

## 当前与目标事实

- 当前正式 App 路径是 `/Applications/Runweave.app`，bundle id 是 `com.runweave.desktop`。
- 当前正式 Electron userData、browser profile、Desktop Runtime 和 App Server 都有持久化状态，不能作为 Beta 的可写目录复用。
- 现有更新器能够区分 Desktop Runtime、完整 Desktop App 和 App Server 动作；Beta 必须复用这一组件语义。
- App Server 已支持不同 home 并存；Beta 目标 home 是 `~/.runweave/app-server-beta`。
- 目标 Beta App 路径是 `/Applications/Runweave Beta.app`，且必须使用独立 bundle、userData、profile、runtime、update state、日志与 CDP endpoint。
- 浏览器页面验收必须使用 `$toolkit:playwright-cli`；桌面 App 启停、并存、弹窗和 Dock/窗口验证必须使用 `$computer-use`。
- 本仓库不新增单元测试文件；静态检查不能替代本文件的真实行为验收。

## 测试设计方法

- 场景/用例法：覆盖从 Stable 发起 Beta 初始化、更新、验证和回滚的端到端闭环。
- 判定表：按改动类型区分 runtime、完整 App、App Server 及其组合动作。
- 状态迁移：覆盖未安装、健康、更新中、更新失败、已回滚、进程崩溃后的状态。
- 等价类划分：有效 Beta 状态、缺失状态、损坏状态、Stable/Beta 路径混用分别验证。
- 错误猜测：覆盖误杀 Stable、共享 profile lock、覆盖全局 hook/CLI、状态泄密、CDP 误连等高风险问题。

## 验收前置

1. 正式版 `/Applications/Runweave.app` 已安装并运行，正式 backend 与正式 App Server 健康。
2. 在正式版中打开当前 Runweave worktree，并保留一个持续运行的终端作为“开发控制面”。
3. 记录 Stable 基线：Desktop PID、backend PID/端口/profile、App Server PID/releaseId/home、正式 App 版本、正式更新 state 修改时间、全局 hook 与 `~/.runweave/bin/rw` 的摘要。
4. Beta 用例使用独立的测试项目和终端，不对 Stable 用户项目执行删除或清理。
5. 每条用例自行准备 Beta 前置状态，不依赖上一条用例遗留结果。

## 必跑命令

实施完成后按顺序执行，任一失败即停止：

```bash
pnpm --filter @runweave/shared typecheck
pnpm --filter @runweave/cli typecheck
pnpm --filter @runweave/electron typecheck
pnpm --filter @runweave/backend typecheck
pnpm --filter @runweave/frontend typecheck
pnpm lint
pnpm runweave:update:test-cases
pnpm runweave:beta:verify
git diff --check
```

随后必须执行 RWB-001 至 RWB-011 的真实环境验证。命令通过不能代替行为用例。

## 测试用例

### RWB-001 首次初始化 Beta 时保持 Stable 完整运行

验证方式：CLI + `$computer-use` + `$toolkit:playwright-cli`

Given：

- Stable Desktop、backend 和正式 App Server 均健康；
- Beta App 与 Beta 专属状态目录均不存在；
- 已记录 Stable 基线。

When：

1. 在 Stable 终端执行 `pnpm runweave:beta:update`。
2. 使用 `$computer-use` 等待 `Runweave Beta` 窗口出现，同时观察 Stable 窗口。
3. 执行 `pnpm runweave:beta:status --json`。
4. 使用 `$toolkit:playwright-cli` 连接 status 返回的 Beta CDP endpoint，读取页面标题、Beta 标识、版本和 source revision。

Then：

- `/Applications/Runweave Beta.app` 被安装并启动；
- Stable 窗口和开发终端持续存在，Stable Desktop/backend/App Server PID 与基线一致；
- Beta status 中 Desktop、backend 和 App Server 均属于 `beta`，路径均为 Beta 专属路径；
- Playwright 读取到 Beta 页面，而不是 Stable 页面。

失败判断：

- Stable 任一核心进程被退出或重启；
- Beta 复用了 Stable userData、profile、App Server home 或更新 state；
- Beta 启动成功但 status 无法唯一定位 CDP，或 Playwright 连接到 Stable。

### RWB-002 Stable 与 Beta 同时运行时状态和单实例互不抢占

验证方式：CLI + `$computer-use`

Given：Stable 与 Beta 均已安装且健康。

When：

1. 分别再次打开 `/Applications/Runweave.app` 和 `/Applications/Runweave Beta.app`。
2. 使用 `$computer-use` 分别聚焦两个窗口，并核对应用名称、图标和 Beta 标识。
3. 读取两个 App 的进程路径、userData、backend profile lock 和端口。

Then：

- 再次打开 Stable 只激活 Stable，打开 Beta 只激活 Beta；
- 两个 App 同时存在，用户可以明确区分；
- userData、profile lock、backend PID 和端口均属于各自通道。

失败判断：

- 打开 Beta 只激活 Stable，或反之；
- 任一 App 因另一 App 的单实例锁退出；
- 两个 backend 共享同一个 profile lock。

### RWB-003 Runtime 改动只更新并重启 Beta Runtime

验证方式：CLI + `$computer-use` + `$toolkit:playwright-cli`

Given：

- Stable 与 Beta 均健康，并已记录双方 PID、runtime release 和 Stable 基线；
- 当前 worktree 相对上次 Beta 部署只有 runtime-loadable 改动。

When：

1. 执行 `pnpm runweave:beta:update --dry-run`，保存动作输出。
2. 执行 `pnpm runweave:beta:update`。
3. 读取 Beta status，并用 `$toolkit:playwright-cli` 验证 Beta 页面加载当前 source revision。

Then：

- dry-run 选择 Beta Runtime，未选择完整 Beta App；
- Beta runtime release 发生变化，Beta 恢复健康；
- Stable Desktop、backend、runtime 和 App Server 与基线一致。

失败判断：

- runtime 改动触发完整 Beta App 打包且没有明确必要原因；
- 更新退出或替换 Stable；
- Beta 页面仍显示旧 revision 或无法恢复健康。

### RWB-004 Electron 改动只替换和重启 Beta App

验证方式：CLI + `$computer-use` + `$toolkit:playwright-cli`

Given：

- Stable 与 Beta 均健康；
- 当前 worktree 包含 Electron shell、preload、resource 或构建配置改动；
- 已记录 Stable 基线和 Beta 旧版本。

When：

1. 执行 Beta dry-run，确认完整 App 动作。
2. 执行 Beta update。
3. 用 `$computer-use` 观察 Beta 退出并重新打开，同时保持 Stable 窗口可交互。
4. 用 `$toolkit:playwright-cli` 验证新 Beta 页面和 source revision。

Then：

- 只替换 `/Applications/Runweave Beta.app`；
- Beta App 版本或构建 revision 更新并恢复健康；
- `/Applications/Runweave.app` 内容、版本和进程均未被 Beta 动作修改。

失败判断：

- 更新器通过模糊进程名误杀 Stable；
- 正式 App 被替换、重新签名或重启；
- Beta 重启后仍运行旧构建。

### RWB-005 App Server 改动只切换 Beta owner

验证方式：CLI + 状态/健康接口

Given：

- 正式 App Server 与 Beta App Server 同时健康；
- 已记录两者的 home、PID、releaseId、lock 和 event log 路径；
- 当前 worktree 包含 App Server 相关改动。

When：

1. 执行 Beta dry-run，确认 Beta App Server update 动作。
2. 执行 Beta update。
3. 重新读取正式与 Beta App Server status 和健康接口。

Then：

- Beta App Server releaseId 和 owner PID 切换并恢复健康；
- 正式 App Server PID、releaseId、home、lock 和 event log 不变；
- Beta backend 连接新的 Beta owner，Stable backend 仍连接正式 owner。

失败判断：

- Beta 更新停止或切换正式 owner；
- 两个 App Server 共享 lock、token、event log 或 runtime root；
- status 隐藏了实际连接通道，无法确认 backend 归属。

### RWB-006 Dry-run 保持 Stable 与 Beta 完全只读

验证方式：CLI + 文件/进程快照

Given：Stable 与 Beta 均健康，且 worktree 同时包含 runtime、Electron 和 App Server 改动。

When：

1. 记录双方进程、版本、runtime pointer、App Server pointer、update state 修改时间和 App bundle 摘要。
2. 执行 `pnpm runweave:beta:update --dry-run`。
3. 再次读取相同快照。

Then：

- 输出完整列出 Beta Desktop App、Runtime 和 App Server 的计划动作及原因；
- 所有进程、指针、bundle 和 state 修改时间保持不变；
- 输出中的目标路径全部属于 Beta。

失败判断：

- dry-run 产生构建产物、写 state、退出进程或安装 runtime；
- 输出出现正式 App 或正式 App Server 作为更新目标。

### RWB-007 Beta 更新失败后恢复上一可用版本且不影响 Stable

验证方式：CLI + `$computer-use` + `$toolkit:playwright-cli`

Given：

- Stable 与 Beta 均健康；
- Beta 已有明确的上一可用 release；
- 使用可恢复的故障注入使新 Beta backend 或 App Server 无法通过健康检查。

When：

1. 执行 Beta update，记录非零退出码和失败输出。
2. 若更新器未自动恢复，执行 `pnpm runweave:beta:rollback`。
3. 用 `$computer-use` 和 `$toolkit:playwright-cli` 验证恢复后的 Beta。

Then：

- 失败输出包含故障组件、日志位置和上一可用 release；
- Beta 恢复到上一可用 release 并重新达到健康状态；
- Stable 窗口、开发终端、backend 和正式 App Server 全程保持可用。

失败判断：

- 失败安装删除了最后一个可用 Beta；
- rollback 作用到 Stable；
- 返回成功退出码但 Beta 实际不健康；
- 失败后没有可定位的日志或恢复路径。

### RWB-008 Beta status 完整、可取证且不泄露敏感信息

验证方式：CLI + JSON 校验 + `$toolkit:playwright-cli`

Given：Stable 与 Beta 均健康。

When：

1. 执行 `pnpm runweave:beta:status --json` 并解析 JSON。
2. 使用返回的 base URL、PID、路径和 CDP endpoint 与真实进程/文件进行交叉核对。
3. 用 `$toolkit:playwright-cli` 连接返回的 CDP endpoint 并读取 Beta 标识。
4. 扫描 status 输出中的敏感字段名和值模式。

Then：

- JSON 包含计划定义的 channel、source、App、backend、App Server、CDP、上一可用 release 和失败摘要；
- 所有路径和 PID 与真实 Beta 一致；
- CDP 连接目标明确属于 Beta；
- 输出不包含 token、密码、JWT、Authorization 或 cookie。

失败判断：

- 需要额外人工查找才能确定 Beta 端口或 release；
- status 把 Stable 进程报告为 Beta；
- JSON 无法解析或包含敏感信息。

### RWB-009 Beta 不覆盖 Stable 的全局 hook、CLI 与更新源

验证方式：CLI + 文件摘要 + 终端行为

Given：

- Stable 和 Beta 均健康；
- 已记录全局 hook、`~/.runweave/bin/rw` 和两个通道更新配置的基线。

When：

1. 执行一次包含完整 App 和 App Server 的 Beta update。
2. 比对全局 hook 和 `rw` 的所有权、目标与摘要。
3. 在 Stable terminal 和 Beta terminal 中分别执行 `rw health` 或等价只读状态命令。
4. 分别检查两个通道的更新源。

Then：

- Beta update 不静默覆盖 Stable 管理的全局 hook 或 `rw`；
- Stable terminal 连接 Stable backend，Beta terminal 连接 Beta backend；
- Beta 不消费正式更新 feed，正式版不消费 Beta feed。

失败判断：

- 更新 Beta 后 Stable terminal 的 `rw` 被重定向到 Beta；
- Beta hook 事件写入正式 backend/App Server；
- 任一通道能够自动安装另一通道的产物。

### RWB-010 Beta 进程崩溃或退出不影响 Stable 工作台

验证方式：CLI + `$computer-use`

Given：Stable 与 Beta 均健康，Stable 中有一个持续运行的开发终端。

When：

1. 只终止 Beta Desktop 或 Beta backend 进程。
2. 使用 `$computer-use` 继续操作 Stable 窗口和开发终端。
3. 执行 Beta status，再通过 Beta update 或重新打开 Beta 恢复。

Then：

- Stable 窗口、terminal、backend 和正式 App Server 不退出、不重启；
- Beta status 明确报告不可用组件；
- Beta 可以独立恢复。

失败判断：

- Beta 崩溃触发 Stable 退出、backend lock 冲突或正式 App Server 重启；
- Beta status 错误报告 Stable 也不可用；
- 恢复 Beta 必须先退出 Stable。

### RWB-011 连续五次 Beta 迭代保持 Stable 零中断

验证方式：端到端循环 + `$computer-use` + `$toolkit:playwright-cli`

Given：

- Stable 作为开发控制面持续运行；
- 准备能够分别触发 Runtime、完整 App、App Server 的无害验证改动或固定 fixture；
- 已记录 Stable 初始 PID、App Server release 和开发终端标识。

When：

1. 连续执行 5 次 Beta update，循环中至少覆盖一次 Runtime、一次完整 App、一次 App Server 更新。
2. 每次更新后读取 Beta status，并用 `$toolkit:playwright-cli` 验证 Beta 页面达到目标 revision。
3. 每轮都用 `$computer-use` 确认 Stable 开发终端仍可交互，并记录 Stable 关键状态。

Then：

- 5 次更新全部完成，Beta 每轮都达到可验证状态；
- Stable Desktop PID、backend PID、正式 App Server PID/releaseId 和开发终端连续保持不变；
- 每轮状态都能追溯到对应 source revision 和组件动作。

失败判断：

- 任一轮需要退出 Stable 才能继续；
- Stable 任一关键进程被 Beta 更新动作重启；
- Beta 更新命令返回成功但页面未加载对应 revision；
- 无法从状态和日志还原某一轮做了什么。

## 覆盖清单

- 功能正确性：RWB-001 覆盖首次闭环；RWB-003、RWB-004、RWB-005 覆盖三组件更新；RWB-008 覆盖状态入口。
- 边界与异常：RWB-006 覆盖只读预览；RWB-007 覆盖失败与回滚；RWB-010 覆盖进程崩溃。
- 状态与时序：RWB-001 覆盖未安装到健康；RWB-007 覆盖更新中到失败/回滚；RWB-011 覆盖连续重启与重连。
- 并发与隔离：RWB-002 覆盖两个 Desktop/backend 并存；RWB-005 覆盖两个 App Server owner 并存。
- 数据与协议：RWB-005 核对 lock/event/runtime；RWB-008 核对 status JSON 和敏感字段；RWB-009 核对全局集成。
- 安全与权限：覆盖 status/日志凭证泄漏和跨通道越界；不覆盖远程鉴权与 Origin，因为 Beta 是本机开发通道且不改变现有网络鉴权合约。
- 幂等与去重：RWB-002 重复打开验证单实例归属；RWB-011 验证重复更新不产生跨通道副作用。
- 回归与兼容：RWB-003 至 RWB-006 均守护 Stable 零变化；RWB-009 守护现有 `rw`、hook 和正式更新行为。
- 容量与极值：不覆盖大量 channel，因为第一阶段只支持 Stable/Beta；不覆盖超大 runtime 包，包体与性能基线另行制定。
- 可取证性：所有桌面动作使用 `$computer-use`；所有 Beta 页面/CDP 断言使用 `$toolkit:playwright-cli`；CLI/状态用真实输出和进程/文件交叉核对。

## 验收通过标准

必须同时满足：

- 必跑命令全部通过。
- RWB-001 至 RWB-011 全部实际执行通过，关键证据可追溯。
- Stable 与 Beta 可以长期并存，不共享可写运行状态。
- Runtime、完整 App、App Server 三类 Beta 更新均只作用于 Beta。
- Beta 失败和崩溃不影响 Stable，且上一可用 Beta 可以恢复。
- 连续 5 次更新循环中 Stable Desktop、backend、正式 App Server 和开发终端零中断。
- status JSON 足以让 agent 定位和验证 Beta，且不泄露敏感信息。
- 未执行 `$computer-use` 或 `$toolkit:playwright-cli` 时，不得将静态检查或代码阅读写成验收通过。
