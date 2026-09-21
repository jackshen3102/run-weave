# Evolution 仓库身份迁移

Evolution schema 5 的 Project scope 转换为 schema 6 的 Git common-directory 身份。
Experience 的目录和 namespace 不变。迁移工具只操作显式指定的 Activity/Evolution 数据根目录，
不会调用模型。

## 更新后的自动迁移

Backend 启动时，在 Activity/Evolution worker 和业务写入启动之前检查数据版本。
schema 5 旧库自动执行审计、成对 SQLite 备份、仓库身份转换和完整性校验；成功后才启动服务。
新安装正常建库；已完成的 schema 6 库直接跳过，重启不会重复迁移或再次启用后来被手动暂停的计划。
每个独立数据目录各迁移一次，共用数据目录的多个 Backend 由目录级启动锁互斥。

升级前先停止所有使用同一数据目录的旧 Backend。发现仍有数据库 owner、输入发生变化、
数据库缺失或校验失败时，新 Backend 明确报错并停止启动，不降级为看似正常的空 Evolution。
macOS 使用系统 lsof；Linux 需要 PATH 中有 lsof，无法检查 owner 时拒绝迁移。
Electron 等待首次启动最多 10 分钟，更新桌面时需要同时使用新版壳；旧壳仍有 30 秒启动上限。

启动清单保存在 `<data-root>/evolution/repository-startup/manifest.json`，备份与阶段账本见下文。
中途退出后重新启动会恢复同一份清单，包括两个数据库提交之间的中断；不要删除清单或锁来跳过错误。
旧版尚未完成的 Run 保留为 blocked 历史记录，不能继续使用旧 Project 范围取材。
仅恢复原本启用且仓库与固定 checkout 均已核验的计划；未知或混合归属的计划仍暂停。
Canary 保持关闭，原始历史证据保留。

源码入口：`backend/src/bootstrap/evolution-migration.ts`。下列显式命令保留用于离线预演、审计和恢复。

## 审计与演练

从仓库根目录执行，目录必须使用绝对路径：

```bash
pnpm --dir backend exec tsx ../scripts/evolution/migrate-repository-identity.mts audit \
  --data-dir /absolute/data-root --output /absolute/manifest.json
pnpm --dir backend exec tsx ../scripts/evolution/migrate-repository-identity.mts apply \
  --data-dir /absolute/data-root --manifest /absolute/manifest.json
pnpm --dir backend exec tsx ../scripts/evolution/migrate-repository-identity.mts verify \
  --data-dir /absolute/data-root --manifest /absolute/manifest.json
```

`audit` 仅以只读连接读取原库，输出逐表计数/摘要、证据归属、topic lineage、候选和计划转换清单。
当前路径本身不证明历史归属：会话注册与已有可信绑定参与核验；当前 Git 创建时间晚于历史
记录时不能认领它。缺少证据、被删除的未知路径或跨仓库记录保留 unresolved/mixed。
无 cwd 的原事实不会被重写。支持和反证必须全部归属明确；缺失或过期行为证据不能支持可注入迁移。

原库必须分别位于 `<data-root>/activity/activity.sqlite` 与 `<data-root>/evolution/learning.sqlite`。
备份和账本位于 `<data-root>/evolution/repository-migrations/<migrationId>/`，目录 0700、文件 0600。
使用 SQLite backup API 包含 WAL 中已提交的数据，不能只复制正在使用的主文件。

## 正式切换

1. 盘点打开两个共享库的 Stable、Beta、Dev Backend，准备升级它们实际加载的构建。
2. 停止这些 owner 和调度，优先等待活动 Run 结束；未完成任务会保留为 blocked。用 lsof 核对无打开连接。
3. 停写后重新 audit。旧 manifest 的输入摘要与当前库不一致时 apply 拒绝，不自动更新清单。
4. apply 持有独立迁移锁，先备份、设置 writer 门禁，再提交 Activity 索引和 Evolution 转换。
   两个库是分阶段事务，不能宣称跨库原子提交。verify 完整性、原始摘要、绑定与全部预期变更
   通过后才写完成标记；旧 minimumWriterVersion=1 的程序随后无法打开。
5. 启动一个新版 Backend，验证仓库 API、页面与受控回补；其余 owner 只能恢复到已升级版本。
   需要恢复迁移的定时计划时，先关闭这个验证 Backend，再执行显式恢复命令：

```bash
pnpm --dir backend exec tsx ../scripts/evolution/migrate-repository-identity.mts verify \
  --data-dir /absolute/data-root --manifest /absolute/manifest.json --resume-schedules
```

恢复仅允许 manifest 中原本启用、仓库和固定 checkout 都已核验的计划；混合/未知仍暂停。
此命令要求迁移后尚无业务变更（严格 verify）；若已经产生业务变更，使用页面逐项启用已确认的
计划，不能覆盖历史状态。旧 global 计划不能继续作为全局分析运行。

## 恢复与回滚

同一 manifest 重复 apply 幂等。进程中断后重跑相同命令；仅在锁记录的同一迁移 owner PID
已经不存在时才能恢复锁，未知或活跃 owner 一律拒绝。Evolution 在中间阶段保持不可写。

业务恢复前可回滚两个库：

```bash
pnpm --dir backend exec tsx ../scripts/evolution/migrate-repository-identity.mts rollback \
  --data-dir /absolute/data-root --migration-id <migrationId>
```

rollback 校验成对备份，保存回滚前 SQLite 快照，逐库恢复并支持中断续做。WAL/SHM 仅在对应
连接全部关闭后清理。迁移后出现新 Run、知识、事件或其他业务写入时拒绝覆盖；此时应保存增量，
用兼容新 schema 的修复版本恢复服务，不能将新仓库知识猜成某个旧 Project。

验证入口：[仓库身份测试计划](../testing/evolution/repository-identity-migration.testplan.yaml)、
`pnpm --dir backend exec tsx ../scripts/evolution/verify-repository-identity.mjs`。
