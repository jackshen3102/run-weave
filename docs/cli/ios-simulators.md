# 共享 iOS 模拟器

Runweave 仓库的 linked worktree 共用两台已有模拟器。两个 App 都能使用任一台设备；
注册表中的 App 名称仅决定默认优先顺序，不限制设备能运行哪个 App。
项目身份取 Git common directory 的真实路径摘要；端口、分支和 worktree 路径不改变设备池。
安装入口需要 macOS、Xcode、Node 和 Python 3.9+。原生 UI 使用主动安装的 agent-device 0.21.3。
本功能不安装技能，不依赖 Desktop 或 Backend。

## 日常使用

在当前 worktree 根目录执行，下面的 task-dir 每个任务必须换一个新目录：

```bash
node scripts/ios-simulators/cli.mjs status --json
node scripts/ios-simulators/cli.mjs start --app runweave --task-dir .runweave/mobile-qa/my-task --json
node packages/app-ios/scripts/ios.mjs run --task-dir "$PWD/.runweave/mobile-qa/my-task"
```

随记使用 `--app suiji` 申请，并调用 `packages/suiji-ios/scripts/ios.mjs run`。
`run` 执行当前 worktree 的增量构建、安装和二进制核对，然后启动 App。
默认 Debug，可指定 `--configuration Debug|Profile|Release`。
`--simulator` 可省略；若提供，必须与 task-dir 中记录的 UDID 相同。
单独 `build --simulator <UDID>` 不安装、不占用设备，但与同目录构建互斥。

随后使用本次加载的 [agent-device 技能](../../plugins/toolkit/skills/agent-device/SKILL.md)：

```bash
python3 "$SKILL_DIR/scripts/device.py" init "$PWD/.runweave/mobile-qa/my-task" \
  --kind simulator --udid <start返回的UDID> --app com.runweave.app.native
python3 "$SKILL_DIR/scripts/device.py" run "$PWD/.runweave/mobile-qa/my-task" -- open --foreground
python3 "$SKILL_DIR/scripts/device.py" run "$PWD/.runweave/mobile-qa/my-task" -- snapshot --json
node scripts/ios-simulators/cli.mjs finish --task-dir .runweave/mobile-qa/my-task --json
```

`finish` 清理该任务的 daemon/runner 后释放设备；不会卸载 App、擦除数据或关闭模拟器。
对 agent-device 0.21.3，先核验 runner 的任务归属及 PID 启动身份，再请求 XCTest 正常结束，
确认退出后才清理 daemon，避免直接终止执行器触发 SpringBoard 崩溃。
`runner-shutdown.json` 记录退出结果；身份不符、请求失败或退出超时会保留占用并返回
`cleanup_incomplete`，检查任务证据后再对同一任务重试，不会退回强杀。
技能的 `stop` 只停止自动化，完整任务仍须 `finish`。两次 UI 命令之间不会释放占用。
默认优先选择 App 同名槽位，忙时自动使用另一台空闲设备；两台都不可用才返回
`device_busy` 或 `pool_device_missing`。`--slot` 可指定只申请某一台；lease 分别记录实际 App
与物理槽位，安装仍检查 App 身份。任务结束后不删除另一 App 或数据。

若两台都被占用，`start` 会尝试回收连续 **30 分钟**没有托管操作的租约。
回收仍要核对原 lease、无活动操作、无未退出子进程，并通过 `finish` 的 daemon/runner
安全清理流程；任何身份不明、runner 清理失败或设备外部占用都会保留旧租约并返回占用。
长时间分析期间需要保留设备的任务，应在空闲期限前通过同一 task-dir 执行托管操作；
旧任务在回收后不能继续操作或释放新租约。`status --json` 显示 `idleSeconds` 和
`idleExpired`，后者仅表示达到回收时限，仍可能因清理未完成而无法回收。

固定 XCTest 用 `node scripts/ios-simulators/cli.mjs exec --task-dir <目录> -- xcodebuild <套件参数>`。
工具固定 destination 为 lease 的 UDID，并关闭并行测试；不接受调用者覆盖 destination/并行参数。
不要绕过入口直接安装、操作 UI 或使用会克隆设备的 Xcode 并行测试。

## 初始化与恢复

首次由维护者核对占用和数据后，显式接管两台已有设备：

```bash
node scripts/ios-simulators/cli.mjs adopt --runweave <UDID> --suiji <另一UDID>
```

注册表在 `~/.runweave/ios-simulators/<repositoryId>/pool.json`。
设备锁沿用 `~/.runweave/native-device/locks/<UDID>`；状态转换由内核文件锁串行执行，
任务 lease 显式持久化，短命 CLI 退出不等于释放。
重新 adopt 要求新旧映射涉及的所有设备均无任务；工具保存前一次注册表备份。
设备缺失或 runtime 不可用时阻塞，不创建替代设备。

异常后先读 `status --json`、目标 owner.json、任务日志和进程记录，再恢复指定 lease：

```bash
node scripts/ios-simulators/cli.mjs recover --lease <旧lease> --udid <UDID> --json
```

活跃/未知子进程、损坏 owner 或未完成的 runner 清理都会阻塞恢复。
工具只在安全清理成功后回收过期空闲租约，不按超时强行抢锁，不 killall，
不自动重放业务操作；旧 lease 不能释放后来任务。
`free/busy/blocked/missing` 是池状态，`Booted/Shutdown` 是设备状态，关机不表示空闲。
退出码：成功 0，构建/执行失败 1，参数/映射错误 2，占用 3，身份或清理未确定 4。

## 数据和证据边界

设备按 App 复用，所以同 Bundle ID 的不同分支共享登录、草稿和设置。
每例自行建立前置状态，仅清理本例数据；不兼容的数据迁移或干净设备测试需要单独维护窗口。
构建目录仍按 worktree 隔离，不共享 DerivedData。
`installed-app.json` 记录 HEAD、含未提交源码的输入摘要、产物路径、已核对的二进制摘要、UDID 和 lease；
Debug dylib 也参与二进制摘要。二进制核对不能替代真实 UI 或业务结果验收。

两台上限由托管入口落实，无法禁止手工 simctl 或未升级的旧脚本。
所有参与验证的 worktree 和用户主动安装的技能都需要使用新入口；不自动复制到用户技能目录。
`status` 列出的 unmanagedDevices 只是池外设备，不证明它们属于本项目或可以删除。
没有自动删除设备/runtime 的功能；迁移删除必须先确认使用者、数据保留要求和准确 UDID 清单。

验收合同：[共享模拟器用例](../testing/app/ios-simulator-pool.testplan.yaml)。
