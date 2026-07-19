# Beta Pool 可重复执行、所有权边界与测试合同审查

## 结论

这不是“整个 Beta 代码全部失效”，也不是单纯的测试启动方式错误。当前首个失败由两个问题叠加产生：

1. BETA-002 把固定 `HOME` 当成完整 fixture namespace，但真实 Beta App 和 rollback 位于全局 `/Applications`；现场 rollback 实际由真实用户 `$HOME` 的 warm-state pointer 持有，临时 fixture HOME 并不拥有它。因此该 Given 不成立，产品按未知资源 fail closed 是符合现有安全语义的，不能把这一次失败直接推广成所有正常生产路径失败。
2. 产品自身确实存在严重架构缺陷：同一个物理槽位的 lease、pointer 和 App/rollback 分属不同所有权域；启动失败后，release finalizer 又重复执行导致启动失败的 retention 检查，使 lease 无法收敛。这会影响多 HOME、多 macOS 用户、隔离验收和崩溃恢复，不只是测试便利性问题。

此外，审查当时的历史测试合同没有被完整保留。2026-07-18 的 YAML 整理删除了 `BSP-001` 至 `BSP-017` 的逐案合同；其中少量语义被压缩进 `DCP-007` 和 `PCR-002`，但原有粒度、次数、失败判据和证据要求没有被等价迁移。当时的 18 个 `BETA-*` 主要承接了 12 个 `BRM-*` 资源恢复场景，不能称为 Beta Pool “全场景”。恢复后的当前状态见文末。

## 代码审查发现

### P1 严重：同一物理槽位存在两个互不一致的所有权域

- 影响：`pool-01` 的 App 和 rollback 是全局路径 `/Applications/Runweave Beta pool-01.app` 与 `/Applications/.Runweave Beta pool-01.rollback-*`，但 lease 位于 `<HOME>/.runweave/beta-pool`，warm-state pointer 位于 `<HOME>/Library/Application Support/Runweave Beta/...`。两个不同 HOME 可以分别认为 `pool-01` 空闲并发布 lease，却同时操作同一个全局 App；临时 HOME 也无法解释真实用户 HOME 创建的 rollback。
- 定位：`scripts/runweave-update-core.mjs:57`、`scripts/runweave-update-core.mjs:136`、`scripts/dev-session/beta-slot-pool-storage-paths.mjs:30`、`scripts/dev-session/beta-slot-pool-core.mjs:447`。
- 现场证据：`/Applications/.Runweave Beta pool-01.rollback-1784440172111` 存在；`$HOME/Library/Application Support/Runweave Beta/instances/pool-01/warm-state/state.json` 正确指向该 rollback；失败 fixture HOME 中没有对应 pointer。
- 修复方向：必须先选定单一权威域。长期建议让物理 App、rollback、lease、pointer 和锁共享同一个可原子校验的 slot ownership record；如果产品只支持单用户 HOME，也要显式声明并在跨 HOME 操作前拒绝，而不是让每个 HOME 独立分配同一个全局槽位。

### P1 严重：启动失败清理复用同一失败前置，必然遗留 stale lease

- 影响：CLI 先获取 lease、写入 `starting` manifest，再执行 retention；缺少 pointer 时 retention 抛错。`cleanupFailedStart` 随后调用统一 release finalizer，但 finalizer 在释放 lease 前再次执行相同 retention，因此再次抛错，把 manifest 写成 `stale` 并保留 lease。一个资源一致性错误被放大为容量永久占用，需要后续额外恢复。
- 定位：`scripts/dev-session/cli.mjs:368`、`scripts/dev-session/cli.mjs:388`、`scripts/dev-session/cli-start-cleanup.mjs:57`、`scripts/dev-session/beta-slot-pool-lifecycle.mjs:115`、`scripts/dev-session/beta-slot-pool-lifecycle.mjs:147`、`scripts/dev-session/beta-slot-pool-lifecycle.mjs:234`。
- 修复方向：把“证明无 slot-owned 进程后释放本次新 lease”与“完成 retention”拆成可独立收敛的阶段；start 前置检查失败且尚未启动任何服务时，不应依赖同一个失败条件才能释放刚获取的 lease。receipt 仍需记录 retention blocker，未知 App/rollback 仍不得删除。

