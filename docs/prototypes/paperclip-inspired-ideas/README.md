# Paperclip-Inspired Ideas Prototype

一次性可运行原型（React + htm，浏览器 ESM，无构建）。用来把开源项目 **Paperclip**（“管理 AI agent 团队的公司控制面”）的几个核心能力，借鉴映射到 **Runweave** 真实的「多 backend × 多项目 × 多终端」场景，供点、改、截图、收敛。

不是产品合约，不证明后端/协议/运行时已支持。数据全为 mock。每个视图底部用 `note-box` 明确标注了**真实映射**与**落地缺口**。

## 一句话背景

Paperclip 解决的问题是「你开了 20 个 Claude Code tab，不知道谁在干什么、花了多少、卡在哪」——正好是 Runweave 多终端跑 agent 后缺的那层聚合/治理面。本原型挑了 5 个最贴合 Runweave 现状、可借鉴的点。

## 5 个借鉴点

| #   | 视图                   | 借鉴自 Paperclip       | 核心意图                                                                               |
| --- | ---------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| 1   | **Fleet Overview**     | Dashboard / Org Chart  | 跨 backend 聚合所有终端成状态墙，按「需要关注」（阻塞/等待输入）排序，点卡片深链回终端 |
| 2   | **Cost & Budget**      | Budget & Cost Control  | 在 CPU/内存之外加 token 成本视角，按项目/agent 统计，设月度硬停避免 runaway loop 烧钱  |
| 3   | **Scheduled Routines** | Routines & Heartbeats  | 给项目挂 cron/webhook 例行任务，到点自动开终端跑 agent，不用人肉 kick-off              |
| 4   | **Approval Gate**      | Governance & Approvals | 把 AGENTS.md 的硬约束（禁 --force 等）从口头规则升级成执行前拦截 + 人工放行            |
| 5   | **Activity Timeline**  | Activity & Events      | 把散在各终端的工具调用/成本/完成/审批/阻塞事件汇成一条可过滤时间线                     |

## 启动

```bash
python3 docs/prototypes/paperclip-inspired-ideas/serve.py 6190
```

打开：

```text
http://127.0.0.1:6190/
```

> `serve.py` 给所有响应加 `Cache-Control: no-store`，普通刷新即拿最新。也可用 `python3 -m http.server --directory docs/prototypes/paperclip-inspired-ideas`，但可能命中缓存需强刷。

## 文件

- `index.html`：布局、暗色 terminal 风格样式（复用真实 Runweave 配色变量）、左侧 nav、挂载点。
- `app.js`：React 原型逻辑。左侧 5 个借鉴点切换，5 个视图组件 + 交互（过滤、toggle、批准/驳回、toast）。
- `mock-state.json`：模拟 backend / 项目 / 终端 fleet / 预算 / 例行任务 / 审批 / 活动流。
- `serve.py`：no-cache 静态服务脚本（原型辅助，不进入产品）。
- `prototype-preview.png`：浏览器验证截图（验证后保存）。

## 功能分类账

**产品核心功能候选**（若推进落地）：跨 backend 终端聚合视图、token 成本采样与预算硬停、例行任务调度、高危命令审批门、统一活动/审计时间线。

**原型辅助功能**（不进产品范围）：左侧 5 点导航切换、mock JSON、toast 提示、各视图底部的 note-box 说明、`serve.py`。

## 交互验证点

- 切换左侧 1~5，每个视图头部显示「借鉴自哪个 Paperclip 能力 + 为什么 Runweave 需要」。
- Fleet：顶部关注计数；过滤条切状态；阻塞/等待输入的卡片排在前面；点卡片弹深链 toast。
- Budget：三个项目卡按 ok/warn/stopped 三态；`runweave` 超限显示「已硬停」+ 恢复按钮；按 agent 拆分条。
- Routines：toggle 启用/停用；触发方式 cron/webhook。
- Approvals：批准/驳回后进历史；待批准计数变化。
- Activity：按事件类型过滤。

## 非目标

- 不接真实 backend / WebSocket / token 计费；不写产品代码；不新增单测。
- 不覆盖全部边界；只呈现要给人看的关键决策态。

## 落地缺口（汇总，供后续写实施计划）

1. **跨 backend 聚合层**：现在各 backend/终端状态是分开的，Fleet/Activity 需要一个汇总通道（轮询或聚合 WS）。
2. **token 成本采样**：需在 `TerminalCompletionEvent` / hook bridge 回传 token 用量，加预算存储 + 超限暂停信号。
3. **调度器**：Routines 需要 backend 常驻 cron/webhook 调度 + 「无人值守自动开终端」API。
4. **高危命令拦截**：Approval Gate 需在终端/hook 层识别高危命令并挂起，加一条把决定回灌 agent 上下文的通道。
5. **事件总线**：Activity 需把多终端事件归一化落库以供审计。
