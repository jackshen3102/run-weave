# app-server-event-architecture-flow（App Server 事件架构诊断原型）

Runweave App Server 事件写入、持久化、状态投影、WebSocket 恢复、backend ownership/cursor 与 TerminalState 关系的可运行 HTML 原型。

- **性质**：基于当前工作区源码与真实复现结果更新后的技术架构诊断图。
- **梳理日期**：`2026-07-11`。
- **范围**：App Server event center 及其和 backend 的关系；不展开 terminal input/output、Browser、Preview、Voice 或 Agent Team loop。
- **目标**：展示当前事件流、已验证修复和保持现状的证据；只处理可稳定复现且不是保留期边界的问题。
- **参考风格**：`docs/architecture-flows/agent-team-loop-flow/` 的深色技术流程图；布局改为分层泳道，避免圆形关系图和平铺模块清单。

## 启动

```bash
python3 -m http.server 6192 --directory docs/architecture-flows/app-server-event-architecture-flow
```

打开：

```text
http://127.0.0.1:6192/
```

## 原型怎么读

1. **主链与场景**：默认只看 `producer → POST /events → EventStore → projection/sync → /events/stream → backend consumer → TerminalState`。切换场景后，只有真实经过的节点会高亮。
2. **问题因果**：每个问题固定按“证据等级 → 触发条件 → 代码机制 → 结果 → 证据”展示，避免把推测写成事实。
3. **事件时序**：展示一个 Stop hook 的 App Server 链路，同时标出 Hook Bridge 仍存在的 backend 直达入口。
4. **接口与事件**：区分 App Server ingress/query/stream、backend direct route 和 Web/App 客户端的 terminal event bus。

## 当前主链

```text
Hook / backend / Electron / CLI
  └─ POST /events
      └─ AppServerEventCenter.record queue
          └─ AppServerEventStore.append queue → app-server-events.jsonl
          ├─ AppServerStateProjector → ThreadRef snapshot
          ├─ thread.state.changed derived event
          ├─ Cloud Sync Sim mirror / cursor / manifest
          └─ WS /events/stream
              └─ backend AppServerEventConsumer
                  ├─ ownership filter
                  ├─ persistent cursor
                  └─ processTerminalAgentHook → TerminalStateService
```

关键边界：

- App Server 是一个本机单例事件中心，不拥有 terminal runtime，也不维护哪个 backend 拥有哪个 Terminal Session。
- 每个 backend 用本地 `TerminalSessionManager` 判断 ownership，并维护自己的消费 cursor。
- App Server `/events/stream` 是 App Server 到 backend 的流；backend `/ws/terminal-events` 是 backend 到 Web/App 客户端的流，两者不是同一条 WebSocket。
- Hook Bridge 当前不是“App Server 成功后就不写 backend”，而是 App Server 与 backend direct route 两条语义入口都可能执行。
- WebSocket `limit` 是单批 catchup 大小，不再是整次恢复上限；服务端发送完全部积压后才进入 live。
- backend 对无 ownership 事件跳过业务 handler，但仍推进已交付 cursor。

## 问题证据分级

| 编号 | 结论                                           | 处理结果                   |
| ---- | ---------------------------------------------- | -------------------------- |
| P0   | 并发 event id 与 Cloud Sync mirror 重复        | 已稳定复现并修复           |
| P1   | 单批 catchup 留下超过 100 条窗口的历史事件     | 已稳定复现并修复           |
| P2   | 无 ownership 事件不推进 backend cursor         | 已稳定复现并修复           |
| P3   | catchup 与 live subscribe 之间可能存在时序空窗 | 400 条压力实验未复现，不改 |
| P4   | 7 天保留期外的投影与旧 cursor 无 gap 语义      | 明确保留边界，不改         |
| P5   | 事件交付等待多次文件同步                       | p95 未形成性能问题，不改   |
| P6   | Hook 到 TerminalState 存在两条入口             | 未产生重复状态事件，不改   |

P3 的原始判断被运行实验否定：catchup 与 subscribe 位于同一个无 `await` 的同步回调，100 轮握手并发写入共 400 条事件没有丢失。P4 属于明确的 7 天保留边界。P5/P6 都完成了针对性实验，没有达到修改门槛。

## 本轮真实复现

### P0：并发事件事务

使用当前 `app-server/dist/event-store.js`，在临时目录初始化一个 EventStore，然后同时执行 40 个 `append`：

```json
{
  "writes": 40,
  "uniqueIds": 1,
  "firstIds": ["1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1", "1"],
  "latestId": "1"
}
```

临时 JSONL 有 40 行，但 40 行的事件 id 都是 `1`。只给 EventStore 增加串行保护后又发现 Cloud Sync mirror 对 40 个唯一事件写出了 53 行，因此最终串行化了完整 `record → append → projection → sync → notify` 事务，同时保留 EventStore 自身的 append queue。

修复后：

```json
{
  "resultUnique": 40,
  "storeCount": 40,
  "mirrorLines": 40,
  "mirrorUnique": 40,
  "mirrorLast": "40"
}
```

