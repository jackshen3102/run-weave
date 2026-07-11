# 计划评审：Runweave 独立行为数据底座与经验生成系统

- 评审对象：`docs/plans/2026-07-11-system-activity-data-foundation.md`
- 类型：计划评审（方案是否成立）
- 代码基线核对：`feature@9786f3d`（工作区），Node `v22.22.2`
- 评审范围：结论/前提/目标/方案比较/架构/数据模型/存储留存/隐私/API/Learning/实施阶段/门禁
- 结论：方案整体成立、边界清晰、诚实度高（尤其“不猜 Task、不伪造全局顺序、暴露 gap”），但**把最难的基础设施前置、把真正价值(Learning)后置**是主要结构性风险，且有 4 个 P1 需要在冻结前处理。

---

## 总体判断

- 优点：三条“先纠正的前提”是本计划最有价值的部分，直接把常见的“录制一切 + 时间邻近猜任务 + 模型产物冒充事实”三个坑封死；数据模型（occurredAt/ingestedAt 分离、per-producer sequence、显式 correlation/causation、coverage gap 一等公民）是正确方向。
- 核心质疑：Phase 1（P0–P2）要新建一个独立 daemon + 存储引擎 + producer SDK + spool + capability token + schema registry，并埋点 Backend/Electron/Hook/Shell/Agent Team/Playwright/Frontend 七个面，而这一整套基础设施在一阶段唯一的消费者只是一个**只读的 Facts/Timeline/Sources UI**。真正验证价值的 Learning 被推到 P3/P4，且依赖尚未验证的模型产出质量。**这是“先修最贵的路、最后才验证有没有车要走”。**

---

## P1 严重（应在冻结方案前处理）

### 1. 价值前置错位：基础设施全前置，价值验证全后置

- 影响：P0–P2 是本计划工作量与风险最大的部分（新 daemon 生命周期、独立存储、SDK、七面埋点、三张新页面），但它们只服务于“看历史”。真正的赌注——“模型基于冻结 Context Pack 生成的 Learning 是否有用”——被放到 P3 之后。如果 Learning 产出质量不达预期，前面所有独立基础设施的投入无法回收，而这个假设到 P3 才第一次被真实检验。
- 定位：`计划.md:21`（一/二阶段划分）、`计划.md:507-567`（P0–P4）。
- 修复方向（不实现）：在 P0 之前插入一个**薄切片 spike**——只埋 2–3 个最高价值事件（如 `user.query.submitted` + `agent.turn.completed` + `verification.completed`），落到最简单的存储，手工跑一遍 Learning 提取，先证明“这些事实能产出值得沉淀的经验”。价值假设站住后再决定是否投资独立 daemon + SDK + 七面埋点。

### 2. 绝对化隐私承诺不可达，且是全系统信任的单点

- 影响：完成标准写“任何 token、cookie、Authorization、密码、环境变量 secret 或未授权私有正文**不能进入**事实、Blob、导出或模型 Context Pack”。但系统主动捕获命令文本、可见回复、tool args、7 天内容 Blob——基于文本的 DLP 本质是 best-effort，无法给出“绝不进入”的保证。把一个不可达的绝对承诺写成验收门禁，要么永远无法通过，要么被降级为形式检查。最危险的是 Context Pack → `approved-provider` 外发路径：一次泄漏就是真实安全事件。
- 定位：`计划.md:61`（完成标准）、`计划.md:434-438`（隐私）、`计划.md:498`（Context Pack 外发）。
- 修复方向：把承诺改为“分层防御 + local-only 默认 + 静态加密 + 明确残余风险”，并对“外发到 approved-provider”单列更严策略（默认禁用、逐 Project 显式授权、发送前人工预览脱敏 diff）。验收改为“注入的已知 secret fixture 全部被拦截 + 残余风险登记”，而非“任何 secret 不能进入”。

### 3. Singleton daemon 与多运行时版本仲裁缺失

- 影响：计划要求“每台设备一个本机 singleton”，同时“Hub schema 向后兼容当前 Stable 与一个 Beta”。但没定义**谁拥有/启动/升级这个 daemon 的二进制**。Stable、Beta、Dev 各自 bundle 不同版本的 Hub 构建，却只能有一个进程在跑：当 Beta 升级到 Hub v2、Stable 仍期望 v1 时，谁赢？升级 Hub 会不会打断另一运行时正在写入的 producer？只做 schema 后向兼容不足以覆盖 daemon 二进制/生命周期仲裁。App Server 已有 `source: global|local|bundled` + lock 单例的先例，Hub 需要一套类比的版本仲裁。
- 定位：`计划.md:160`（singleton）、`计划.md:574-575`（schema 兼容），对照 `app-server/src/config.ts`、`app-server/src/index.ts` 的 lock/source 机制。
- 修复方向：在“部署与隔离”里明确 Hub 二进制的所有权与升级策略：谁 spawn、锁如何选主、更高版本如何在不丢另一运行时 producer 的前提下热升级或握手降级、版本不兼容时的行为（拒绝启动 vs 兼容模式）。

