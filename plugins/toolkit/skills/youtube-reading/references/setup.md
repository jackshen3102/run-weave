# 安装、诊断与恢复

## 前置与安装

支持 Apple Silicon macOS、Python 3.10+、FFmpeg/FFprobe 7+、CMake 3.21+、Node 22+、Apple Command Line Tools（clang）与 curl。doctor 只读检查，不安装系统工具。缺少系统工具时明确报告，由用户按其环境管理方式安装；不要自动升级系统软件或使用 sudo。

在本技能目录执行：

```bash
python3 scripts/youtube_reading.py doctor
python3 scripts/youtube_reading.py setup
python3 scripts/youtube_reading.py doctor
```

默认运行时为 ~/Library/Application Support/youtube-reading/。三个命令均支持 --runtime-root。setup 在 releases/<lock-id>-<nonce>/ 创建独立 venv、编译 whisper.cpp Metal、复制模型；全部校验通过才原子更新 active.json。旧版本保留，重复 setup 复用有效版本。下载缓存也校验 SHA-256，损坏则重新下载；Python 安装使用固定 wheel、--no-index 和 --require-hashes，不污染系统 Python。

版本和摘要唯一入口：[runtime-lock.json](../assets/runtime-lock.json)、[requirements.lock](../requirements.lock)。固定 whisper.cpp 提交与原型源码逐文件匹配；模型为 large-v3-turbo q5_0 与 Silero VAD 6.2.0。模型 URL 即使上游改变，摘要不符也会拒绝安装。

材料默认放在 ~/Documents/YouTube阅读稿/<video-id>/。目录可含中文和空格。网络沿用进程级 IPv4、15 秒连接超时、失败最多追加两次重试。遇到访问限制不取 Cookie 或尝试绕过。日志留在 .work/，不向聊天打印整篇原文或敏感配置。

## 恢复与缓存

```bash
python3 scripts/youtube_reading.py resume --job-dir '/absolute/path/to/video-id'
```

任务锁为系统 flock，进程退出或被终止后由内核释放；保留锁文件 inode 避免竞争删除。活跃写入返回 JOB_BUSY，不更改对方 manifest。

缓存校验原材料、引擎/模型、处理版本及源文件摘要。prompt_version 或 contract_version 变化只重新进入 awaiting_ai，原音频和 source 保留，旧 reading.md 保留至新稿通过。缓存响应给出原 acquired_at，不表示线上字幕刚被重新检查。要主动刷新线上内容，使用新的 --output-root 建立独立任务。

带 INCOMPLETE_GAP_CHECK 的任务在 resume 时会重新尝试获取缺口核查所需音频；补齐成功后清除旧提示并重新进入 awaiting_ai，已有阅读稿保留至新校对通过。

识别核心窗口最多 10 分钟，前后最多 2 秒上下文，先按段时间中点归属核心窗口，保留跨界但未归属的候选；全部窗口汇合后，补回中点未被任何已选段覆盖的候选，避免两个窗口因时间漂移同时丢句，恢复为全局时间。跨窗口的时间重叠且文字前缀一致时只裁掉可定位的重复，记录 boundary_overlap 和原文；不删除不同时间的口语重复。识别后对超过 3 秒的未覆盖区间使用 VAD 单次重新检测语言，补齐混说中可能漏掉的另一种语言；保留 coverage_recovery 来源。块完成立即写摘要，收据同时保留未归属的边界候选；resume 复用通过校验的块并重新汇合候选。边界算法版本变化会使旧识别缓存失效，材料版本变化会要求重新校对，但保留原有阅读稿直到新稿通过。默认超时 max(120 秒, 音频块时长 × 0.5)；慢机器用 prepare --asr-timeout-seconds N 覆盖并记录。

retranscribe 异常核心最多 50 秒，加前后 5 秒，整段最多 60 秒且不加 VAD；同区间复用记录，不无限重复。候选不覆盖 source 或最终正文。字幕缺口补齐使用 VAD，仅截取缺口本身的音频，不带前后已覆盖音频；保留识别原始时间，不通过裁时间戳掩盖重复文字。仍需 Agent 核对边界与幻觉。

常见错误：RUNTIME_INVALID（先 doctor/setup）、NETWORK_TIMEOUT / ACQUISITION_DENIED（检查公开访问和网络）、AUDIO_ACQUISITION_FAILED、ASR_TIMEOUT、REVIEW_COVERAGE、REVIEW_VERSION、DUPLICATE_EVIDENCE。失败保留工作文件；最终稿不会被不合格输入覆盖。

## 隔离验收边界

以下为内部 Python 调用，不是用户模拟开关。将 scripts 目录加入 sys.path 后导入，示例须替换绝对路径：

```python
from pathlib import Path
import sys
sys.path.insert(0, '/absolute/skill/scripts')
from runtime import transcribe_audio, convert_audio, fill_gaps
from artifacts import chunk_source, write_json

work = Path('/absolute/isolated-case/.work')
work.mkdir(parents=True, exist_ok=True)
wav = convert_audio(Path('/absolute/local-audio.wav'), work)
segments = transcribe_audio(wav, work / 'asr', {
    'runtime_root': '/absolute/runtime', 'language': 'auto'
})
for i, segment in enumerate(segments):
    segment['id'] = f's{i:06d}'
write_json(work / 'source.json', {'schema_version': 1, 'segments': segments})
chunk_source(work / 'source.json', work)
```

缺口 fixture 使用 fill_gaps(原字幕段数组, wav, work, options)，保留原副本。字幕段使用 start_ms、end_ms、text、language、source_kind。该边界与 CLI 共用 VAD/ASR 与缓存实现。

获取 fixture 向 youtube_reading.prepare(..., adapter=adapter) 注入对象，其 metadata(url)、transcripts(video_id, language)、audio(url) 对应 NetworkAdapter。同样运行真实前置检查、锁和失败持久化；仅替换网络边界。生产 NetworkAdapter 的 Session 管理每请求 15 秒与最多两次重试，adapter 自己维护相同合同，外层不叠加重试。不能用注入的成功结果声称线上视频通过。

音频抽听、真实字幕状态、独立新会话触发与完整 AI 校对必须另外取证；脚本成功或文本映射不能代替这些验收。

## 移除

确认没有本技能任务运行后，仅删除自己选择的 runtime-root（默认上述 Application Support 目录）。阅读稿仍保留在 Documents。清理 .work/ 音频会影响恢复与局部重识别，必须由用户另行明确要求，不随卸载删除。