### P1 严重：App 更新事务存在未消费的崩溃恢复日志

- 影响：父流程先写 `pending.json`，子更新器再把现有全局 App rename 到 rollback、安装新 App；只有子进程成功返回后，父流程才把 rollback pointer 写入 warm-state。父进程或系统在两次写入之间崩溃时，会留下 rollback 与旧/空 pointer。仓库只写入和删除 `pending.json`，没有启动时读取并重放它的路径，因此同一 HOME 也可能进入 pointer missing/错误指向状态。
- 定位：`scripts/runweave-beta.mjs:181`、`scripts/runweave-beta.mjs:188`、`scripts/runweave-beta.mjs:222`、`scripts/runweave-update-operations.mjs:305`。全仓搜索 `pendingPath` 仅发现写入和删除，没有恢复读取。
- 修复方向：将 App rename、pointer 发布和 pending journal 设计为可重放事务。启动 retention 前先校验并消费 pending journal；只有 App identity、slot、baseline 和 rollback identity 全部匹配时才能重建 pointer，否则继续 fail closed。

### P1 严重：历史 Beta Pool 测试合同被压缩，当前计划不是“全场景”

- 影响：提交 `fbe0758` 删除了 `docs/testing/beta-slot-pool-test-cases.md` 中 `BSP-001` 至 `BSP-017`；此前 `5a213a3` 已删除独立 warm-retry 文档。新 YAML 中只有 `DCP-007` 和 `PCR-002` 概括性承接部分语义，没有保留逐案 Given/When/Then、10 轮重复次数、精确失败判断和真实 UI/CDP 证据合同。随后 `aecdd12` 合并的是 12 个 `BRM-*` 与存储相关 case，不等于恢复全部 BSP 合同。
- 丢失或弱化的关键覆盖：10 轮 start/stop 不增加 install target、10 轮 update 后 runtime/rollback/log 有界、下一 owner 的 Cookie/LocalStorage/IndexedDB/凭据隔离、status/open/CDP 身份一致、磁盘不足门禁、shared/Stable 所有权边界、legacy 显式 cleanup/restore/purge、固定 warm slot 重试。
- 定位：`docs/testing/platform/development-control-plane.testplan.yaml:75`、`docs/testing/platform/platform-critical-regressions.testplan.yaml:25`；审查时的旧入口为 `docs/testing/platform/beta-pool-storage-migration.testplan.yaml`，历史证据使用 `git show fbe0758^:docs/testing/beta-slot-pool-test-cases.md` 与 `git show fbe0758 -- docs/testing/beta-slot-pool-test-cases.md`。
- 修复方向：恢复为 YAML 的逐案合同，保留稳定 case identity 或建立明确的一对一映射；“合并”只能去掉文本重复，不能降低行为断言、重复次数、失败判据和证据强度。当前 `BETA-*` 计划应在完成映射前去掉“全场景”表述。

### P2 一般：现有 verifier 没有覆盖真实的跨 HOME/全局 App 组合

- 影响：retention verifier 把 `applicationsDir` 注入到临时目录，并人为同时创建匹配的 state pointer；“absent backup”场景实际是 backup 不存在，而不是“全局 backup 存在、当前 HOME pointer 缺失”。因此 verifier 可以通过，但真实 `/Applications` 与临时 HOME 的组合仍失败。
- 定位：`scripts/dev-session/verify-beta-slot-storage.mjs:154`、`scripts/dev-session/verify-beta-slot-storage.mjs:189`、`scripts/dev-session/verify-beta-slot-storage.mjs:214`、`scripts/dev-session/verify-beta-slot-storage.mjs:241`。
- 修复方向：增加不新增单元测试文件的真实行为验收：同一 ownership namespace 重复 start/stop、不同 HOME 观察同一全局 slot、pointer 丢失但 pending 完整、start 前置失败后的 lease 收敛。该覆盖应落入恢复后的 YAML 行为案例和现有 verify/E2E 入口。

