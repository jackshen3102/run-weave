# 浏览器采集

用户只要录屏证据时，交付本流程的 `recording.mp4` 与 `capture.json`、帧和动作记录，不依赖 OpenScreen，也不追加字幕剪辑。需要连续操作视频时复用同一流程采集原片，再交给视频制作。

先按 `toolkit:playwright-cli` 选择正确的实际页面并完成准备工作。已有页面不可用隔离浏览器冒充；独立预览页才使用隔离浏览器。采集只包住最终需要展示的操作，不重新执行整段开发过程。

把操作写为 `actions.js`：一个 `async (page, clock) => { ... }` 表达式，无 `import`、`require`、`export`。`clock.now()` 返回相对录制起点的秒数，可记录实际动作和观察。使用本次页面里观察到的 locator；下面只是动作记录格式：

```javascript
async (page, clock) => {
  const steps = [];
  // 在此使用当前页面观察到的 locator 执行本任务的操作，并验证结果。
  // 每步可记录 {atSeconds: clock.now(), action: '实际动作', observed: '实际观察'}。
  return steps;
};
```

这不是可直接执行的验收案例，必须填入当前任务的真实动作后再采集。避免录入密码、通知或连接凭据。

```bash
python3 "$SKILL/scripts/capture.py" prepare \
  --actions "$RUN/actions.js" --output "$RUN/capture" --fps 4

# 复用已按 Playwright Skill 选择的自有/已附着会话。
# 采集元数据可能包含目标 URL；限制本次输出文件权限。
umask 077
pnpm exec playwright cli -s="$SESSION" --raw run-code \
  --filename="$RUN/capture/run-code.js" > "$RUN/capture/capture.json"

python3 "$SKILL/scripts/capture.py" encode \
  --input "$RUN/capture/capture.json" --output "$RUN/recording.mp4"
```

`prepare` 只生成包装器，不启动浏览器或执行动作；可加 `--clip x,y,width,height` 使用已观察的 viewport 区域。`--fps` 为采样上限，默认 4，不是恒定实际采集频率。包装器并发采集 PNG，记录每张截图的真实相对请求时间；`encode` 使用实际间隔和总时长编码，而不是简单按帧数除以 4 计算。帧采样、截图耗时及 30 FPS 编码的舍入不适合精确性能或流畅度结论。

操作/截图失败时包装器抛错；CLI 错误不是合法采集数据，`encode` 必须拒绝。保留截图用于诊断，不能把未返回成功采集记录的帧当成完整录屏。脚本拒绝覆盖现有目录、原片和时间轴文件。若操作需要高帧率、系统弹窗或原生窗口，改用适当的实际录屏来源，并记录来源差异。

包装器自动记录开始/结束 URL、标题与 viewport，绑定到执行动作的同一个 page。Profile、target 或 Dev Session 身份通过当前任务的解析/附着回执保留，不能由截图猜测。动作需要的项目或终端应属于本次真实工作区；不为凑录屏新建空项目或复制代码冒充当前任务。
