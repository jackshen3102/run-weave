---
name: acceptance
description: 为当前改动生成适合手机查看的验收材料，默认图文，需要连续过程时制作视频，统一真实采集、来源说明、预览和检查。用户要求验收材料、手机看效果、截图说明、验收视频或录屏证据时使用；普通开发和测试不默认制作材料。
---

# 验收材料

用户只需提出“给我本次改动的手机验收材料”。Agent 从判断问题出发选择形式，固定脚本负责图册、录制和视频制作。成功生成材料、完成业务验收、用户确认提交是独立事实。

脚本相对本 `SKILL.md` 定位。`SKILL` 为本目录绝对路径，`RUN` 为本次独立产物目录；Runweave 通常使用 `artifacts/verification-runs/<唯一任务目录>/`。只读取本次材料及用户明确引用的历史，不自动检索其他任务。

## 选择形式与证据

- **默认图文**：布局、设置、静态结果、少量前后变化。CLI/后台结果可直接作为文字页，不硬配截图。
- **按需视频**：连续交互、状态流转、等待或恢复过程是判断重点。先复用真实原片；需要补录时采集本次实际操作。
- **组合**：视频说明过程，图文补充小字号细节、结果或来源。只补有帮助的内容，不为凑套装生成两份。
- **原始录屏**：用户只要求取证或保存验证过程时，交付原片与采集元数据；不要求 OpenScreen、不增加字幕剪辑。普通“跑测试/浏览器检查”不自动升级为录屏。

先说明本次要展示的变化、运行端与关键操作，沿用已授权范围继续；不重复请求批准故事板。复用已有素材前核对对象、版本、来源和时间，历史示例必须标明历史。离散截图不是连续录像，模拟器、浏览器模拟、已安装 App 与真机结论分开。

需要补素材时：Web/Electron 使用 `toolkit:playwright-cli` 选择正确 Profile、Dev Session 或隔离页面；iOS 使用 `toolkit:agent-device`。操作 Runweave Dev Session 生命周期时使用其专属技能。不为整理材料启动无关环境，不覆盖用户页面，不在截图或原片中录入凭据和无关通知。

## 按形式生成

只读取当前形式的引用，所有浏览器连续帧采集统一使用 `capture.py`：

- **图文**：读[取景与配文](references/gallery-copy.md)和[图文输入合同](references/gallery-contract.md)，准备 `gallery.json` 与显式列出的真实素材。
- **视频**：读[视频输入与制作](references/video.md)，准备 `video.json`，Agent 只填原片、字幕和放大区间，不重写渲染程序。
- **需浏览器补录或仅原始录屏**：读[唯一采集流程](references/capture.md)。原生窗口可使用已连接 OpenScreen 的窗口录制工具，先核对权限和目标；不以整个桌面或替代页面冒充目标录屏。

```bash
# 图文：无需 OpenScreen 或 ffmpeg。
python3 "$SKILL/scripts/gallery.py" validate --input-root "$RUN" --input gallery.json
python3 "$SKILL/scripts/gallery.py" build --input-root "$RUN" --input gallery.json --output "$RUN/gallery"

# 视频：仅选择视频制作时检查这些依赖。
python3 "$SKILL/scripts/video.py" doctor
python3 "$SKILL/scripts/video.py" validate --input "$RUN/video.json"
python3 "$SKILL/scripts/video.py" build --input "$RUN/video.json" --output "$RUN/video"
```

生成器拒绝覆盖成果。图文携带固定阅读器、原图/原文和来源；视频保留原片引用与哈希、独立 OpenScreen 工程/checkpoint、主片、手机压缩版与关键帧。渲染错误、采集错误或结果未知时保留本次证据并如实说明，不以旧文件或空输出代替，不自动重放结果未知的写操作。

## 统一检查与手机入口

读[预览与检查](references/delivery.md)。先看实际产物，再提供入口：

- 图文检查逐页解码、翻页、目录、刷新定位、展开返回，以及原图/原文页内查看和实际尺寸；在桌面及手机窄屏核对阅读、遮挡和横向溢出。
- 视频检查完整解码、每段字幕、放大区域及取景；在手机竖屏与横屏观察真实画面，并通过实际播放器控制条完成播放、暂停、继续、进度跳转和重新打开。精确抽帧不等于触摸验证。
- 浏览器模拟明确记录引擎、尺寸和范围；iPhone 的 Safari/AVPlayer、全屏/旋转和阅读距离需要真机单独确认。未执行就保留缺口，不能由浏览器截图补成真机通过。

有 Runweave 连接时，图文和视频共用一个文件票据入口：

```bash
python3 "$SKILL/scripts/preview.py" \
  --file "$RUN/gallery/index.html" --project-id <当前实际项目ID> \
  --profile local --viewer-base-url <手机实际可访问的Backend地址> \
  --output "$RUN/gallery-links-01.json"
# 视频将 --file 换为 "$RUN/video/review.mp4"，并使用新的输出 JSON。
```

该步骤核对服务身份、匿名读取和文件字节，不创建公开服务，也不证明手机网络已可达。`127.0.0.1` 和 Mac 文件路径不能当作手机链接；局域网、外网转发和物理手机分别核对。没有适用入口时如实给出本地产物与缺失条件，不擅自改路由、认证或建立隧道。每个链接说明到期时间，续期生成新的链接文件。

## 交付、清理与迭代

最终说明本次改了什么、材料覆盖什么、实际检查结果和未验证部分。给可打开的入口、观看步骤、网络/主机前提，以及正常查看是否需要人在 Mac 操作。按需附 1–3 张能反映实际效果的截图；视频小字看不清时补图文或原图。

只停止本任务创建的采集、MCP、浏览器或本地预览服务，保留用户运行环境、原片及工程。材料不自动判定用户验收通过，不自动提交、上传、发消息或完成待办。随记任务使用 `toolkit:suiji`，只追加成功最终成果，完成状态独立授权。

后续可复现的问题在本目录修正默认值、脚本或对应引用，验证真实输出后同步安装 Toolkit。`acceptance-gallery`、`acceptance-video` 和 `recorded-browser-mcp-verification` 仅保留显式兼容转发，不维护第二套规则或实现；新请求统一使用本入口。
