# 按需录屏的浏览器 MCP 验证

本文定义一种任务完成后的可审计验收方式：当用户明确要求录屏验证时，智能体在最终浏览器 MCP 验证过程中录制浏览器 MCP 实际操作的页面，并把录屏和验证元数据保存到本地 artifact 目录。

这里的“浏览器 MCP 实际操作的页面”优先指 Runweave Terminal Browser 暴露给 MCP/CDP Proxy 的目标 tab；在当前工具链还没有 Electron 原生页面录制器时，也允许录制当前浏览器 MCP 页面 viewport。录屏对象必须是 MCP 正在操作的页面内容，不能录制整个屏幕，不能录制整个 Electron 主窗口，也不能用 Playwright 自己创建的 browser context video 代替。

## 背景

智能体完成代码任务后，通常会通过类型检查、lint、E2E、浏览器 MCP 手工路径等方式验证结果。自动化断言能证明部分行为符合预期，但最终的浏览器 MCP 验收常常只体现在文字报告里。用户无法回看智能体当时实际操作的是哪个页面、点击了什么路径、最终状态是否就是报告里的状态。

录屏验证要解决的是这个证据缺口：把“我通过浏览器 MCP 看过了”变成“本地有一段可回看的最终验收过程”。当前已验证实现录制的是浏览器 MCP 实际操作的页面 viewport；未来 Electron 原生 recorder 可以升级为 Terminal Browser tab 的 `webContents` 页面帧录制。

## 目标

- 只在用户明确要求时启用录屏验证。
- 录制最终浏览器 MCP 验收过程，而不是默认录制所有测试。
- 录制对象必须是 MCP 当前操作的页面内容。当前已验证路径是浏览器 MCP 页面 viewport 连续帧录制；未来 Electron recorder 可升级为 Terminal Browser tab 的 `webContents` 页面帧录制。
- 将录屏、target 绑定信息、验证步骤、命令结果和环境信息组织成一次本地验证证据包。
- 让用户可以在任务结束后直接打开本地录屏复核。
- 录屏以体积小为优先，只要求能看清验证路径和最终状态，不追求高清画质。
- 当目标页面录制不可用时，明确报告失败原因，不用整屏录制、窗口录制或截图序列包装成“录屏成功”。

## 非目标

- 不把录屏作为所有任务的默认验证步骤。
- 不用 Playwright video 替代浏览器 MCP 验收录屏。
- 不录制整个 macOS 屏幕。
- 不录制整个 Electron 主窗口。
- 不采集与验收无关的桌面、侧边栏、终端或系统通知。
- 不把录屏作为通过/失败的唯一判定依据。
- 不要求 CI 默认上传或保留录屏。
- 不做高码率、高清晰度、长期归档级录制。
- 不录制敏感页面或凭据输入过程，除非用户明确接受该风险。

## 触发条件

只有用户在当前任务里明确表达需要录屏类证据时才启用：

- “最后录屏验证”
- “需要录屏验收”
- “浏览器 MCP 验证过程录下来”
- “完成后保存验证录屏”
- “需要视频证据”
- “保存一段可回放的验收视频”

如果用户只是要求“浏览器 MCP 验证”“用浏览器 MCP 看一下”“跑一下 MCP 验收”，但没有要求录屏、视频或可回放证据，仍按普通浏览器 MCP 验证执行，不生成录屏证据包。

即使用户在任务开始时提前声明需要录屏验收，也不要把录屏流程前置到需求分析、方案设计、编码实现、普通调试或中间验证阶段。智能体应先按普通任务流程完成实现和常规验证；当准备调用浏览器 MCP 执行最终验收路径时，启动录屏，然后在录屏中完成那次浏览器 MCP 操作。

## 验证分层

录屏验证不是替代测试，而是最终证据层。

| 层级            | 作用                           | 是否录屏 |
| --------------- | ------------------------------ | -------- |
| 静态验证        | 类型检查、lint、构建           | 否       |
| Playwright E2E  | 自动化断言关键路径             | 默认否   |
| 浏览器 MCP 验证 | 观察真实页面、执行最终验收路径 | 按需是   |
| 录屏证据包      | 让用户回看验收过程             | 按需是   |

