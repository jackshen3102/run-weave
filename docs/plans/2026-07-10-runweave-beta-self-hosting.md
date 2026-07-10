# Runweave Beta 自举开发通道实施计划

> 状态：待实施。核心目标不是增加一个版本标签，而是让正式版 Runweave 持续承载开发过程，同时把 Beta 作为可独立更新、重启、验证和回滚的被测对象。

## 背景

当前 Runweave 只有一个本机正式运行通道。现有更新流程已经能区分 Desktop App、Desktop Runtime 和 App Server 三类组件，但默认仍会替换 `/Applications/Runweave.app`、重启正式桌面端，并更新正式 App Server home。

这导致“用 Runweave 开发 Runweave”存在自举冲突：一旦修改 Electron 或 App Server，承载 agent、终端和开发上下文的正式版自身就会被更新或重启，执行者还需要人工辨认进程、端口、runtime 和 App Server owner。

本计划建立一个本机 Beta 通道。正式版是稳定工作台，Beta 是开发产物；Beta 可以被反复构建、打坏和恢复，正式版始终保持可用。

## 完成定义

只有同时满足以下条件，目标才算完成：

1. `/Applications/Runweave.app` 与 `/Applications/Runweave Beta.app` 可以同时运行。
2. 在正式版终端中执行一次 Beta 更新命令，可以把当前 worktree 部署到 Beta，并等待 Beta 达到可验证状态。
3. Beta 的 Desktop App、Desktop Runtime、backend profile、App Server、更新状态和日志与正式版隔离。
4. 更新或回滚 Beta 时，不退出正式版，不重启正式 backend，不更新正式 App Server，不覆盖正式运行数据。
5. 执行者可以通过机器可读状态唯一定位 Beta 的版本、源码提交、PID、端口、runtime、App Server 和 CDP endpoint。
6. Beta 更新失败时返回非零状态和明确证据路径，并保留或恢复上一可用 Beta；正式版开发过程继续运行。
7. `docs/testing/runweave-beta-self-hosting-test-cases.md` 中所有用例实际执行通过，桌面与页面行为有 `$computer-use` 和 `$playwright-cli` 证据。

## 目标

- 让正式版 Runweave 成为长期稳定的开发控制面。
- 让 Beta 成为本机独立安装、独立运行、独立更新的开发通道。
- 将 frontend、backend、Electron 和 App Server 改动统一纳入一个 Beta 发布入口。
- 保留现有“按改动范围选择组件”的能力，避免每次都完整打包。
- 给 AI 提供确定的命令、结构化状态、日志位置和完成条件，减少依赖人工操作与猜测。
- 让失败可恢复，且恢复动作只作用于 Beta。

## 非目标

- 不建设面向外部用户的公共 Beta 发布渠道。
- 不支持 Windows 安装包；本阶段只覆盖本机 macOS。
- 不纳入 Ionic/Capacitor 移动 App Beta。
- 不让正式版和 Beta 实时共享 Electron userData、browser profile、terminal session store 或 App Server event store。
- 不扩展为任意数量的 Preview channel；第一阶段只支持 `stable` 与 `beta`。
- 不先建设正式版内的 Beta 管理 UI；第一阶段以 CLI、状态输出和真实桌面验收完成闭环。
- 不重构与本目标无关的终端、Agent Team、同步或通知业务。
- 不新增单元测试文件。

## 用户可见行为

### Beta 更新

统一入口：

```bash
pnpm runweave:beta:update
```

行为要求：

- 首次执行时完成 Beta Desktop 与 Beta App Server 的本机初始化。
- 后续执行根据当前 worktree 相对上次 Beta 部署的改动，选择 Desktop Runtime、完整 Desktop App、App Server 中需要更新的组件。
- 完整 Desktop 更新只退出并重新打开 `Runweave Beta.app`。
- App Server 更新只安装并重启 Beta App Server owner。
- 成功返回前必须确认 Beta desktop/backend 已就绪，并明确报告 Beta App Server 是健康、跳过还是降级。
- 失败时返回非零退出码，指出失败组件、上一可用版本和日志位置。

更新预览：

```bash
pnpm runweave:beta:update --dry-run
```

