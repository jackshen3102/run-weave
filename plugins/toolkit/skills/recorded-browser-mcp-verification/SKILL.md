---
name: recorded-browser-mcp-verification
description: 当用户明确要求录屏验证、录屏验收、保存浏览器 MCP 验证录屏或视频证据时使用。仅要求浏览器 MCP 验证、普通调试、测试或验收检查时不要使用。
---

# 浏览器 MCP 录屏验证

## 硬触发规则

这个 skill 只能在用户明确要求录屏类证据时启用。

- 用户明确要求“录屏验证”“录屏验收”“把浏览器 MCP 验证录下来”“保存验证录屏”“视频证据”时，可以使用这个 skill。
- 这个 skill 只包住任务末尾那次最终浏览器 MCP 验收：先按普通任务流程完成实现和常规验证；当准备调用浏览器 MCP 执行最终验收路径时，启动录屏，然后在录屏中完成那次浏览器 MCP 操作。
- 不要在需求分析、方案设计、编码实现、普通调试或中间验证阶段使用这个 skill。
- 如果用户只是要求“浏览器 MCP 验证”“用浏览器 MCP 看一下”“跑一下 MCP 验收”，但没有要求录屏、视频或可回放证据，按普通浏览器 MCP 验证执行，不要使用这个 skill。
- 如果这个 skill 被误加载，立刻停止遵循它，按普通任务规则继续；只有用户明确要求录屏类证据，并且进入最终浏览器 MCP 验收调用点时，才重新考虑是否启用。

## 目的

为 Runweave 的真实浏览器 MCP 验收流程生成本地视频证据。录屏必须捕获浏览器 MCP 实际操作的页面 viewport，不能录整个屏幕，不能录整个 Electron 应用，也不能用 Playwright 自己的 context video 作为最终证据。

## 必须产物

每次成功执行都必须创建：

- `artifacts/verification-runs/<timestamp>/recording.mp4`
- `artifacts/verification-runs/<timestamp>/manifest.json`
- `artifacts/verification-runs/<timestamp>/frames/*.png`

最终回复必须包含 `recording.mp4` 和 `manifest.json` 的可点击路径。

## 通用执行流程

这个 skill 不定义固定业务操作。真实操作步骤来自当前任务的最终浏览器 MCP 验收路径；录屏只负责包住那次浏览器 MCP 操作。

1. 使用 `pnpm dev` 启动应用。
2. 等待 Vite 打印本地 URL，通常是 `http://localhost:5174/`。
3. 创建 artifact 目录：

   ```bash
   mkdir -p artifacts/verification-runs/<timestamp>/frames
   ```

4. 明确本次最终浏览器 MCP 验收要执行的真实步骤。这些步骤来自当前任务本身，不能被这个 skill 写死。

5. 如果本次验收需要创建或选择 Runweave 终端项目，项目路径必须使用当前正在工作的 repo 目录，也就是执行任务时的当前工作区路径。不要创建 `/tmp` 空目录，不要复制代码到别的目录。

6. 在同一个浏览器 MCP 页面中启动页面 viewport 截图循环。

7. 截图循环运行期间，执行第 4 步确定的真实浏览器 MCP 操作路径。

8. 操作结束后停止截图循环，并用 API、UI 最终状态或用户指定的判定条件确认验收结果。

9. 编码帧序列：

   ```bash
   ffmpeg -y -framerate 4 \
     -i artifacts/verification-runs/<timestamp>/frames/%06d.png \
     -vf "format=yuv420p" \
     -c:v libx264 -crf 28 -preset veryfast \
     artifacts/verification-runs/<timestamp>/recording.mp4
   ```

10. 校验视频：

```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,nb_frames,duration \
  -of json artifacts/verification-runs/<timestamp>/recording.mp4
```

11. 写入 `manifest.json`，至少包含：

- `recording.status: "succeeded"` 或 `"failed"`；
- 录屏路径；
- 帧数；
- 宽高；
- 时长；
- 本次真实浏览器 MCP 操作步骤；
- 最终验收判定结果；
- 如果本次流程涉及项目或终端，再记录对应项目 id、项目路径和终端 session id。

12. 结束前停止本 skill 启动的所有 dev server。

## 浏览器 MCP 捕获模式

当前已验证实现使用浏览器 MCP 页面截图。捕获循环必须和 UI 操作同时运行：

```js
const path = "/absolute/repo/artifacts/verification-runs/<timestamp>/frames";
let frame = 0;
let recording = true;

const capture = async () => {
  frame += 1;
  await page.screenshot({
    path: `${path}/${String(frame).padStart(6, "0")}.png`,
    fullPage: false,
  });
};

const recorder = (async () => {
  while (recording) {
    await capture();
    await page.waitForTimeout(250);
  }
  await capture();
})();

try {
  // 在这里执行本次任务真实的浏览器 MCP 验收路径。
} finally {
  recording = false;
  await recorder;
}
```

不要使用操作系统屏幕录制。不要使用 Electron 窗口录制。不要把 Playwright video 当作最终证据。

## 本地开发默认值

- 默认命令：`pnpm dev`
- 如果最终验收路径需要登录，默认本地账号是用户名 `admin`，密码 `admin`。
- 具体 UI 操作必须来自当前任务的最终验收要求，不要默认执行固定流程。
- 如果最终验收涉及 Runweave 终端项目，项目路径必须指向当前 repo 工作区，例如当前任务的 `pwd`。不要为了录屏验收新建 `/tmp` 空项目，也不要复制代码到临时目录；否则验收的终端就不是当前项目，录屏证据没有意义。
- 后端日志中的 `openclaw ENOENT` 对当前流程是非阻塞的，除非用户要求的场景依赖默认 CDP endpoint 解析。

## 失败规则

- 如果没有生成 `recording.mp4`，必须说明录屏失败。不能声称 UI 流程已经被录制。
- 如果只有截图帧，编码失败，`recording.status` 必须保持 `"failed"`。
- 如果 UI 流程成功但录屏失败，必须分别报告这两个事实。
- 如果 dev server 无法启动，不能伪造 artifact。
- 如果缺少 `ffmpeg`，报告缺失依赖，并写入失败状态的 manifest。

## 最终回复格式

最终回复保持简洁：

```text
录屏已生成：
- 录屏：artifacts/verification-runs/<timestamp>/recording.mp4
- 元数据：artifacts/verification-runs/<timestamp>/manifest.json

覆盖路径：<本次任务真实执行的浏览器 MCP 验收路径>
验证结果：<本次任务的最终验收判定结果>
```