Playwright E2E 可以作为录屏前的前置检查。它可以发现确定性回归，但它录制的是 Playwright 管理的 browser context，不能证明最终浏览器 MCP 验收时智能体实际操作的是哪个真实页面。因此 Playwright video 只能作为补充产物，不能替代最终页面录制。

## 录制对象定义

一次有效录屏必须满足以下绑定条件：

- `targetType` 为 `browser-mcp-page-viewport` 或 `terminal-browser-tab`。
- 当前已验证方案的 `captureSource` 为 `current-browser-mcp-page-screenshot-frames`。
- 未来 Electron 原生方案的 `captureSource` 可为 `electron-webcontents-frame`，但必须先实现并验证 recorder。
- 当前已验证方案必须记录当前页面 URL、title、viewport 尺寸、帧数、时长、操作步骤和最终 API 验证结果。
- 未来 Electron 原生方案必须记录 `windowId`、`tabId`、`targetId`、初始 URL、初始 title 和是否激活。
- 录制结束后必须记录结束 URL、结束 title、视频尺寸、帧数和时长。

如果无法证明录制源和 MCP 操作的是同一个页面，本次录屏状态必须是 `failed`。

## 可行实现策略

### 当前已验证方案：浏览器 MCP 页面 viewport 连续帧录制

这是当前已经实际跑通的默认方案。它录制的是浏览器 MCP 当前页面 viewport，不录制整个屏幕，也不录制 Electron 外壳。

1. 启动本地应用，例如 `pnpm dev`。
2. 创建 `artifacts/verification-runs/<timestamp>/frames/`。
3. 使用浏览器 MCP 打开本地页面。
4. 在同一个浏览器 MCP 页面中启动连续截图循环，按固定间隔保存 viewport 帧，例如 250ms 一帧。
5. 在截图循环仍在运行时执行当前任务最终验收所需的真实浏览器 MCP 操作。操作步骤来自当前任务，不由本文档写死。
6. 流程结束后停止截图循环，并保存最后一帧。
7. 用 `ffmpeg` 把 `frames/%06d.png` 编码为 `recording.mp4`。
8. 用 `ffprobe` 校验视频宽高、时长和帧数。
9. 写入 `manifest.json`，记录录制状态、文件路径、页面 URL、步骤、帧数、时长和最终 API 验证结果。
10. 最终回复必须给出 `recording.mp4` 和 `manifest.json` 的本地路径。

如果本次最终验收涉及 Runweave 终端项目，项目路径必须指向当前任务的 repo 工作区。不要为了录屏新建 `/tmp` 空目录，也不要把代码复制到临时目录后再验收；否则录到的是另一个项目，不能证明当前项目的终端流程。

经过验证的编码命令示例：

```bash
ffmpeg -y -framerate 4 \
  -i artifacts/verification-runs/<timestamp>/frames/%06d.png \
  -vf "format=yuv420p" \
  -c:v libx264 -crf 28 -preset veryfast \
  artifacts/verification-runs/<timestamp>/recording.mp4
```

经过验证的结果形态：

- `recording.mp4`：H.264 MP4，可本地直接播放。
- `manifest.json`：`recording.status` 为 `succeeded`，并包含 `frameCount`、`durationMs`、`width`、`height`。
- `frames/`：保留原始帧，便于排查录制失败或画面异常。

### 未来增强方案：激活目标 tab 后录制该 tab 的 `webContents` 页面帧

这是更严格的 Terminal Browser tab 级方案，但当前需要先实现 Electron 主进程 recorder。

