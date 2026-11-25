# Agent 提问的手机接力

打开 [index.html](./index.html)，或从当前项目的 Files 以 HTML Preview 打开同一文件。也可从 Runweave 的 /prototypes 选择当前 Worktree 下的 terminal-question-handoff。修改后刷新或重新打开。

核心流程为 Codex 提问、Backend 确认原请求、iPhone 提醒、打开时再次核对、回答后原终端继续。首版使用普通通知和现有回复辅助，覆盖受支持的 macOS Codex 共享执行服务。待答事件可供后续全局 Attention 消费。通知正文保留一般提示，鉴权后的问题页读取原题。

源码基线为 c2cea2f2。现有问答连接在读取时建立，提交核对原请求身份，当前 iOS 通知点击只定位电脑。方案增加 Hook 触发后的后台查找、通知与原问题的绑定，以及打开时的状态核对。通知关联原电脑、终端、面板和原问题，连接重建后重新核对活跃请求，再取当前的请求 ID。通知业务类别和定位数据的传输方式在实现时确定。只有收到已处理状态时，界面提示问题已处理。验收另外核对原终端实际采用的答案和后续输出。

原型包含手机接手、电脑先答和连接中断。界面状态、重连、提交和原任务继续均为本地模拟。真实 Codex 0.172.0 的晚接入、Hook 与原请求匹配、旧答案拒绝已有隔离协议证据。后台 APNs 投递、问题级跳转和原生真机交互仍需实测。

现有入口：[提问 Hook](../../../packages/agent-bridge/hooks/runweave-hook-bridge.cjs)、[问答网关](../../../backend/src/terminal/questions/gateway.ts)、[问答服务](../../../backend/src/terminal/questions/service.ts)、[iOS 通知定位](../../../packages/app-ios/Sources/RunweaveIOS/Services/NotificationCoordinator.swift)。

桌面验证使用当前 Worktree 的真实原型预览端点。三种场景、流程高亮、重置、章节跳转均已实际操作。390 px 浏览器视口验证了移动布局和交互，页面无横向溢出。指定 iPhone 当前不可达，原生 Files 阅读尚未验收。

2026-11-26 使用当前 Worktree 的 Debug Runweave App 在共享 iOS 模拟器中通过「文件」打开同一 HTML。修复原型的章节跳转并重新打开后，验证了手机提交、电脑先答隐藏提交按钮、断线重新核对，以及章节跳转。这里观察的是 HTML 原型交互。候选功能的系统推送、原生跳转和真实任务结果按 [实施计划](../../plans/2026-11-26-terminal-question-handoff.md) 分别验收。