### 4. 显式 ID 跨进程传播被低估——首版大量事件将是 unlinked

- 影响：整个 Interaction Timeline 的价值建立在 `interactionId/correlationId/causationId` 能从 Web 端 query 一路串到 Agent turn、外部 TTY hook、shell preexec、Agent Team、Playwright。这是全案**工程上最难**的一环（跨进程、跨外部 CLI、跨独立 shell 集成），计划却把它当作 P0 就能“冻结的规则”。现实首版里外部 hook/shell/agent-team 事件很可能大比例落入 `unlinked`，而 unlinked 事件正好绕过了 Timeline 这个一阶段唯一的价值出口。诚实的 gap 标记是对的，但计划没有说清“首版预期 unlinked 比例”与“这对 Timeline 可用性意味着什么”。
- 定位：`计划.md:33`、`计划.md:348-367`（关联模型）、`计划.md:516`（P0 冻结 ID 传播）。现有 hook 只透传 `RUNWEAVE_TERMINAL_SESSION_ID/PANEL_ID/TMUX_PANE`（`plugins/toolkit/hooks/runweave-hook-bridge.cjs:322-324`），并无 interaction/correlation 通道，需要新建。
- 修复方向：把“ID 传播”从“P0 冻结规则”降级为“P0 定义协议 + P2 逐面落地并度量 linked 率”，给出每个 surface 的 ID 来源与注入点（哪个进程生成 interactionId、如何经 env/协议传到外部进程），并设一个可度量的验收目标（如 Runweave 内部路径 linked 率 > X%，外部 shell 明确不承诺）。

---

## P2 一般（建议改）

### 5. 未认真对比“演进 App Server ingest 复用”这一中间方案

- 影响：方案比较里只有“扩展 App Server Event Center（不采用）”与“全新独立 Hub（采用）”两极，跳过了中间路径：**复用 App Server 已验证的 ingest 机器**（discovery、auth token、append-JSONL、dedupe、WS stream、多 producer 接入，backend/electron/cli/hook 已在推），只新增“共享 home 覆盖 + 富 envelope + SQLite 投影”。全新 Hub 要重写 spool/capability/discovery/auth，与现有能力大量重复。计划以“Stable/Beta home 隔离”否定 App Server，但那只是默认路径（`app-server/src/config.ts:33` 由 `RUNWEAVE_APP_SERVER_STATE_DIR` 决定），并非不可逾越；真正站得住的理由是“App Server 是控制面、Hub 要单向采集不做控制面”，这一点应写清楚，而不是用 home 隔离一笔带过。
- 定位：`计划.md:114-123`（方案比较）、`计划.md:98`（当前能力表）。
- 修复方向：在方案比较里补一行“演进/抽取 App Server ingest”方案，诚实对比“复用已测 ingest 省下的量” vs “控制面与采集面必须解耦的收益”，让“全新 daemon”的取舍可追溯。

### 6. 新 top-level `activity-hub/` 会逃过 `architecture:check`

- 影响：计划把 `pnpm architecture:check` 列为每阶段必跑门禁（`计划.md:582`），但 `scripts/architecture/scope.mjs` 的 `INCLUDED_PREFIXES` 只覆盖 `app/ app-server/ backend/ electron/ frontend/ packages/ plugins/toolkit/ scripts/`，**不含 `activity-hub/`**。若 P1 按 `计划.md:524` 新建**顶层** `activity-hub/` workspace 包，其源码不会进入架构报告（文件大小/循环依赖/React 指标全部漏检），门禁形同虚设。
- 定位：`计划.md:524`（P1 新增 activity-hub/ workspace）对照 `scripts/architecture/scope.mjs:16-25`。
- 修复方向：二选一——把新包放到 `packages/activity-hub`（自动被 `packages/` 前缀覆盖），或在 P1 显式把 `activity-hub/` 加入 `INCLUDED_PREFIXES`。同时消除 P0/P1 表述不一致（见残余项）。

### 7. SQLite 作为 P1 必需属于过度承诺

