# 预览与检查

图文、视频和原片共用此处的访问与证据边界。优先使用任务已有的附件或经过验证的预览通道；材料默认留在本地，不自动上传或发布。

## 图文检查

逐页核对图片实际解码、配文、来源、取景及原图字节。检查翻页、目录、刷新定位、展开/返回分页，桌面与约 390–402px 手机窄屏的阅读和横向溢出。

阅读器的原图、原文和来源素材在页内对话框打开，支持图片“实际尺寸/适应屏幕”、滚动、关闭、Escape 和回到原焦点。要通过实际交付入口检查这些操作；本地正常不等于 Backend 预览沙箱里正常。原图保持原始字节，取景只影响正文显示，不修改原片或原图。文字页可直接复制内容，不必截成终端长图。

## 视频与原片检查

固定制作脚本会完整解码并抽取关键帧，Agent 仍需查看每段字幕、放大区间及转场：不能遮住关键反馈、裁掉目标、文字出画或放大到模糊。原始录屏则核对目标页面、动作记录、采样时序和结尾状态，不要求字幕或编辑效果。

独立视频链接按 `toolkit:playwright-cli` 使用隔离会话，清除继承的 CDP/remote endpoint，不覆盖用户业务页面；已有运行界面采集继续使用其正确 Profile/Session。记录引擎、viewport、DPR 和触摸参数，Chrome 的 iPhone 设备参数不能称作 Safari。

在竖屏约 390–402px 宽及对应横屏中：

1. 打开实际交付链接，确认加载视频而非登录页或错误文本。
2. 使用当前截图中观察到的播放器控制条，实际播放、暂停、继续、跳转，确认 seek 已完成且帧已显示，再重新打开。
3. 看字幕与局部细节是否足以支持本次判断，播放器控制条出现时是否遮挡；小字仍不可读时缩小取景、补局部图文或保留缺口。
4. 按任务范围检查全屏、旋转。精确取样可以设置 `video.currentTime`，但这不能证明触摸进度条已通过。Chrome 自动播放不能外推到 iPhone。

## Runweave 预览

`preview.py` 专用于已配置 Runweave Backend 的 HTML 或 MP4 文件。它不创建公开文件服务，不转移文件到另一台服务器：传入文件必须存在于对应 Backend 机器，项目身份与路径须符合服务端检查。当前 HTML 接口限入口 1 MiB、同目录单个资源 5 MiB；视频使用独立 Range 入口，不把 MP4 塞进 HTML 静态资源通道。

```bash
python3 "$SKILL/scripts/preview.py" \
  --file "$RUN/gallery/index.html" --project-id <实际项目ID> \
  --profile local --viewer-base-url <手机实际可访问的Backend地址> \
  --output "$RUN/gallery-links-01.json"

python3 "$SKILL/scripts/preview.py" \
  --file "$RUN/video/review.mp4" --project-id <实际项目ID> \
  --profile local --viewer-base-url <手机实际可访问的Backend地址> \
  --output "$RUN/video-links-01.json"
```

默认读取 `~/.runweave/settings.yaml` 中 `cli.profiles.<profile>` 的 `baseUrl/accessToken`，要求 0600 权限，需 PyYAML。没有该连接时不遍历凭据或读取应用密码。已有 API token 环境变量可用 `--token-env RUNWEAVE_PREVIEW_TOKEN --backend <已配置地址>`，参数只传变量名称，不传 token 值。

脚本只向配置中的 Backend 发送 Bearer，先核对 viewer `/health` 的服务身份，再匿名核对 HEAD、类型、长度。视频检查 Range 206 与本地字节一致；HTML 检查 GET 与本地字节一致，其脚本、样式和图片还须实际打开核对。拒绝重定向，避免转发凭据或预览权限；新票据保存到新的 0600 JSON。读取 `url/expiresAt` 用于交付，不将链接 JSON、连接文件或素材提交 Git。

票据不是永久链接；文件变化可能使旧票据失效。材料定稿后再生成，过期后换新输出文件续期。旧 `video.py preview --video ...` 仍转发到这套实现，不维护独立逻辑。

Mac 文件路径与 `127.0.0.1` 只能用于本机；局域网入口依赖手机可达、Mac 唤醒与 Backend 运行。Agent 从同一机器访问自己的 LAN 地址不等于跨设备验证。远程转发可能只放行健康检查而不放行 `/html-preview/`、`/video-preview/`，以实际匿名读取为准；缺路由就说明，不擅自改网关、认证或新建隧道。

## 真机与最终记录

需要真机时沿用 `toolkit:agent-device` 的已保存目标和独立会话；核对手机实际网络打开、阅读、播放/拖动、旋转/全屏和重新打开。保存分享只在用户要求时验证。真机不可控时保留模拟结论与明确缺口，不换设备冒充目标手机。

在任务产物目录另存 `review-check.json`，仅记录实际执行的检查：产物形式、运行环境与来源、每项动作和观察、证据路径、阅读判断、链接期限和访问前提，以及真机状态。未执行项用 `not-run`，不让生成器填充“验收通过”。

`macActionsWhileViewing` 只在观察完整查看流程后填写次数，否则为 `null`。0 仅表示该流程没有要求人在 Mac 点击；Mac 保持在线、后台运行、网络恢复和链接续期仍是访问条件。
