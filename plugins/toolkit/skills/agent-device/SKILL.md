---
name: agent-device
description: 使用 agent-device CLI 在 iOS 模拟器和真机上复现问题、检查修复及执行有 Agent 监督的原生 UI 验收；提供设备预检、独立会话和证据记录。Web 页面使用 playwright-cli，固定 XCTest 回归保持原入口。
---

# iOS 交互验收

用真实界面完成用户指定流程，并核对每个关键动作的结果。已验证工具版本为 **agent-device 0.21.3**；本技能的辅助脚本只支持 iOS，不把上游其他平台能力当作已验证能力。它是交互取证入口，不是无人值守 CI 或业务通过判定器。

## 建立目标

1. 先读工作区和目标包的 AGENTS.md。区分已安装 App 验收与当前代码验收；后者先按包入口构建、安装，记录产物来源。Runweave Native 是 `com.runweave.app.native`，独立随记是 `com.runweave.suiji`。
2. 用 `xcrun simctl list devices` 或 `xcrun devicectl list devices` 发现设备；真机硬件 UDID 可从 `xcrun devicectl device info details --device <发现的ID> --json-output <本机文件>` 获得。必须指定目标，不以同名设备或第一台设备替代。
3. Runweave 仓库的模拟器先运行 `node scripts/ios-simulators/cli.mjs start --app runweave --task-dir <绝对任务路径> --json`，随记将 app 参数改为 suiji；再按对应 iOS 包入口 `run --task-dir <同一目录>` 构建安装。使用返回的固定 UDID；所有 linked worktree 共用两台设备，忙时等待，不新建或克隆。其他项目仍遵循各自设备策略。
4. 选择独立任务目录，通常为工作区 `.runweave/mobile-qa/<任务名>`。Runweave 模拟器使用 start 已创建的目录；其他目标由辅助脚本首次创建目录并固定设备、App 和随机 session；已有目录不覆盖。真机签名读 [iOS 准备与恢复](references/ios-setup.md)。

下面的 `SKILL_DIR` 是本次实际加载的技能目录；`RUN_DIR` 是绝对路径。将示例占位符换成刚确认的目标：

```bash
python3 "$SKILL_DIR/scripts/device.py" init "$RUN_DIR" \
  --kind device --udid "$IOS_UDID" --app com.runweave.suiji \
  --team-id "$IOS_TEAM_ID" --runner-id "$IOS_RUNNER_ID"
# 模拟器改为 --kind simulator，省略两个签名参数；先启动本任务拥有的模拟器。
python3 "$SKILL_DIR/scripts/device.py" check "$RUN_DIR"
python3 "$SKILL_DIR/scripts/device.py" run "$RUN_DIR" -- open --foreground
```

辅助脚本要求 PATH 上的 CLI 版本匹配；不会自动安装、升级或启用权限。预检只检查当前工具与目标可达性，**不证明签名可安装、UI Automation 已授权或没有其他 XCTest 占用**。先检查已知运行任务，冲突时等待占用者结束；项目配置了设备池时不得另建设备绕过，不能杀掉他人 runner。首次 open 只有返回真实目标树后才证明本轮连接可用。

## 无线更新后的仅启动检查

真机无线 `localNetwork` 与 USB `wired` 均可使用，不把 USB 作为硬性前置。区分两个目标：

- **安装/更新后启动 App**：按原生包入口完成构建安装、核对产物后，用 `launch` 直接走 CoreDevice，不创建 XCTest runner。可用不带 `--team-id` / `--runner-id` 的新任务目录执行 `init --kind device --udid <硬件UDID> --app <BundleID>`；这里只省略自动化 runner 签名，产品 App 的安装签名要求不变。
- **页面操作或 UI 验收**：仍使用带 runner 签名的任务和 `run -- open --foreground`、快照及实际交互；不能用 `launch` 替代。操作前确认没有其他任务正在使用目标手机。

```bash
python3 "$SKILL_DIR/scripts/device.py" launch "$RUN_DIR"
```

`launch` 不安装、不强制重启、不自动重试；返回本次设备连接方式、进程 PID 和原生结果文件，明确标记 `uiVerified: false` / `automationReady: false`。它不启动 agent-device daemon，纯 launch 任务无需 `stop`。无线启动成功不等于 UI 自动化可用，更不等于完整更新/业务验收通过。