## 对 BETA-002 的判定

- 本次失败不能判为“测试一开始命令错了”；显式 `--profile beta` 已修正，BETA-001 已通过。
- 也不能直接判为产品在合法 fixture 上未收敛：当前失败 fixture 并不拥有 `/Applications` 中的 rollback，真实 pointer 在另一个 HOME。按当前 case 的“未知资源必须保留并 fail closed”规则，这个现场应先判 `blocked/Given 不成立`。
- 但这暴露了 case 无法仅靠固定 HOME 构造真实 namespace：产品没有独立的 fixture slot namespace，只有全局五个 App 名称。因此 case 设计和产品架构都需要调整，不能继续通过换临时 HOME 或手工清空 `/Applications` 规避。

## 更简单的短期替代方向

在长期统一所有权域之前，验收可复用当前用户 HOME 中已存在且 pointer 完整的固定 slot，并用独占 session/slot 锁保证串行，验证“同 HOME、同 slot、重复 start/stop”。优点是无需删除真实 App/rollback，也符合旧 BSP-017 的 Given；缺点是不能验证跨 HOME 隔离，也不能解决产品架构缺陷，必须把这部分标为残余风险而非通过。

## 建议顺序

1. 先修正 BETA-002 判定：当前现场标为 `blocked`，停止把未知全局 rollback 当作 fixture 可收敛残留。
2. 恢复 `BSP-001` 至 `BSP-017` 的 YAML 等价合同，并与当前 `BETA-*` 建立覆盖映射，禁止删减生产回归断言。
3. 修复 start failure 的 lease 自阻塞，保证未启动服务时可安全释放本次 lease。
4. 统一物理 slot 的所有权域，并补上 pending journal 重放；之后再用跨 HOME 和崩溃窗口案例验证。

## 检查范围与未执行项

- 阅读了 Beta target path、lease acquisition、retention、release finalizer、App update 与 verifier 链路。
- 审计了 2026-07-16 至 2026-07-19 的相关 Git 提交与被删除测试合同。
- 只读检查了现存 `pool-01` App、rollback 和真实用户 warm-state pointer 的身份关系。
- 未重新执行测试计划、未启动/停止 Dev Session、未修改实现或测试；避免改变已固定的失败现场。

## 后续恢复状态

本报告形成后的恢复工作已将可执行合同拆为 `beta-pool-storage-migration.testplan.yaml`（保留历史入口，内容只测当前 canonical 控制面）与
`beta-pool-runtime-regressions.testplan.yaml`。旧 BSP 不变量的一对一去重映射记录在
`docs/deployment/runweave-beta.md`；明确过时且被当前范围排除的 legacy 数据迁移/cleanup/purge
场景不再执行。重复的正常停止/warm slot 重试合同已合并到 BETA-002；其余生产不变量仍保留原次数、失败判据与证据强度。

执行恢复期间还完成了两项当前实现修复：start release finalizer 在 retention 失败时记录 blocker 后继续发布终态并释放可证 lease；每个 slot 的 Activity SQLite native staging 与 Electron bundle output 改为跟随隔离 build root，不再并发改写 worktree 级 `.native-artifacts`。BETA-016 随后真实执行两轮五槽并发 start、满池第六请求和五槽并发 stop，均完成唯一 owner/nonce、容量 fail-closed 与最终 idle 收敛。

跨 HOME 的机器级 App 所有权和 App swap/pointer pending journal 仍是未关闭的产品风险，分别由 BPR-009、BPR-010 保留。BETA-017 因 computer-use native pipe 不可用且当前账号不满足未预授权隔离账号前置而环境阻塞，未判通过；运行时回归计划按 fail-fast 尚未执行。
