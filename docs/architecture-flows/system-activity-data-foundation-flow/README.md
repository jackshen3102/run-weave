# system-activity-data-foundation-flow（独立行为数据底座与经验生成流程）

Runweave 全系统行为数据如何在发生时主动进入独立 Activity Hub、如何跨 Stable/Beta/Dev/external 关联、如何按 7/30 天保留，以及后续如何冻结数据交给模型生成 Learning 的可运行 HTML 技术说明。

- **性质**：目标架构流程，不是已经上线的产品页面，也不是运行指标看板。
- **梳理日期**：`2026-07-11`。
- **代码基线**：`feature@2c4572c`。
- **核心边界**：行为事实独立存储；大多数数据直接记录，少量大对象/权威对象引用现有数据；模型只读取冻结 Context Pack。
- **配套验收**：`docs/testing/system-activity-data-foundation-test-cases.md`。

## 启动

```bash
python3 -m http.server 6196 --directory docs/architecture-flows/system-activity-data-foundation-flow
```

打开：

```text
http://127.0.0.1:6196/
```

## 怎么读

1. **数据主链**：切换 Query、Agent Team、Browser/Verification、Hub 下线重放和 Learning 生成场景，观察真正经过的节点。
2. **数据边界**：查看哪些数据直接写 BehaviorFact，哪些进入 Activity Hub 自有 7 天 Content，哪些才是 External Ref，哪些明确不承诺。
3. **数据结构**：查看 `activity.sqlite` 的 canonical 表、关联表、来源状态表，以及每组字段由 SDK、Producer、Hub、Registry 还是查询计算产生。
4. **经验生成**：区分确定性系统步骤与模型步骤；Learning 不由规则或界面 mock 自动产生。
5. **失败语义**：查看 collector 下线、Beta schema、seq gap、过期和删除如何显式收敛。

## 目标主链

```text
Stable / Beta / Dev / External producers
  → typed Activity SDK + durable spool
  → per-user Activity Hub
  → schema / privacy / dedupe
  → one activity.sqlite transaction, then ACK
  → 30d Behavior Facts + 7d encrypted Content BLOB + small External Ref descriptors
  → indexes / computed views in the same database
  → Facts / Interaction Timeline / Sources

事实选择
  → immutable Context Pack
  → Model Extractor / Consolidator
  → evidence validator
  → Candidate
  → human review
  → versioned Learning
```

## 与当前代码的关系

当前代码提供可复用的 producer 输入，但没有独立行为仓：

- App Server envelope 只有 generic payload，单 JSONL 默认 7 天，不能直接承担本方案。
- Backend Terminal Events 只在内存保留最近 500 条。
- Hook 缺少 Runweave Terminal identity 时会退出，当前不覆盖外部 TTY。
- Agent Team run、Terminal scrollback、Thread、Browser artifact 是各自权威数据，只作为 producer 输入或少量 External Ref。
- Beta 使用独立 App Server home；目标 Activity Hub 固定为 per-user 全局 home，以 `runtimeChannel` 区分来源，但不破坏运行时控制面隔离。

## 页面视图

| 视图     | 说明                                              | 是否代表产品 UI |
| -------- | ------------------------------------------------- | --------------- |
| 数据主链 | 目标系统的 producer、collector、store 和 consumer | 否，架构导航    |
| 数据边界 | 可可靠采集/引用/不承诺的矩阵                      | 否，协议设计    |
| 数据结构 | SQLite canonical 表、关联表及字段来源             | 否，存储设计    |
| 经验生成 | Context Pack 到 Learning 的审计闭环               | 否，运行流程    |
| 失败语义 | replay、gap、quarantine、expiry、delete           | 否，故障设计    |

## 关键结论