`--dry-run` 只读取状态，不构建、不安装、不退出进程、不修改 Stable 或 Beta 的运行状态，并输出将要执行的组件动作和原因。

### Beta 状态

统一入口：

```bash
pnpm runweave:beta:status --json
```

JSON 至少包含：

- `channel`，固定为 `beta`；
- source root、git HEAD、dirty 状态和部署时间；
- Beta App 路径、版本、PID 和健康状态；
- Beta backend 的 base URL、PID、runtime release、profile 目录和健康状态；
- Beta App Server 的 home、base URL、PID、release 和健康状态；
- Beta Terminal Browser/CDP endpoint；
- 上一可用 Beta release 和最近失败摘要。

状态输出不得包含 App Server token、登录密码、JWT secret、Authorization、cookie 等敏感信息。

### Beta 回滚

统一入口：

```bash
pnpm runweave:beta:rollback
```

回滚只作用于 Beta，将本次失败涉及的 Beta 组件恢复到上一可用 release。没有上一可用 release 时应明确失败，不得回退或修改正式版。

## 通道隔离合约

| 边界                | Stable                       | Beta                              | 强制要求                                         |
| ------------------- | ---------------------------- | --------------------------------- | ------------------------------------------------ |
| Desktop App         | `/Applications/Runweave.app` | `/Applications/Runweave Beta.app` | 更新一方不得退出或替换另一方                     |
| Bundle 身份         | `com.runweave.desktop`       | 独立 Beta bundle id               | 可以并存并拥有独立单实例锁                       |
| 应用名称与图标      | Runweave                     | Runweave Beta + 明显 Beta 标识    | Dock、菜单和窗口中不能混淆                       |
| Electron userData   | 保持现状                     | 独立 Beta userData                | 不共享 localStorage、认证和 runtime 指针         |
| Desktop Runtime     | 正式 runtime                 | 独立 Beta runtime                 | release、current、last-known-good 分开           |
| backend profile     | 正式 profile                 | 独立 Beta profile                 | lock、认证、terminal/session store、日志分开     |
| App Server          | `~/.runweave/app-server`     | `~/.runweave/app-server-beta`     | lock、token、event log、projection、runtime 分开 |
| cloud sync 模拟目录 | 正式目录                     | 独立 Beta 目录                    | Beta 事件不得写入正式镜像                        |
| 更新状态            | 正式更新 state               | 独立 Beta state                   | 组件判断和上一可用版本分开                       |
| 更新源              | 保持现状                     | 独立 Beta feed 或禁用自动更新     | Beta 不得安装正式 feed 产物                      |
| CDP/Playwright      | 正式 endpoint                | 可发现的 Beta endpoint            | 验收不得误连正式版                               |
| 全局 hook/CLI       | 正式版拥有                   | Beta 不静默覆盖                   | Beta terminal 通过自身环境路由到 Beta            |

工作区源码目录可以共享；运行期可变状态不得实时共享。第一阶段 Beta 使用全新数据，不自动复制正式版数据。未来如果需要导入项目列表或连接配置，应作为显式、一次性的迁移能力另行设计。

## 实施阶段

### 阶段 1：建立 Beta 通道身份

目标：让 macOS 将 Stable 与 Beta 识别为两个独立应用。

范围：

- 增加 Beta 构建配置、独立应用名、bundle id 和明显的 Beta 视觉标识。
- 确保两者使用独立 userData 与单实例身份。
- Beta 只注册或使用自己的通道身份，不抢占正式版的外部入口。

阶段验收：

- 两个 App 同时打开，Dock、菜单和进程路径可明确区分。
- 打开或重启 Beta 不会激活、退出或聚焦正式版来替代 Beta。
- 两个 App 的 userData 路径不同。

### 阶段 2：隔离 Beta Desktop Runtime 与 backend

目标：让 Beta backend、runtime 和本地状态可以独立启动与恢复。

范围：

- Beta 使用独立 runtime root、backend profile、认证文件、日志和端口发现结果。
- 保持现有 backend 动态端口能力，但必须通过 Beta status 暴露实际地址。
- Beta runtime 更新和 last-known-good 回退不读取或改写正式 runtime 指针。

