---
name: update-runweave-ios
description: 从当前源码通过统一 CLI 构建、安装并启动 Runweave iOS 到指定或已保存的手机，新构建自动递增产品版本和构建号。用户要求更新或安装 Runweave 到 iPhone 时使用；页面交互验收使用 agent-device。
---

# 更新 Runweave iOS

使用当前工作区的 `pnpm ios:update`，或独立入口 `node packages/app-ios/scripts/ios.mjs update`。先读 iOS 包的 AGENTS.md 和 README。不要另写一套 Xcode、版本分配或安装流程。

1. 有保存的目标时运行 `pnpm ios:update --dry-run --json`；首次目标未知时用 `pnpm ios:update --devices --json` 列设备，按用户意图确认硬件 UDID，不能选第一台或用另一台兜底。
2. 日常更新运行 `pnpm ios:update --json`。首次明确绑定用 `--device <硬件UDID> --team <TEAM_ID>`；用户希望以后沿用时添加 `--save-target`。默认 Release；新构建自动递增产品版本补丁位和构建号，同一产物重装不递增。只有用户要求时改配置或显式指定发布版本。CLI 自动管理版本、源码指纹、签名、设备锁和产物复用。
3. 检查结果的 exitCode、state、build/install/launch 分阶段状态与证据目录。只有 state=updated 且退出码为 0 才报告安装和启动完成。构建完成不等于安装完成；PID 不证明页面业务通过。
4. 更新失败先读本轮日志和 nextAction。已安装但启动失败须分别报告，不自动降级、卸载或重复安装来掩盖问题。签名、配对、Developer Mode 或锁屏阻塞时说明具体准备步骤，不修改 Bundle ID/entitlement 绕过。
5. 交付目标手机、连接方式、更新前后 version/buildNumber、buildId、构建或复用、安装和启动结果。默认 uiVerified=false；用户要求页面验收时继续使用 toolkit:agent-device 实际交互。Clarity 新标签和云端回放须另行验证，不能以构建或启动代替。

此技能不拉源码、不切分支、不提交、不更新 Backend，也不发布到 App Store/TestFlight。