1. 浏览器 MCP 通过 Terminal Browser CDP Proxy 打开或选中目标页面。
2. 录制控制器读取 MCP/CDP Proxy 的 target 列表，确定本次验收 target。
3. Electron 主进程用 `getTerminalBrowserEntryByTargetId(targetId)` 找到目标 tab 的 `WebContentsView` 和 `webContents`。
4. 录制开始前调用现有 `activateTerminalBrowserTabFromProxy(targetId)` 或等价路径，把右侧 Browser 切到对应 tab。
5. 录制器只从该 `webContents` 抓取页面帧，不读取屏幕，不读取 Electron 主窗口图像。
6. 智能体继续使用浏览器 MCP 对同一个 target 执行导航、点击、输入、滚动和断言。
7. 录制器按固定帧率采集页面帧，写入本地临时帧目录。
8. 验收结束后把帧编码为 `recording.mp4` 或 `recording.webm`。
9. 录制器抽样校验首帧、中间帧、末帧不是空白，尺寸大于 0，且 manifest 中的 target URL/title 与 MCP 验收记录一致。

该方案允许前台切换到对应 Browser tab，因为用户要求“要么就切换到对应的 tab 进行录屏”。它不会录制整个屏幕，也不会把 Electron 外壳、终端或系统窗口录进去。实现前不得把它描述成当前可用能力。

### 后台录制能力：必须先做专项验证

后台录制只有在经过专项验证后才能进入默认流程。验证标准：

- 目标 tab 不在当前可见 Browser tab 时，录制帧仍然来自同一个 `webContents`。
- 隐藏、切 tab、窗口最小化、Browser 面板宽高变化时，帧不是空白、不是上一帧缓存、不是外层 Electron 画面。
- MCP 对后台 target 执行导航、输入、点击后，录制内容能反映这些页面变化。
- 同一次录制中 `targetId` 不漂移，关闭 target 后录制能立即失败并写入原因。

在这些验证完成前，后台录制不能写入方案承诺。当前默认行为是切换到对应 Browser tab 后进行前台页面录制。如果用户明确要求不能切 tab，而后台录制尚未验证通过，则本次录屏能力应报告为不可用。

### 不采用的方案

- **整屏录制**：会捕获桌面其他窗口，不满足“实际打开的页面”边界。
- **Electron 主窗口录制**：会捕获侧边栏、终端、地址栏外壳和其他 UI，不满足页面级边界。
- **Playwright video**：录制的是 Playwright context，不是浏览器 MCP 实际操作的当前页面。
- **外部再连一个 CDP screencast 客户端**：当前 CDP Proxy 已通过 `webContents.debugger` 管理 MCP 会话；额外 debugger 连接会和现有 MCP attach 抢占或干扰。只有把录制集成进现有 CDP Proxy/session 管理后，才可以评估 `Page.startScreencast` 一类方案。
- **截图序列冒充录屏**：截图序列可以作为失败排查附件，但不能在未编码成视频且未通过 manifest 校验时标记为录屏成功。

## 推荐流程

当用户明确要求录屏类证据时，智能体按以下顺序执行当前已验证流程：

1. 完成代码修改。
2. 执行与变更范围匹配的常规验证，例如 `pnpm run typecheck`、`pnpm run lint`、相关 E2E 或质量门禁。
3. 创建本地验证目录。
4. 初始化 `manifest.json`，记录本次录屏验收请求和前置验证结果。
5. 启动本地应用并确认可访问 URL。
6. 通过浏览器 MCP 打开本次验收页面。
7. 启动浏览器 MCP 页面 viewport 连续帧录制。
8. 使用同一个浏览器 MCP 页面执行最终验收路径。
9. 停止页面帧录制并用 `ffmpeg` 编码为视频。
10. 用 `ffprobe` 校验视频宽高、时长和帧数。
11. 用 UI 最终状态、API 查询或用户指定的判定条件校验业务结果。
12. 更新 `manifest.json`，写入录屏状态、路径、失败原因或调试附件。
13. 在最终回复中给出录屏路径、验证命令和浏览器 MCP 覆盖路径。

无论录屏结果是 `succeeded` 还是 `failed`，都必须写入 `manifest.json`。如果页面级录制不可用，智能体必须更新 `manifest.json` 后停止并说明原因；不能自动改用整屏录制、窗口录制或截图序列。

## Artifact 目录

所有本地证据默认写入：

```text
artifacts/verification-runs/<timestamp>/
```

