# 飞书集中 Bridge V1 架构演示

2026-10-10 实现前的方案快照，基线 `9472440d`；图中“尚未接通”指此演示本身。集中能力现已有源码实现与受控集成验证，真实三机部署待验收。范围已收敛为通知与已有话题回复；没有群内新任务、选机器卡片或用户手动建话题。

直接打开 [index.html](./index.html)，无需构建或外部依赖。也可运行：

```bash
python3 -m http.server 6199 --bind 127.0.0.1 --directory docs/architecture-flows/feishu-central-bridge-v1
```

浏览器访问 `http://127.0.0.1:6199/`。切换两个场景、三个演示话题、五个步骤及断连状态。机器按钮只切换演示话题，不是拟新增的飞书产品交互。

## 方案与事实

- 中心保存一个飞书应用的凭据、话题绑定和现有投递记录。
- 三个 Backend 内置连接模块，主动连接中心；不需要中心访问它们的 IP，也无需每台机器部署飞书 Bridge。
- 机器人首次通知按现有规则自动建话题；用户只回复已绑定话题。路由依据为持久 Backend 身份和 Terminal ID，执行仍使用当前活动 Panel。
- 未发送输入沿用现有 120 秒等待规则，结果未知不自动重投；不新增通知离线队列。

详细合同、代码入口、迁移边界及验证结果见 [实施计划](../../plans/2026-10-10-feishu-central-bridge.md)。当前实现事实以 [通知架构](../../architecture/terminal-completion-notifications.md) 和 [消息处理器](../../../packages/runweave-cli/src/feishu/bridge-message-handler.ts) 为准。

本图不连接真实飞书或 Backend，不能作为集中链路业务验收证据。

## 页面验收

本次范围调整后使用仓库 Playwright CLI 在 Profile 1 验收通过：两个场景 × 三个话题 × 五步骤共 30 个状态，两个断连说明、节点切换和重置；390、1280、1440 像素视口整页无横向溢出，console error 为 0。截图：[默认阅读状态](./prototype-preview.png)、[投递到 Linux](./routing-preview.png)。真实飞书与 Backend 业务链路未执行。
