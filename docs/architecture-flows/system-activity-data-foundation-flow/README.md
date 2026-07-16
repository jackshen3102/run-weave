# system-activity-data-foundation-flow（P0 共享 SQLite 与未来经验生成流程）

Runweave 全系统行为数据如何由现有 Stable/Beta/Dev Backend 主动写入同一份 profile 外 SQLite、如何按 7/30 天保留，以及后续如何冻结数据交给模型生成 Learning 的可运行 HTML 技术说明。

- **性质**：P0 已实现架构 + 明确的 Verification/Learning 未来边界；不是生产运行指标看板。
- **梳理日期**：`2026-07-12`。
- **代码基线**：`docs/activity-data-foundation-contracts` 当前 working tree。
- **核心边界**：不新增服务或 daemon；Backend 是唯一 DB 访问边界，行为数据独立存储，大对象只保留引用，模型只读取冻结 Context Pack。
- **配套验收**：`docs/testing/architecture/system-activity-data-foundation-test-cases.md`。
- **配套产品原型**：旧行为事实原型与 Activity 产品原型均已删除；本目录继续作为行为数据底座的架构说明。

## 启动

```bash
python3 -m http.server 6196 --directory docs/architecture-flows/system-activity-data-foundation-flow
```

打开：

```text
http://127.0.0.1:6196/
```

## 怎么读

1. **数据主链**：切换 Query、Agent Team、Browser/Verification、当前 Backend 暂时不可达和 Learning 生成场景。
2. **数据边界**：查看哪些数据直接写 BehaviorFact，哪些进入 Backend-owned 7 天 Content，哪些只保留 External Ref。
3. **数据结构**：查看 `activity.sqlite` 的表、关联和维护状态，以及字段由 SDK、Producer、Backend Store、Registry 还是查询计算产生。
4. **经验生成**：区分确定性系统步骤与模型步骤；派生对象进入独立 `learning.sqlite`。
5. **失败语义**：查看当前 Backend 不可达、Beta schema、sequence gap、过期和删除如何显式收敛。

## 目标主链

```text
Backend 内部行为
  → 当前 Backend 进程内 recorder ┐
Electron / Hook / CLI
  → 各自当前 Backend 的既有 HTTP / CLI command surface ├→ Backend 内 ActivityStore
其它 TTY
  → 显式 rw activity record agent-hook|terminal-command-* --profile/--backend-port ┘

Stable / Beta / Dev 各自现有 Backend
  → 同一 profile 外路径 ~/.runweave/activity/activity.sqlite
  → WAL + busy_timeout + 短 BEGIN IMMEDIATE
  → event_id + producer epoch/sequence UNIQUE；fingerprint 冲突校验
  → 30d Facts + 7d encrypted Content + small External Ref descriptors
  → 当前 Backend query API
  → Facts / Timeline / Sources / Data Policy UI

数据操作
  → Content read: audit commit → body
  → export/delete: 普通 Bearer 请求 + scope
  → export: current snapshot + audit → body
  → delete: requested audit + query tombstone → durable chunked job

maintenance
  → migration: BEGIN EXCLUSIVE + PRAGMA user_version
  → retention / activity-delete runner: maintenance_leases + fencing token
  → checkpoint: lease 抑制重复调用 + SQLite checkpoint lock

事实选择
  → Backend query API
  → immutable Context Pack
  → Model Extractor / Consolidator
  → evidence validator
  → human review
  → 独立 learning.sqlite
```

## 与当前代码的关系

- `backend/src/activity/` 已实现 worker-owned SQLite、WAL、迁移、幂等、gap、加密 Content、7/30 天留存、审计和 durable delete job。
- `backend/src/routes/activity.ts` 已实现复用现有登录鉴权的 Facts/Timeline/Sources/Policy/Content/export/delete API。
- Stable/Beta/Dev 的 Backend 直接共享 profile 外固定数据库；三进程同库集成脚本已验证 300 条并发 Fact、完整性和权限。
- Terminal、Hook、Electron Browser 与 Agent Team durable transition 已接线；Verification family 在身份化 runner 完成前不注册。
- `/activity` 已实现 Facts、详情/Content、Timeline、Sources、Data Policy 与直接 export/delete；CLI 始终调用所选 Backend。
- App Server JSONL、Thread、scrollback、run、outbox 与 Browser artifact 仍保持原职责，只作为来源或 External Ref，不成为 Activity 依赖。
- 外部 TTY 仍不承诺自动捕获，只允许显式 Hook 或受控 shell adapter 经所选 Backend 写入。

## 页面视图

| 视图     | 说明                                                        | 是否代表产品 UI |
| -------- | ----------------------------------------------------------- | --------------- |
| 数据主链 | producer、当前 Backend、ActivityStore、SQLite、查询 API、UI | 否，架构导航    |
| 数据边界 | 可可靠采集、引用和不承诺的矩阵                              | 否，协议设计    |
| 数据结构 | SQLite canonical/operational 表及字段来源                   | 否，存储设计    |
| 经验生成 | Context Pack 到独立 Learning 库的审计闭环                   | 否，运行流程    |
| 失败语义 | unavailable、retry、gap、rejection、expiry、delete          | 否，故障设计    |