- App Server 可以是 producer，但不是 Activity Hub，也不是 Learning Service。
- `activity.sqlite` 是行为数据的唯一 canonical truth；Fact、Content ciphertext、External Ref descriptor、来源水位和隔离记录都以 SQLite 表为准。
- Producer 离线队列也必须是 SQLite（`spool_events` + `spool_loss_ranges`），但它是最多 7 天的交付缓冲，不是查询源或第二份 Fact store。
- JSONL 仅是当前 App Server 的既有实现事实，不进入目标存储链；删除 `activity.sqlite` 就代表删除行为数据，不能从 JSONL 或所谓 projection 重新生成。
- CLI 是 surface，不是 Runtime；Runtime 为 Stable/Beta/Dev/external。
- Timeline 只使用显式 ID 关联；没有 ID 就显示 unlinked/gap，不猜 Task。
- Query、可见回复、命令等核心内容属于 Activity Hub 自有短期存储；完整 Thread、scrollback、截图、run snapshot 才是 External Ref。
- 7 天内容过期后，30 天 link 保留 digest/length，Content tombstone 保留 kind/status；30 天后不永久归档。
- 模型不能改事实；Candidate 默认审核后才成为版本化 Learning。

## 文件

- `index.html`：页面结构与样式。
- `app.js`：场景切换、节点详情、矩阵、Learning 与故障视图。
- `mock-state.json`：基于方案与当前代码证据整理的结构化目标状态；不是生产数据。
- `prototype-preview.png`：Playwright 验收生成的首屏截图。

## 验收点

- 首屏明确写出“独立主动写入”，且没有“从现有数据临时汇总”的主链。
- 五个场景可切换，路径节点和场景步骤随之变化。
- 数据边界矩阵至少区分 Direct Fact、Hub-owned Content、External Ref 和 Not promised。
- 数据结构视图逐张展示 `activity.sqlite` 的 9 个 canonical 表，另列 1 张“不落表”的 Computed query output 卡；Producer 侧 2 个 transient spool 表在说明中单列。
- Learning 视图明确区分 deterministic 与 model，并显示 Context Pack、evidence validation、review/version。
- Failure 视图能看到 Hub down、seq gap、Beta schema、7/30 天过期和用户删除。
- 页面不把 Goal、Outcome、Rework、Task completion 或百分比 confidence 当作已记录事实。
- 浏览器控制台 0 error，所有导航和场景按钮可操作。

## 浏览器验收记录

2026-07-11 使用 `playwright-cli` 在 `1600 × 1000` 视口完成真实浏览器验收：

- `mock-state.json` 请求返回 `200`，页面标题为 `System Activity Data Foundation`。
- 数据主链的 Query、Agent Team、Browser/Verification、Hub 下线重放、Learning 五个场景均可点击；高亮路径节点数分别为 `10 / 10 / 10 / 9 / 6`。
- 点击 `Agent Team / Verification` 节点后显示“完整 run/outbox/evidence 仍由源系统拥有，只保存版本化引用”的职责边界。
- 数据边界视图渲染 8 类来源，并包含主动记录、只引用和不承诺三类状态。
- 数据结构视图渲染 9 张 `activity.sqlite` canonical 表卡和 1 张不落表的 Computed query output 卡；SDK、Producer、Hub、Registry、Computed 五类来源都有实际字段。
- 经验生成视图渲染 7 个步骤：4 个 deterministic、2 个 model、1 个人工 review gate；同时展示 5 类独立派生对象。
- 经验生成视图明确显示派生对象写入 `learning.sqlite`，不属于 `activity.sqlite` canonical truth。
- 失败语义视图渲染 5 个场景；7 天过期场景明确显示“删除内容，30 天 Fact 保留 digest”。
- 控制台 `0 error / 0 warning`。
- 首屏截图：`prototype-preview.png`。

## 非目标

- 不实现 Activity Hub 产品代码、数据迁移或模型调用。
- 不复用产品原型中的 mock Facts/Learning 作为架构证据。
- 不承诺捕获未安装 Hook/Shell Integration 的外部 TTY。
- 不用本图宣称任何生产吞吐、覆盖率或 Learning 已经存在。
