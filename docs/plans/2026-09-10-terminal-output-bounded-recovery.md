# Terminal 弱网有界恢复实施进度

状态：代码实现完成；后端/Web 关键路径已验证，原生 iOS 真机热点验收待完成。不是全部 TOR 用例通过。
范围：Backend、共享协议、Web xterm、原生 iOS SwiftTerm；不修改输入确认、认证、持久化历史或 tmux 5,000 行上限。

## 已确认的设计调整

用户于 2026-09-11 同意继续采用“同一 attach 输出流的服务端屏幕镜像”。
原方案中的“独立临时 attach 快照 + 主 attach pending output”已废弃：真实 tmux 中两个 attach
各自重绘，没有共享字节边界；50 ms 静默不能证明快照与实时输出可以拼接。

当前行为与资源上限的权威说明见 [Terminal tmux 恢复](../architecture/terminal-tmux-recovery.md)，
验收合同见 [弱网恢复 YAML](../testing/terminal/runtime/output-recovery.testplan.yaml)。
本文件只记录实施进度，不把未执行的用例标成通过；交付完成后按文档治理清理。

## 已实现

- 同流 UUID、UTF-8 from/to offset、60 秒 / 512 KiB / 8,192 帧缓存，单帧不超过 64 KiB。
- tmux launcher 启用同流 headless 镜像；仅当前正常/备用屏幕，无额外 scrollback。
- 同流解析完成并到达 ANSI 完整边界后制作快照；序列化适配层补齐模式、滚动区域、保存光标等状态。
- 快照 singleflight、全局两个工作、2 秒 / 512 KiB；镜像队列与未闭合控制串也受限。
- 客户端 lease 每 runtime 八个 / 全局 64 个；idle runtime 60 秒 / 全局八个，定时清理。
- 半开连接按有效 lease/cursor 接管；旧 socket 清理不能误释放新连接或重建后的 runtime。
- WS 发送前检查完整 JSON 字节与 bufferedAmount，超限立即退订，1013 关闭并设置 1 秒终止兜底。
- Web 写入回调和 SwiftTerm 完整帧 feed 后才提交 cursor；短恢复不 reset，长恢复只接当前快照。
- 1013 停止自动重试；业务输入与信号不重放，viewport 保留既有重连时重发当前尺寸的语义。
- PTY 保留旧无游标行为；Web/iOS 兼容旧服务端无 recovery/cursor/range 的消息。

## 已取得的证据

- shared/backend/frontend 类型检查、Backend/Frontend lint、architecture check 通过。
- 原生 iOS Simulator Debug 构建及 2026-09-11 专项 UI 回归通过：5 秒续传、重复快照无旧屏残留、恢复后输入只执行一次。修复 SwiftTerm 备用屏幕重置；本机证据在 `.runweave/ios-output-recovery-fix-20260911/REPORT.md`。不代表全部原生用例或真机热点验收。
- 2026-09-11 当前源码 Profile 构建已原位安装至 iPhone 17（iOS 26.6.1），既有 XCUITest 执行器验证首页、连接管理及返回通过，登录和连接保留。个人签名未启用 APNs；这不是热点弱网验收。
- 同日 Stable Desktop 已通过统一更新器安装 runtime `local-1789130585814`，保留 0.208.0 外壳；App Server 跳过。通过更新器返回的 desktop CDP 验证安装态终端页面可见、输入可编辑且能聚焦，未发送命令。
- 同流镜像与 headless 对照：普通文本、中文/emoji、滚动区域、alternate screen、保存光标、
  单宽/双宽行尾 pending wrap、DEC 字符集与鼠标模式，快照及继续输出后均一致。
- 实际 node-pty runtime：第九个 idle 实例淘汰最早实例；lease 每 runtime 最多八个、全局 64 个；
  真实等待 61 秒后 idle runtime 与断线 lease 清空，测试子进程已 dispose。
- 最终 Unicode11 镜像小规模本机负载：约 246 KiB/s，4.111 秒累计约 183 ms CPU、RSS 增量约 8.2 MiB，
  快照完成耗时 P95 约 3.7 ms。包含镜像解析和高频快照，不代表端到端时延或长期 RSS 稳态。
- 第一轮隔离 Beta `dvs-99d893` / `pool-02` 的 Terminal 页面收到 resume，重连前后只有一个
  初始 snapshot；实际截图有持续更新的 marker。该 Session 已停止。
- 后续 Beta `dvs-012e59` 出现后端健康身份漂移；未绕过 resolver，按 cleanup-stale 指引清理。
- Beta `dvs-b83535` / `pool-02` 重新验证通过：真实 tmux 5 秒 idle 恢复、30 秒连续区间的 8,979 B
  逐字节对照及屏幕/光标一致、半开连接接管、非法 cursor、61 秒 cursor_expired 和超过缓存的
  cursor_evicted 快照降级。每个恢复分支均与当前屏幕对照。
- 真实慢读连接测试：快客户端收到 32,229,644 B 及结束 marker，慢客户端被强制终止（1006），
  tmux 任务仍运行；关闭握手超时的强制终止与正常 1013 路径不能混为一谈。
- 最终镜像的半截 CSI 等待完成、未闭合 OSC 2 秒超时、全局两个快照工作上限和 512 KiB
  镜像积压上限检查通过；Web 提交顺序、游标作废、旧协议兼容的消费者检查通过。
- Beta Web 页面：单独延迟终端重连 ticket 5 秒时恢复为 resume，snapshot 总数仍为一；
  伪造超前 offset 时恢复为 cursor_invalid / snapshot，仅增加一个快照。
  截图位于 `artifacts/terminal-output-recovery/desktop-final.png`。
- Web 全部 HTTP 离线 5 秒时，“浏览器协助”错误条会改变终端尺寸，因此安全降级快照而不是续传。
  这一分支不是短断线无清屏通过；本轮不扩大到浏览器协助的布局修复。
- 最后补齐旧独立 TerminalPage 的 write callback，并让同 API/session 的恢复身份跨 effect 重启保留；
  这两项追加修改通过类型检查与 lint，未重新打包 Beta 做页面验证。

## 验收纠正与剩余门禁

原始 VT 流中相同 marker 出现多次不等于重复补发：tmux 会重绘已有文本。
协议验收必须对比连续 cursor 区间的完整字节和最终屏幕/光标，不能把 VT 流当作 append-only 行日志。
两次早期“原始 marker 唯一”断言不成立，不能作为通过证据；YAML 已同步修正。

保留的验收边界：

1. 原生 iOS 真机热点、切后台、积压时断线和 TUI 显示仍需安装后做设备级验收；不以构建或 Web 截图替代。
2. 旧 Backend 的完整页面兼容和长时间高并发 RSS 稳态尚未做端到端验收。
3. 测试 fixture 的两个早期失败已分别清理；后续真实协议/慢读 fixture 均在 finally 删除。
   UI fixture `4956c80c` 已核验身份并删除，Playwright 已 detach，三个 Dev Session 均已停止，
   该轮最后一次 `dvs-b83535` 为 stopped / recovered；隔离测试阶段未修改 Stable 客户端或其它 Session。
