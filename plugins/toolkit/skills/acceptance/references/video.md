# 视频输入与制作

## 生成

只在需要编辑视频时运行 `video.py doctor`。制作依赖 Python 3.9+、ffmpeg/ffprobe 和本机 OpenScreen；已装软件只核对缺失项，不自动改全局 MCP 配置或关闭用户应用。首次安装核对[官方发布](https://github.com/getopenscreen/openscreen/releases)的平台、版本、校验值与签名，沿用已有授权。

`video.py build --input <video.json> --output <新目录>` 直接调用 OpenScreen stdio MCP，不要求当前 Agent 热加载 MCP 工具。每次新建自己的工程/checkpoint，固定字幕与缩放、720p/30 FPS 导出，再压缩为静音 H.264 fast-start MP4，完整解码并抽帧。输出包含 `review.mp4`、主片、工程文档、输入、来源哈希、调用记录与制作 manifest。`rendered` 仅表示制作成功，不表示业务验收或手机通过；实际检查另按[交付规则](delivery.md)记录。

## 已有原片

把当前任务的原片放在独立产物目录，或引用已存在的绝对路径。不要移动、覆盖历史证据。`video.json` 的相对路径相对于它自身所在目录解析，不依赖调用脚本时的工作目录。

```json
{
  "schemaVersion": 1,
  "title": "文件预览的操作变化",
  "video": "recording.mp4",
  "source": {
    "surface": "installed-stable-web",
    "description": "本次实际打开的版本、对象和操作范围",
    "captureMethod": "playwright-viewport-screenshot-loop",
    "evidence": "capture.json"
  },
  "callouts": [
    { "start": 0, "end": 4.5, "text": "先看操作结果" },
    { "start": 4.6, "end": 9, "text": "再核对关键变化" }
  ],
  "zooms": [
    { "start": 5.5, "end": 8, "scale": 1.5, "focus": { "x": 0.58, "y": 0.35 } }
  ],
  "captionStyle": { "fontSize": 64, "x": 50, "y": 74 },
  "sampleTimes": [2, 7]
}
```

示例时间需要按真实操作替换，不是固定业务步骤。字段：

- `schemaVersion` 固定为 1；`title`、`video`、`source.surface/description/captureMethod` 必填。来源是 Agent 记录的事实，脚本不能独立证明它；用当前任务的 manifest、采集记录或版本回执复核。可在 `source` 中增加 `historical`、设备和证据路径。
- `callouts` 与 `zooms` 可省略或为空；各自按时间排序、不重叠，`0 <= start < end <= 原片时长`。原片不剪切、不加速，因此时间与原片一致。
- 字幕用简短、事实性的中文说明动作或结果。不要把“通过”“已修复”写入尚未实际核对的片段。
- `scale` 使用 OpenScreen 六档缩放：`1.25 / 1.5 / 1.8 / 2.2 / 3.5 / 5`。脚本映射到 MCP 的 `depth`；`depth` 是档位，不是倍率。2.1.2 的 MCP 会给 `depth` 填默认值，直接传 `customScale` 可能被判为同时传入两种缩放参数；固定脚本用已验证的档位调用。
- `focus.x/y` 为原片中的 0–1 坐标；先看原片，再确定要展示的区域。不能只放大鼠标而裁掉反馈。
- `captionStyle` 仅支持字号和中心位置，默认 `64/50/74`，字号按 OpenScreen 的 1080p 设计尺寸定义；720p 导出会缩放。播放器覆盖区依设备而异，必须检查最终画面。
- `sampleTimes` 是最终 MP4 的抽帧时间，必须在结束前至少 0.05 秒。未提供时取每个字幕和放大区间中点；不限制关键帧数量，但不需要逐帧给 Agent 看整段视频。

制作依赖：Python 3.9+ 标准库、`ffmpeg`、`ffprobe`、OpenScreen 的 MCP。macOS 默认可执行文件为 `/Applications/Openscreen.app/Contents/MacOS/Openscreen`；其他安装位置用 `video.py --openscreen <绝对路径> doctor/build ...`。脚本不会安装软件或修改全局 MCP 配置。

## OpenScreen 调用依据

固定脚本在本机 2.1.2 上验证，启动时读取实际 `initialize/tools/list`。工具 schema 与版本保存在产物中；工具缺失、编辑拒绝或超时均停止，不自动重试写操作，不直接改 OpenScreen 工程文件。

官方入口：[CLI](https://getopenscreen.com/docs/cli/)、[Agent 接口](https://getopenscreen.com/docs/ai-editing/)。版本升级后先对真实原片运行 `doctor/build`，检查工程、渲染与关键帧，再调整调用合同。此技能未复制或捆绑 OpenScreen 本体。
