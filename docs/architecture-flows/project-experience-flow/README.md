# 项目经验完整流程

这是 **2026-09-17 工作区代码快照**，包含尚未提交、尚未部署正式客户端的经验功能修改。
页面用于阅读架构，不是产品 UI，不调用业务 API，不证明正式安装态已具备这些行为。
后续代码变化时应重新核对；当前维护合同以 [experience CLI](../../cli/experience-cli.md) 为准。

## 阅读与启动

从仓库根目录启动只监听本机的静态服务；先确认端口未被占用：

```bash
python3 -m http.server 6188 --bind 127.0.0.1 --directory .
```

打开 `http://127.0.0.1:6188/docs/architecture-flows/project-experience-flow/`。

- **完整主流程**：自动学习与按需使用并排展示，点击节点查看 owner、输入输出和失败分支。
- **状态与存储**：区分任务、候选与经验三个状态机，展示存储位置、项目身份与版本凭据。
- **设计检查点**：列出开关、安装、检索方式、恢复方式、容量限制及尚未实施的保留策略。

页面使用内联 CSS / JavaScript，无外部依赖。按钮只切换说明内容。

## 代码来源

- [完成事件](../../../backend/src/terminal/completion/event-service.ts)：Stop 后的学习入队。
- [学习开关](../../../backend/src/experience/bootstrap.ts)：Stable 默认开启，Beta/dev 默认关闭。
- [学习运行时](../../../backend/src/experience/learning-runtime.ts)：快照、排队、调度和关闭。
- [任务队列](../../../backend/src/experience/learning-queue.ts)：去重、五分钟租约和 retry。
- [本轮事实读取](../../../backend/src/experience/learning-source.ts)：快照分页、时间与面板过滤、容量限制。
- [提炼与复核](../../../backend/src/experience/learning-analysis.ts)：两次模型调用、失败材料、候选归档。
- [经验领域服务](../../../backend/src/experience/service.ts)：项目身份、检索、版本、入库与反馈。
- [证据](../../../backend/src/experience/evidence.ts)与[存储](../../../backend/src/experience/storage.ts)：归档和 SQLite 分区。
- [HTTP 路由](../../../backend/src/routes/experience.ts)与[CLI](../../../packages/runweave-cli/src/commands/experience.ts)：读写入口。
- [experience skill](../../../plugins/toolkit/skills/experience/SKILL.md)：按需检索、现场核对与结果回执。

## 关键边界

后台 hooks 学习与可选 skill 是两条独立入口。没有 skill 不代表后台学习关闭；仅安装 skill
也不代表 Backend、Activity、完成 hooks、认证和本机 Codex Provider 已准备好。

completed 不等于 promoted；promoted 不等于已证明有效。反馈依赖 Agent 实际执行，当前没有
自动填报采用关系或验证因果收益的机制。成功回执不自动续期，pending 候选不自动重试。

同一仓库 worktree 共用经验，独立仓库隔离；端口只用于连接。源码路径为可选线索，没有源码
哈希适用性门槛。队列仍按 namespace 共享并串行领取，项目内容和反馈没有因此混合。

页面中的已验证结果来自本次隔离运行记录；不将其写成生产收益统计。敏感字段脱敏遗漏暂未
处理，按日期滚动查询和自动清理也尚未实施。

## 浏览器验收

已使用仓库固定版本的 `pnpm exec playwright cli` 在独立 Chrome 中验收：1440 × 1100 视口无横向溢出，
节点详情、三个阅读视图与默认状态恢复均通过，console error 为 0。
默认阅读状态完整截图见 [prototype-preview.png](prototype-preview.png)。
当前 Runweave CDP 页面可以交互但截图超时，截图证据来自独立 Chrome，不冒充桌面原生验收。