阶段验收：

- Stable 与 Beta backend 同时健康，使用不同 profile lock 和端口。
- 更新 Beta Runtime 后只有 Beta runtime release 变化。
- Beta backend 启动失败时不会停止正式 backend。

### 阶段 3：隔离 Beta App Server

目标：让两个 App Server owner 长期并存，并由各自通道消费。

范围：

- Beta 固定使用独立 App Server home、runtime、状态和 cloud sync 模拟目录。
- Beta Desktop/backend/terminal 只发现 Beta App Server；Stable 保持发现正式 App Server。
- Beta App Server 的安装、启动、重启、停止和回滚不得作用到正式 owner。

阶段验收：

- 两个 owner 同时健康，lock、token、PID、releaseId 和 event log 路径不同。
- 更新 Beta App Server 后，正式 owner 的 PID 与 releaseId 保持不变。
- Beta App Server 不可用时，Beta 明确显示降级；正式版仍正常工作。

### 阶段 4：形成一条 Beta 更新与回滚链路

目标：从正式版终端执行一个命令即可完成 Beta 部署。

范围：

- 在现有三组件更新判断上增加明确的 Beta channel，不复制第二套完整更新算法。
- Beta 首次安装、runtime 更新、完整 App 更新和 App Server 更新使用统一状态记录。
- 安装采用临时路径和原子切换；每个组件切换前记录上一可用 release。
- 失败时自动恢复能够安全恢复的 Beta 组件；不能自动恢复时保留现场并提供显式 rollback。

阶段验收：

- `update`、`update --dry-run`、`rollback` 的输入、输出和退出码稳定。
- frontend/backend 改动不触发完整 Beta App 打包；Electron 改动触发完整 Beta App 更新；App Server 改动只额外更新 Beta App Server。
- 任一动作均不修改正式 App、正式 update state 或正式 App Server。

### 阶段 5：补齐 AI 可观测与控制面

目标：让执行者不依赖人工查进程、端口和文件判断结果。

范围：

- 提供稳定的 `status --json` 合约。
- 每次更新记录 source git HEAD、dirty 状态、组件 release、动作、结果和日志路径。
- 暴露可用于 Playwright 的 Beta CDP endpoint，并能验证目标确实来自 Beta。
- Beta UI 展示通道和构建来源，至少能看到 `Beta`、版本和 source revision。

阶段验收：

- 只依赖 status JSON 即可定位 Beta desktop、backend、App Server 和 CDP。
- 状态和日志不泄露敏感信息。
- `$playwright-cli` 能连接 Beta 并读取终端页面，不会误连 Stable。

### 阶段 6：守住全局集成与正式版兼容

目标：防止 Beta 通过全局 hook、CLI shim、更新 feed 或兼容逻辑反向污染正式版。

范围：

- Beta 启动或更新不得静默覆盖正式版管理的全局 hook 与 `~/.runweave/bin/rw`。
- Beta terminal 中的 CLI 和 hook 事件依靠 terminal-scoped 环境连接 Beta backend/App Server。
- 现有 `pnpm runweave:update` 行为保持不变，继续指向正式通道。
- Beta 不消费正式更新 feed；正式版也不消费 Beta feed。

阶段验收：

- Beta 更新前后，全局 hook 与正式 `rw` 的所有权和内容符合约定。
- Stable terminal 的 `rw` 仍连接 Stable；Beta terminal 的 `rw` 连接 Beta。
- 正式更新命令的现有验证用例继续通过。

### 阶段 7：完成真实环境验收与文档

目标：证明自举开发闭环可以持续使用，而不是只完成一次安装。

范围：

- 执行 `docs/testing/runweave-beta-self-hosting-test-cases.md` 全部用例。
- 连续执行 5 次包含 runtime、完整 App 和 App Server 的 Beta 更新循环。
- 使用 `$computer-use` 验证两个桌面 App 的并存、重启和故障隔离。
- 使用 `$playwright-cli` 验证 Beta 终端页面、Beta 标识、source revision 和目标 CDP。
- 新增 Beta 部署活文档，并更新 `docs/README.md` 索引；同步现有本地更新文档中的 Stable/Beta 边界。