### P1：catchup 默认窗口截断

启动真实 App Server，顺序写入 120 条事件，再连接真实 `/events/stream`：

```json
{
  "stored": 120,
  "defaultLimit": 100,
  "catchupCount": 100,
  "catchupLastId": "100",
  "latestId": "120",
  "undelivered": 20
}
```

修复后服务端以 `limit` 作为批大小循环读取。使用默认批大小回归时收到 `100/20` 两批，共 120 条、0 条缺失。

### P2：无 ownership cursor

修复前向 consumer 交付 `id=1` 且 `isRelevant=false` 的事件，结果为：

```json
{ "delivered": ["1"], "cursorWrites": [], "reconnectAfter": null }
```

修复后相同实验为：

```json
{ "delivered": ["1"], "cursorWrites": ["1"], "reconnectAfter": "1" }
```

## 原型简报

- **主要使用者**：梳理 App Server、事件中心与 backend 边界的开发者。
- **主要动作**：切换事件场景、点击模块职责、逐个查看问题因果、按协议筛接口。
- **重要状态**：event id、dedupeKey、after cursor、catchup limit、ownership、ThreadRef、retention、App Server instance。
- **影响真实产品 UI**：无。该目录只包含架构说明原型。
- **非目标**：不处理 7 天保留边界；不为未复现问题增加协议或去重机制；不把双入口事实直接等同于用户可见双写问题。

## 功能分类

| 元素 / 行为        | 用途                                    | 是否代表产品 UI  |
| ------------------ | --------------------------------------- | ---------------- |
| 主链与场景切换     | 对照正常、并发、积压、多 backend 等链路 | 否，架构说明导航 |
| P0–P6 问题因果页   | 展示复现门槛、处理结果与证据            | 否，架构诊断交互 |
| 事件时序页         | 展示 Hook、App Server 与 backend 时序   | 否，架构说明视图 |
| REST / WS 接口筛选 | 按协议查看当前接口边界                  | 否，文档筛选能力 |

原型没有额外的隐藏 mock 开关或产品功能入口；所有可见控件都只用于阅读这份技术架构说明，不进入 Runweave 产品实施范围。

## 文件

- `index.html`：页面结构和视觉样式。
- `app.js`：场景、节点、问题与接口交互。
- `mock-state.json`：当前架构、问题、接口与事件种类的结构化事实。
- `prototype-preview.png`：Playwright 验证生成的首屏截图。

## 代码源

### App Server

- `app-server/src/index.ts`
- `app-server/src/http-server.ts`
- `app-server/src/websocket-server.ts`
- `app-server/src/event-center.ts`
- `app-server/src/event-store.ts`
- `app-server/src/state-projector.ts`
- `app-server/src/state-store.ts`
- `app-server/src/cloud-sync-sim.ts`
- `app-server/src/codex-thread-status-compensator.ts`

### Backend

- `backend/src/index.ts`
- `backend/src/app-server/client.ts`
- `backend/src/app-server/event-consumer.ts`
- `backend/src/app-server/event-cursor-store.ts`
- `backend/src/app-server/handlers/agent-hook.ts`
- `backend/src/app-server/handlers/agent-completion.ts`
- `backend/src/terminal/agent-hook-processor.ts`
- `backend/src/terminal/terminal-state-service.ts`

### Producer / Shared contract

- `plugins/toolkit/hooks/runweave-hook-bridge.cjs`
- `plugins/toolkit/hooks/runweave-hook-payload.cjs`
- `packages/shared/src/app-server-events.ts`

## 验收点

- 默认首屏不使用圆形架构图，只展示五层泳道和一条高亮主链。
- 六个场景均可切换，场景侧栏随之更新步骤与数字。
- 任意节点可点击，并能看到该节点的职责边界。
- P0–P6 均可查看，且明确区分“已复现并修复”“无法复现”“保留边界”“没有达到性能门槛”。
- P0 显示 `40 writes / 40 unique ids`，P1 显示 `120 backlog / 120 catchup / 0 undelivered`。
- 事件时序能看见 App Server 链路和 backend direct 双入口事实。
- 接口表可以按 `POST`、`GET`、`WS` 过滤。
- 页面明确区分 `/events/stream` 与 `/ws/terminal-events`。
- 页面不出现修复方案、实施优先级或目标架构决策。

## 边界

- 原型不连接正式 App Server 或 backend，不写入用户的 Runweave home。
- P0–P6 的诊断数据只使用临时目录、独立 App Server 或纯内存 backend service，执行后已清理。
- 关系与接口来自当前工作区源码；后续代码变化时需要同步更新本原型。

## 冻结记录

- **采用**：分层泳道主链、场景高亮、问题因果证据页、接口分类表。
- **放弃**：圆形关系图、模块流水账、把未复现风险写成待修问题。
- **当前结论**：P0/P1/P2 已复现并修复；P3/P5/P6 未复现；P4 属于 7 天保留边界。
- **冻结日期**：`2026-07-11`。