## 关键结论

- 不新增独立服务、daemon、端口、服务发现或单独凭据；每个调用方只使用其当前 Backend。
- Stable/Beta/Dev Backend 各有进程内 ActivityStore，但共同读写 `~/.runweave/activity/activity.sqlite`。
- CLI、Hook、Electron、UI 和 Agent 都不直接打开 DB；写入与查询都经过当前 Backend。
- SQLite 通过 WAL、`busy_timeout`、短 `BEGIN IMMEDIATE` 和幂等 UNIQUE 收敛跨 Backend 写竞争。
- Content 与 ExternalRef descriptor 按 Fact+role+ordinal 独占；跨 Project/Thread 即使内容或 locator 相同也不复用 row，scoped delete 只级联自己的对象。
- Schema migration 使用 `BEGIN EXCLUSIVE + PRAGMA user_version`；retention/delete runner 的每个删除事务都按 owner + fencing token + 未过期状态重新校验，stale owner 不能继续删除。
- packaged/external runtime 都由构建脚本生成完整文件树 manifest；Backend 启动 Activity worker 前必须校验 worker 和 JS/native runtime 闭包的 ABI、逐文件 SHA-256 与 tree hash。
- Content read/export/delete 使用普通登录鉴权并提交 audit；delete 先提交 query tombstone/job，再由现有 Backend 以 ≤1000 Facts/8 MiB 小事务可恢复删除。
- 当前 Backend 不可达时客户端明确报告未记录；P0 不创建客户端 spool，也不伪造稍后会自动补传。
- `activity.sqlite` 是行为数据唯一 canonical truth；删除它就代表删除行为数据，不能从 JSONL 或 projection 重建。
- Query、可见回复、命令等短期正文存 7 天；Fact/link 存 30 天；完整 Thread、scrollback、run、截图等大对象只引用。
- Learning 基于冻结 Context Pack 生成，写入独立 `learning.sqlite`，模型不能修改行为事实。

## 文件

- `index.html`：页面结构与样式。
- `app.js`：场景切换、节点详情、矩阵、Learning 与故障视图。
- `mock-state.json`：基于方案与代码证据整理的结构化目标状态；不是生产数据。
- `prototype-preview.png`：2026-07-11 以 1440×1000 viewport 保存的默认 Query 场景首屏。

## 验收点

- 首屏明确写出“复用现有 Backend”，且不存在独立采集服务或 owner 发现链路。
- 五个场景可切换，路径节点和场景步骤随之变化。
- 数据主链明确区分 Backend 内部 recorder、当前 Backend transport、ActivityStore、共享 SQLite、Backend query API 和 UI。
- 数据边界矩阵至少区分 Direct Fact、Backend-owned Content、External Ref 和 Not promised。
- 数据结构视图逐张展示 `activity.sqlite` 的 12 张表及 1 张“不落表”的 Computed query output 卡。
- 页面明确展示固定 DB 路径、跨进程 SQLite 策略、maintenance lease 与 schema migration 边界。
- 页面明确写出 CLI/Hook/Electron 不直接打开 DB，外部 TTY 只能显式记录。
- Learning 视图显示 Context Pack、evidence validation、review/version 与独立 `learning.sqlite`。
- 页面不把 Goal、Outcome、Rework、Task completion 或百分比 confidence 当作已记录事实。
- 浏览器控制台 0 error，所有导航和场景按钮可操作。

## 浏览器验收状态

2026-07-12 使用 `playwright-cli` 打开 `http://127.0.0.1:6196/`，以 1440×1000 viewport 重新完成：

- 数据主链、数据边界、数据结构、经验生成、失败语义 5 个视图均可见且有内容。
- Query、Agent Team、Browser + 验证、Backend 不可达、Learning 5 个场景均可切换，详情随场景更新。
- 数据结构渲染 12 张 SQLite 表和 1 张 Computed output 卡。
- `mock-state.json` 返回 200；浏览器 console 为 0 error / 0 warning。
- `prototype-preview.png` 已覆盖为新的 Backend-owned/shared-SQLite 默认阅读状态，不再使用旧 Activity Hub 截图。

## 非目标

- 不在本阶段实现身份化 Verification runner、模型调用、Learning Candidate、审核发布或 `learning.sqlite`。
- 不新增后台进程来统一转发 Stable/Beta/Dev 行为。
- 不复用产品原型中的 mock Facts/Learning 作为架构证据。
- 不承诺捕获未显式配置 Agent Hook 或受控 zsh adapter 的其它 TTY。
- 不用本图宣称任何生产吞吐、覆盖率或 Learning 已经存在。
