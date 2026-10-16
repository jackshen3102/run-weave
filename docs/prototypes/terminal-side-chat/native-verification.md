# 原生旁聊验证记录

历史取证，2026-10-15。仅证明下述环境和路径；不是当前工作树的全量产品验收。机器可核对的时间戳、终端状态、panel 状态和 tmux 屏幕见 [采样 JSON](./native-verification.json)。各接口依次读取，非原子快照；短暂不一致不能直接视为缺陷。

## 环境与隔离

- Codex CLI `0.160.1`，继承现有 `GPT-6-Astra high` / Full access 配置。仅请求文本回答，未要求工具、文件修改或子 Agent。
- 安装的 Runweave Stable Backend，运行时报告 source revision `74dd27b40337c38427603ed7ea949871d033a560`、sourceDirty=true；不是工作树 `81e6c04f` 的构建。
- 自有临时项目 `2ec12ce0-3863-457a-8034-815b258194b2`，目录 `/private/tmp/runweave-side-native-20261015`。
- terminal `21dd17ed`，panel `8b0b661e-cc69-44b3-b826-e54aaa2e8402`，tmux pane `%197`。整个采样期间均为同一 pane，pane PID `53633`（pane 进程 PID，不冒充 Codex 子进程 PID）。
- 主 thread P：`01a13efa-814b-7ff0-8e40-26a109ac47ef`；第一次旁聊 S1：`01a13efb-f88c-76d2-8a6d-94f082499283`；运行中创建的旁聊 S2：`01a13eff-9453-7222-a131-fdc209d36a93`。

输入经 `rw --instance stable terminal send 21dd17ed --stdin --mode raw`，观测经 terminal snapshot / panel list / state 与该自有 tmux pane 的 capture-pane。没有向用户已有终端注入命令。JSON 不包含账户状态页、凭据或全局配置。

## 结果

| 项目                             | 结果                 | 直接证据（JSON label）                                                                                                                                                                                              |
| -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生创建与上下文继承             | 通过                 | `baseline` 先告知父标记；`side-answer` 在旁聊仅问父标记，返回 `NATIVE_SIDE_PARENT_1015`，且不重复展示父历史                                                                                                         |
| 专用切换与内容保留               | 通过，限下述输入编码 | `toggle-csi-u` 显示父历史和 `ctrl+/ for side`；`returned-side` 恢复同一旁聊回答                                                                                                                                     |
| 空输入关闭                       | 通过，限下述输入编码 | `closed-csi-u` 回到主历史，旁聊入口提示消失                                                                                                                                                                         |
| 主任务运行中创建旁聊             | 通过                 | `parent-running` 09:58:13Z 主任务 Working；09:58:20Z `concurrent-side-start` 进入旁聊；父随后完成 180 行输出，`concurrent-parent-progress` 显示 Worked for 13s；`concurrent-side-result` 显示子回复与 main finished |
| 关闭后重新创建                   | 通过，限界面生命周期 | `recreated-empty-ready` 新旁聊为空，无旧回复；`recreated-side-closed` 再次回到主会话。不据此宣称磁盘清理已验收                                                                                                      |
| 终端资源复用                     | 通过，限已观察资源   | 各次均为同一 terminal、panel、单个 pane；没有新建第二个 Runweave 终端                                                                                                                                               |
| Runweave 主会话身份              | **失败**             | S1 回答后 lastThreadId=S1；切回父画面、关闭后仍为 S1。第二次关闭后仍为 S2。不是仅创建瞬间的短暂不一致                                                                                                               |
| 桌面物理快捷键链路               | **未完成**           | 直接 raw 注入传统 `0x1f`、`0x03` 未切换/关闭；CSI-u `ESC[47;5u`、`ESC[99;5u` 成功。尚未定位差异属于输入分发、tmux、键盘协议协商或其他环节                                                                           |
| 监督、通知、恢复、浮动草稿与附件 | 未执行               | 身份污染已被观测，但不能据此声称这些下游路径均已发生误操作                                                                                                                                                          |

`toggled-parent`、`parent-after-redraw`、`closed-side` 是传统字节尝试的采样标签，**不表示对应动作成功**；以其中 screen 为准。空旁聊新建没有暴露可核对的新 thread ID，保留未知，不用旧 lastThreadId 代替。

## 对原型及接入方案的影响

保留原生 `/side`、专用切换、空输入关闭及同终端运行；无依据增加独立子终端、旁聊列表或自建聊天 API。原型改为短对话中输入区紧随正文，使用实测 `Ask a follow-up question` / `Ask Codex to do anything` 提示。HTML 键盘事件仅模拟操作含义，不能代表真实 xterm 编码已经兼容。

管理兼容性门槛未通过：当前安装版会把旁聊身份写入 terminal/panel 的 current/last 字段。后续实现必须先取得可靠的父子/显示身份来源，再验证主线程恢复、监督和完成隔离；不能以“最近 thread”猜测。此次只修正原型和证据，不修改产品代码。

## 验证边界与环境阻塞

源码 Dev Session 启动前因磁盘安全门槛被拒绝：available `2726559744` bytes，required `4294967296` bytes；未返回 devSessionId，未绕过门槛。安装版实测不能替代当前源码验收。

尝试访问自建浏览器页的 localhost:3000 失败后已关闭该自有页。随后附着已发现的安装版 Desktop CDP；从原 devbox 连接切到本地准备打开测试终端时，页面在下一操作前自行切回 devbox，无法确定操作者。已停止并 detach，未重试争抢控制，未向其他终端发送输入。因此没有完成桌面键盘端到端验收，也没有把终端文本采样称作桌面截图验收。

自有终端与项目在取证后删除；用户已有终端、项目和浏览器标签保留。完整产品验收仍需可启动的隔离源码环境与可独占操作的测试页面。