建议结构：

```text
artifacts/verification-runs/2026-04-30T12-30-00/
  manifest.json
  recording.mp4
  quality-report.json
  e2e/
    trace.zip
    video.webm
  debug-frames/       # only when recording failed after frames were captured
    000001.png
    000120.png
  notes.md
```

`artifacts/` 已在仓库 `.gitignore` 中忽略，验证证据默认不进入提交。

## manifest.json

`manifest.json` 是一次录屏验收的索引文件。

```json
{
  "schemaVersion": 2,
  "kind": "browser-mcp-recorded-verification",
  "createdAt": "2026-04-30T12:30:00.000Z",
  "repo": "/Users/bytedance/Desktop/vscode/browser-hub/run-weave",
  "branch": "feature/example",
  "commit": "abcdef123456",
  "requestedByUser": true,
  "recording": {
    "status": "succeeded",
    "path": "artifacts/verification-runs/2026-04-30T12-30-00/recording.mp4",
    "tool": "browser-mcp-page-frame-capture-plus-ffmpeg",
    "targetType": "browser-mcp-page-viewport",
    "captureSource": "current-browser-mcp-page-screenshot-frames",
    "profile": "small-file",
    "fps": 4,
    "width": 1440,
    "height": 960,
    "frameCount": 31,
    "durationMs": 7750,
    "error": null
  },
  "target": {
    "url": "http://localhost:5174/example-final-acceptance-page",
    "pageTitle": "Runweave",
    "acceptancePath": [
      "open the page required by the current task",
      "perform the real browser MCP acceptance steps",
      "verify the final expected state"
    ],
    "repo": "/Users/bytedance/Desktop/vscode/browser-hub/run-weave"
  },
  "preflight": [
    {
      "command": "pnpm run typecheck",
      "status": "passed"
    },
    {
      "command": "pnpm run test:e2e -- tests/smoke.spec.ts",
      "status": "passed"
    }
  ],
  "browserMcp": {
    "client": "codex-browser-mcp",
    "steps": [
      "open the target page",
      "exercise the changed workflow",
      "verify the expected final UI state"
    ]
  },
  "postcheck": {
    "videoFileVerified": true,
    "frameCountVerified": true,
    "apiProjectStatus": 200,
    "apiSessionStatus": 200,
    "acceptancePassed": true
  },
  "notes": "No console errors observed during the recorded path."
}
```

字段要求：

- `requestedByUser` 必须为 `true`，用于区分按需录屏和普通验证。
- `recording.status` 只能是 `succeeded` 或 `failed`。
- `recording.targetType` 必须是 `browser-mcp-page-viewport` 或 `terminal-browser-tab`。
- `recording.captureSource` 必须描述真实页面帧来源，不能写成 `screen` 或 `electron-window`。
- `manifest.json` 是强制产物。即使录屏启动失败，也必须写入 `recording.status: "failed"` 和失败原因。
- `recording.path` 只在存在可回放视频时填写；启动失败或编码失败时应为 `null` 或省略。
- `recording.error` 在 `failed` 时必须填写简短原因。
- `target` 必须记录页面级 target 绑定信息和本次真实 MCP 验收路径；只有当流程涉及项目、终端或其他业务实体时，才记录对应实体字段。
- `preflight` 记录录屏前执行过的命令，不要求覆盖所有测试。
- `browserMcp.steps` 记录用户能从录屏里对应到的关键验收动作。
- `postcheck.videoFileVerified` 和 `postcheck.frameCountVerified` 必须为 `true` 才能把录屏标记为 `succeeded`。

## 编码与体积策略

- 默认文件名使用 `recording.mp4`。
- 优先使用 H.264 MP4，方便本地播放器直接打开。
- 如果本机缺少 MP4 编码能力，允许输出 `recording.webm`，但必须在 `manifest.json` 写入真实路径和编码工具。
- 录制参数以小文件为目标。推荐 8-12 FPS、目标页面原始尺寸或 720p 下采样、低到中等码率。
- 验收视频只需要看清点击路径、页面变化和最终状态，不需要文本像素级清晰。
- 如果编码失败，保留 `frames/` 或少量 `debug-frames/` 作为排查附件，但 `recording.status` 仍然必须是 `failed`。