`open` 失败时，包装器检查**本次调用新增**的 runner 日志；code 74 / IDE 通道断开会返回 `ios_xctest_bootstrap_failed` 诊断及日志位置，不再仅依赖笼统的连接超时提示。原错误退出状态保留，不自动降级为 launch 成功，不自动重放动作。私密命令不写额外诊断文件。无线 XCTest 失败不阻止另行执行明确的仅启动检查；只有确实需要 UI 时才排查无线调试链路或选择 USB 对照。

## 操作与判定

```bash
python3 "$SKILL_DIR/scripts/device.py" run "$RUN_DIR" -- snapshot -i
python3 "$SKILL_DIR/scripts/device.py" run "$RUN_DIR" -- press @e12 --settle
python3 "$SKILL_DIR/scripts/device.py" run "$RUN_DIR" -- wait 'role="button" label="预期控件"' 5000
python3 "$SKILL_DIR/scripts/device.py" run "$RUN_DIR" -- snapshot --json
python3 "$SKILL_DIR/scripts/device.py" run "$RUN_DIR" -- screenshot "$RUN_DIR/final.png"
```

- 使用最新快照或差异中的 ref；UI 变化后旧 ref 不再可靠。同名控件加 role 或读取完整树确认唯一目标。需要其他命令时读已安装版本的 `agent-device help <command>`。
- `snapshot -i` 会省略真实可见控件。找不到按钮、命中父容器或标签歧义时，读取完整 `snapshot --json`；必要时查看截图，用已观察到的边界选点。卡片中有链接或完成按钮时避开重叠区域，不能盲点卡片中心。
- 快照可能仍来自绑定 App，而屏幕已跳到浏览器。跨 App 跳转、点击后无变化或树与预期矛盾时，实际查看 screenshot，再决定是否重新 `open --foreground` 返回目标。截图像素与树的逻辑坐标可能有倍率差异。
- `open` exit 0 可能带初始快照失败警告；`--settle` 超时和 `XCTEST_RECORDED_FAILURE` 都可能发生在动作已生效之后。**先重新观察实际状态，再决定下一步；对保存、删除、完成待办等写操作，不因报错自动重试。** 必要时用获授权的只读 API 确認记录 ID、版本或删除状态。
- 包装器将上游初始快照失败和 settle 超时转为非零退出，但不能识别所有业务失败。命令成功、元素存在、截图都不是业务后置条件的替代品。
- 账号和环境沿用用户意图。正式数据优先只读；草稿验证先确认空白或隔离原草稿，使用唯一标记，验收后清理自己的草稿。不保存测试记录到正式服务，除非任务已授权该写入。
- 登录优先由用户在设备输入凭据。不得将密码、token 写进技能、脚本、配置、回放或 Git。截图/树可能含用户内容，证据留在本机任务目录；敏感步骤用 `run "$RUN_DIR" --private -- <命令>` 跳过包装器输出落盘，但它不保证上游 daemon 没有日志，不能当成密码保密方案。
- 验证重启恢复时明确使用 `open --relaunch`，等自动连接完成，再检查登录和草稿；普通 open/close 不能替代进程重启。

## 录制、收尾与交付

只有需要可重复流程时才录制：关闭现有会话后，用 fresh session 的 `open --foreground --save-script "$RUN_DIR/flow.ad"` 开始，完成必要状态断言，再执行 `session save-script`。检查生成脚本：失败动作可能没被录入，敏感输入不能进入脚本。

从明确前置状态执行 `replay "$RUN_DIR/flow.ad" --json`；保留原始结果和实际步骤数。遇到 `REPLAY_DIVERGENCE/identity-mismatch`，读取新树分析或重新录制，不删除身份元数据来制造通过。一次回放成功不证明 CI 稳定性；自动录制 `.ad` 是本机产物，不替代仓库 YAML 验收合同。

```bash
python3 "$SKILL_DIR/scripts/device.py" stop "$RUN_DIR"
```

Runweave 模拟器完成任务后执行 `node scripts/ios-simulators/cli.mjs finish --task-dir <任务目录> --json`；它清理本任务自动化并释放 lease，异常恢复按仓库 `docs/cli/ios-simulators.md`。

stop 只清理该任务 state-dir 的会话、daemon 和 runner，不卸载 App，也不关闭模拟器。仅在本任务创建/拥有的模拟器上另行 shutdown。签名执行器按用户意图保留，不能为腾名额自动卸载其他 App。

交付说明：测试的设备、App/构建来源、业务后置条件及证据、失败/未执行项、清理结果。任务目录的 `metrics.jsonl` 只记录命令类型、耗时和退出码，不记录命令参数；编号 `.log` 是 CLI 原始输出。业务结论由 Agent 结合实际状态填写，不把命令 exit 0 自动标成用例通过。
