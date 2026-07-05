# RMUX-Inspired Ideas Prototype

一次性可运行原型（React + htm，浏览器 ESM，无构建）。用来把 **RMUX**（Rust 写的通用终端多路复用引擎，实现 90+ tmux 命令 + typed SDK + 浏览器分享）的几个核心能力，借鉴映射到 **Runweave** 真实的「多 backend × tmux-native 终端 × agent-team」场景，供点、改、截图、收敛。

不是产品合约，不证明后端/协议/运行时已支持。数据全为 mock。每个视图底部用 `note-box` 明确标注了**真实映射**与**落地缺口**。

## 一句话背景

RMUX 把「本地执行、解耦前端、加密传输、typed 自动化」四件事拆开：shell/PTY 留在本机 daemon，浏览器只收密文帧，SDK 用 typed 原子操作（`expect_visible_text`/`capture_pane`）驱动终端，`capabilities`/`diagnose` 做能力协商。Runweave 是「多 backend + tmux-native 终端 + agent-team」，正好缺这几层。本原型挑了 4 个最贴合 Runweave 现状、可借鉴的点。

## 4 个借鉴点

| #   | 视图                 | 借鉴自 RMUX                                            | 核心意图                                                                                      |
| --- | -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 1   | **Web Share 分享**   | `web-share`（Operator/Spectator + E2EE）               | 把正在跑 agent 的终端 pane 甩个只读/可控浏览器链接给同事看进度，执行仍在本机，替代截图录屏    |
| 2   | **行为验收脚本**     | SDK `wait_for_text` / `assert_visible_text` / snapshot | 把 agent-team behavior_verify 的终端信号做成可回放、带 pass/fail/耗时/失败快照的 typed 断言链 |
| 3   | **Backend 能力协商** | `capabilities --json` / `diagnose`                     | 多 backend 连接前先探能力（tmux/runtime/快照/CDP/协议版本），缺失就显式降级 + 告警            |
| 4   | **程序化命令面板**   | 90+ typed tmux 命令 + pane 句柄寻址                    | Cmd-K 式面板：搜命令、看参数签名、选 target pane、预览完整命令再路由                          |

## 启动

```bash
python3 docs/prototypes/rmux-inspired-ideas/serve.py 6191
```

打开：

```text
http://127.0.0.1:6191/
```

> `serve.py` 给所有响应加 `Cache-Control: no-store`，普通刷新即拿最新。也可用 `python3 -m http.server --directory docs/prototypes/rmux-inspired-ideas`，但可能命中缓存需强刷。

## 文件

- `index.html`：布局、暗色 terminal 风格样式（复用真实 Runweave 配色变量）、左侧 nav、挂载点。
- `app.js`：React 原型逻辑。左侧 4 个借鉴点切换，4 个视图组件 + 交互（选 pane、切只读、重放断言链、看 diagnose json、命令搜索/预览、toast）。
- `mock-state.json`：模拟 backend / 终端 / 分享会话 / 断言链 / 能力矩阵 / 命令注册表。
- `serve.py`：no-cache 静态服务脚本（原型辅助，不进入产品）。
- `prototype-preview.png`：浏览器验证截图（验证后保存）。

## 功能分类账

**产品核心功能候选**（若推进落地）：终端 pane 浏览器分享（Operator/Spectator + TTL/PIN）、behavior_verify 的 typed 断言链 + 快照证据、backend capabilities 协商 + 能力矩阵降级、typed 终端命令注册表 + Cmd-K 命令面板。

**原型辅助功能**（不进产品范围）：左侧 4 点导航切换、mock JSON、toast 提示、各视图底部 note-box、`serve.py`。

## 交互验证点

- 切换左侧 1~4，每个视图头部显示「借鉴自哪个 RMUX 能力 + 为什么 Runweave 需要」。
- Share：左列选终端 pane；切「仅只读」会灰掉 Operator 链接；观看端里 640ms 的 spectator 标 `4001 backpressure`；下方列出浏览器关闭码安全语义。
- Verify：5 步断言链，最后一步 `expect_visible_text` fail（HMR 走整页 reload）；点步骤右侧看快照证据；列出 typed 断言原语。
- Diagnose：三 backend 能力矩阵（本机 v3 全绿 / dev-box v2 部分降级 / ci-runner 离线）；展开 `diagnose --json`；告警卡「按此降级」。
- Commands：搜索 + 分类过滤命令；选中命令右侧预览 `$ rmux …` 完整命令 + target。

## 非目标

- 不接真实 backend / WebSocket / RMUX daemon / tmux；不写产品代码；不新增单测。
- 不覆盖全部边界；只呈现要给人看的关键决策态。

## 落地缺口（汇总，供后续写实施计划）

1. **终端 pane 浏览器分享**：复用现有终端 WS 通道多播输出帧，加链接鉴权/TTL/PIN、Operator/Spectator 两级写权限（扩 `TerminalInputMode` 只读态）；公网分享才需 E2EE + tunnel。
2. **typed 断言链**：backend 需暴露 `expect_visible_text` 式阻塞等待（现在是裸 PTY 流）、`capture_pane` 快照落库回放、`assert_dom` 与 `$playwright-cli` 桥接。
3. **capabilities 协商**：backend 侧吐能力描述（tmux/node/协议版本），前端建终端按能力矩阵灰掉不支持入口，协议差异做字段降级。
4. **typed 命令注册表**：把散在各处的终端动作收敛成一份 typed 命令表，绑定 pane 句柄 + 执行前预览，复用 `terminal-quick-input-popover.tsx` 呼出。