## 权限与隐私

页面级录制不会捕获桌面其他窗口，但仍会捕获目标网页里的账号信息、业务数据、URL 参数和输入内容。执行前应尽量降低暴露面：

- 不在录屏中输入真实密码、token 或 cookie。
- 优先使用测试账号、测试环境和可公开的复现数据。
- 不把录屏上传到远端；最终回复只给本地路径。
- 如果验收必须经过敏感页面，先说明风险并等待用户明确授权。

## 失败处理

录屏失败时，最终回复必须区分以下情况：

- 常规验证失败：任务还没有达到可验收状态。
- 页面绑定失败：无法证明录制对象是 MCP 当前操作的页面。
- 页面帧采集失败：当前浏览器 MCP 页面存在，但无法采集有效 viewport 帧。若使用未来 Electron 原生 recorder，则对应为无法从目标 `webContents` 获取有效帧。
- 视频编码失败：页面帧可能已采集，但没有可回放视频。
- 浏览器 MCP 验证失败：录屏应保留，用于复查失败现场。

禁止把“已跑 E2E”描述成“已录屏验证”。
禁止把整屏录制、Electron 窗口录制、Playwright video 或截图序列描述成浏览器 MCP 页面录屏。

## 与现有质量体系的关系

本机制补充现有质量体系，不改变现有测试分层：

- `docs/testing/command-matrix.md` 继续定义变更类型对应的验证命令。
- `docs/quality/quality-harness.md` 继续定义质量体系边界。
- `docs/quality/ai-diagnostic-logging.md` 可以作为后续扩展方向，把诊断日志和录屏证据包关联起来。
- `docs/testing/terminal-browser-cdp-mcp-test-cases.md` 可以作为 Terminal Browser / MCP 场景下的 target 绑定和安全验收来源。
- `.agents/skills/recorded-browser-mcp-verification/SKILL.md` 固化了当前已验证的录屏流程。该 skill 只在用户明确要求录屏验证、录屏验收、保存浏览器 MCP 验证录屏或视频证据时使用；仅要求普通浏览器 MCP 验证时不要使用。

## 最终回复格式

当录屏验证成功时，最终回复应包含：

```text
验证完成。

常规验证：
- pnpm run typecheck: passed
- pnpm run test:e2e -- tests/smoke.spec.ts: passed

浏览器 MCP 页面录屏验证：
- 录制对象：当前浏览器 MCP 页面 viewport
- 覆盖路径：<本次任务真实执行的浏览器 MCP 验收路径>
- 录屏：artifacts/verification-runs/<timestamp>/recording.mp4
- 元数据：artifacts/verification-runs/<timestamp>/manifest.json
```

当页面级录屏不可用时，最终回复应包含：

```text
常规验证通过，但浏览器 MCP 页面录屏没有完成。

原因：无法从浏览器 MCP 当前页面采集有效 viewport 帧。
元数据：artifacts/verification-runs/<timestamp>/manifest.json
录屏状态：failed
```

## 后续可落地项

- 将当前已验证的浏览器 MCP 页面 viewport 连续帧录制流程沉淀为脚本，减少手写 `browser_run_code` 的失误。
- 新增 Electron 主进程录制服务，负责根据 `targetId` 绑定 Terminal Browser `webContents`、采集页面帧、停止录制并写入状态。
- 新增本地控制脚本，只负责创建 artifact 目录、调用录制服务、编码视频、写入 `manifest.json`；它不能录整屏或 Electron 外壳。
- 增加后台录制 spike：分别覆盖可见 tab、非激活 tab、隐藏 Browser 面板、窗口最小化、target 关闭、MCP 导航和 MCP 输入。
- 为质量门禁报告增加可选 `verificationArtifacts` 字段。
- 为浏览器 MCP 验收建立最小步骤模板，避免每次只靠自然语言回忆。
- 增加录屏前隐私检查清单。