阶段验收：

- 全部用例通过并有关键证据。
- 5 次循环中正式 Desktop、backend 和 App Server 均未被 Beta 动作重启或更新。
- 文档能让新的 agent 只凭入口命令完成 Beta 更新、状态确认和回滚。

## 文件与模块范围

以下是预期职责范围，不限制执行者对内部 helper 的合理组织：

- `package.json`：暴露 Beta update、status、rollback 和 verify 入口。
- `scripts/runweave-update*.mjs`：复用现有组件判断，增加 channel 边界、Beta 默认路径、状态、回滚与结构化输出。
- `electron/electron-builder*.yml`、`electron/resources/`：Beta 构建身份和视觉标识。
- `electron/src/main.ts` 及现有 runtime/backend/updater 模块：解析通道身份，使用对应 userData、runtime、profile、更新源和 CDP。
- `packages/shared/src/app-server-node.ts`、`packages/runweave-cli/src/commands/app-server.ts`：复用已有多 home 能力，确保通道选择可传递且不泄露 token。
- Electron hook/CLI 安装相关模块：守住全局所有权，支持 terminal-scoped Beta 路由。
- `docs/deployment/`、`docs/architecture/`、`docs/README.md`：实施完成后的活文档。
- `docs/testing/runweave-beta-self-hosting-test-cases.md`：本计划的验收合约。

不要求为了本计划调整无关 frontend 页面、终端业务、App 移动端或 Agent Team 实现。

## 验证门禁

静态门禁按改动范围执行，任一失败即停：

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

这些命令只构成前置门禁，不能代替真实行为验收。桌面流程必须用 `$computer-use`，Beta 页面与 CDP 必须用 `$playwright-cli`。

## 兼容、迁移与回滚

- Stable 不迁移、不改名、不改变默认路径；现有用户数据保持原位。
- Beta 首次安装使用全新状态，不自动复制 Stable 数据。
- 现有 `pnpm runweave:update`、`pnpm app-server:*` 的正式默认行为保持兼容。
- Desktop Runtime、完整 App、App Server 各自记录上一可用 Beta release；回滚只切换 Beta 指针或 Beta App。
- Beta 状态格式升级必须保留向前迁移能力；无法识别时应安全地选择完整 Beta 初始化，不得回退到 Stable 默认路径。
- 删除 Beta 时只清理 Beta App 和 Beta 专属目录，不删除 Stable App、profile、App Server、hook 或 CLI。

## 高风险点与控制

| 风险                             | 后果                              | 控制要求                                                          |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| 只改 App 文件名、不改应用身份    | 单实例锁或 userData 冲突          | bundle、userData、单实例身份一起隔离                              |
| Stable/Beta 共用 browser profile | backend 互相拒绝启动或停止对方    | Beta 强制独立 profile 与 lock                                     |
| App Server home 传递丢失         | Beta 更新正式 singleton           | 每次动作和 status 都显式记录 Beta home，验收前后比对 Stable owner |
| Beta 覆盖全局 hook/CLI           | Stable 事件和命令被路由到 Beta    | Beta 不拥有全局写入，使用 terminal-scoped 路由                    |
| 两个通道共用更新 feed            | Beta 被正式产物覆盖或反向更新     | Beta 独立 feed 或禁用自动更新                                     |
| 进程匹配只依赖 `Runweave` 字符串 | 更新时误杀正式进程                | 所有退出/等待/验证以 Beta App 路径和通道身份为准                  |
| 状态输出包含 token/密码          | 本机凭证泄漏到日志或 agent 上下文 | status 和日志使用明确 allowlist                                   |
| Beta 失败后没有可用目标          | 自举验证中断                      | 原子安装、last-known-good、显式 rollback                          |

## 最终验收

最终验收以 `docs/testing/runweave-beta-self-hosting-test-cases.md` 为准。计划完成不等于代码合入或构建通过；只有 Stable/Beta 隔离、连续迭代、失败恢复、机器可读状态和真实桌面/页面证据全部通过，才算完成“用 Runweave 开发 Runweave”的目标。