- 影响：计划已自知 `node:sqlite` 在 v22.22.2 仍是 Experimental（`计划.md:398`，已核对 Node 版本属实）。但 P1 把 SQLite 投影列为必交付项。既然计划反复强调“投影可从 30 天 segment 重建”（`计划.md:145,397`），P1 完全可以先用内存/JSON 索引满足 timeline/sources 查询，把 SQLite（及其 API 稳定性/Electron ABI 风险）延后到查询量真正需要时。
- 修复方向：P1 只承诺“可重建的查询投影”，SQLite 作为可替换 adapter 的一种实现延后；降低 P1 风险面。

### 8. 留存一致性：sealed Context Pack 是第二份 30 天内容存储

- 影响：内容承诺 7 天、事实 30 天；但 Context Pack “seal + resolved excerpts”会把脱敏正文**物理内联**进 Pack，而未审核 Pack 留存 30 天（`计划.md:407-408`）。这相当于在 7 天内容承诺之外，又开了一份最长 30 天的原文副本。若不显式登记，会与“正文默认 7 天”“用户删除优先于证据留存”的承诺相互打架（删除 Project 时，Pack 内内联正文是否一并 tombstone？）。
- 定位：`计划.md:404-408`、`计划.md:440`（删除优先）、`计划.md:476-480`（ContextPack/SupportCapsule）。
- 修复方向：在隐私/留存章节显式声明“sealed Pack 内联内容属于 30 天内容类”，并把它纳入删除/tombstone 传播路径（删除源数据时同步 tombstone 相关 Pack/Capsule）。

---

## P3 提示（可选）

### 9. 缺少一阶段“谁消费、驱动什么决策”的问题陈述

- “结论”直接给方案，未先说明一阶段的具体用户价值（只读 UI 给谁看、解决什么当下痛点）。补一句“Phase 1 的用户价值”能让“先建基础设施”的取舍更有据。定位 `计划.md:9-21`。

### 10. 每阶段验收矩阵成本高

- 验收要求“并行 Stable/Beta/Dev + 外部 hook + Agent Team + Browser + verification 一次真实轨迹集中显示”（`计划.md:545`），每阶段重复成本很高。建议固定一套可复用取证脚本/fixture（现有 `scripts/verify-app-server-*.mjs` 可作模板），降低回归验收开销。

---

## 残余风险 / 待确认

- **`activity-hub/` 位置不一致**：P0 写 `packages/shared/src/activity/`（`计划.md:513`），P1 写顶层 `activity-hub/` workspace（`计划.md:524`）。需明确新 daemon 是顶层还是 `packages/` 下——直接影响 P2-#6 的门禁覆盖与 `pnpm-workspace.yaml` 改动。
- **本机多 daemon 叠加**：一阶段后本机将并存 App Server（每运行时）、Backend、Activity Hub 三类常驻进程。资源/端口/发现/崩溃恢复的叠加复杂度未在“非目标/风险”中量化。
- **门禁真实性**：`pnpm architecture:check / typecheck / lint / build` 均存在且可跑（已核对 `package.json` scripts）；但涉及页面的 Playwright 与并行运行时的 `$computer-use` 取证，属于计划自列的硬约束，实施阶段需按 AGENTS.md 真实执行、不得以静态检查冒充。

---

## 已核对的事实（支撑上述结论）

- App Server event store 确为单 JSONL、全量入内存、7 天保留、清理时整文件重写（`app-server/src/event-store.ts`），与计划 `计划.md:98` 描述一致。
- App Server home 由 `RUNWEAVE_APP_SERVER_STATE_DIR` 决定，默认 `~/.runweave/app-server`（`app-server/src/config.ts:23-33`）——即“Stable/Beta 隔离”是默认路径而非硬约束。
- Hook 完成上报 gate 确在 `!token || !terminalSessionId` 处直接跳过（`plugins/toolkit/hooks/runweave-hook-bridge.cjs:347`），与计划 `计划.md:100` 一致；现有 hook 无 interaction/correlation 传播通道。
- Node 为 `v22.22.2`，`node:sqlite` 确会输出 ExperimentalWarning，与 `计划.md:398` 一致。
- `architecture:check` 存在且 `scope.mjs` 的 `INCLUDED_PREFIXES` 不含 `activity-hub/`（见 P2-#6）。
- 配套架构图与测试用例文档均已存在（`docs/architecture-flows/system-activity-data-foundation-flow/`、`docs/testing/system-activity-data-foundation-test-cases.md`）。
