# 本机浏览记录

记录访问时间、标题和脱敏网址，供 Agent 按主题整理浏览回顾。访问记录只证明页面访问，
不证明完成配置、实现或发布。来源合同在 `@runweave/shared/browser-history`。

## 两个入口

- Runweave 桌面右侧 Browser：工具菜单 → 浏览器插件 → 浏览记录开启“记录新访问”，按 Browser Profile 保存开关
  和稳定来源身份；同 Profile 的窗口共用开关，各 Group 的记录保留原归属。默认关闭。
  “保存状态”显示保存状态、错误和目录。由统一插件宿主的内置插件观察主框架提交，无须安装外部扩展。
- 外部 Chrome / Edge：使用[同一 MV3 扩展](../browser-history-extension/README.md)，
  配合按需启动的 Native Messaging 本机接收器。独立于 Runweave 进程运行。
  扩展按浏览器 Profile 生成来源身份，安装后默认记录新访问。

首版接收器安装器支持 macOS、Node 22+；不含 Windows / Linux 安装器。
内置插件宿主与按 Profile 安装第三方解包扩展的入口见
[Browser 插件宿主](../../electron/src/browser/plugins/README.md)。

## 构建与读取

在仓库根目录执行：

```bash
pnpm --filter @runweave/browser-history build
pnpm browser-history status
pnpm browser-history collect --from 2026-10-27 --to 2026-10-27 \
  --timezone Asia/Shanghai --out /private/tmp/browser-review-20261027
pnpm browser-history read --bundle /private/tmp/browser-review-20261027 \
  --id '<sourceId>:<visitId>' --verify-source
```

默认数据根为 `~/.runweave/browser-history`；命令可通过 `--root <dir>` 指定其他本机根。
Dev Session 的内置 Browser 使用其隔离 userData 下的 `browser-history`，实际路径见状态菜单。
`collect` 可重复传 `--source-id <UUID>`，仅选择指定来源及其 streams；不存在的预期来源产生 unavailable，未选中来源不影响回执。
`--out` 必须是不存在的新目录。退出码：0 表示本次读取成功，2 表示材料不完整，1 表示命令失败。

采集产物：

- `visits.jsonl`：按 `(sourceId, visitId)` 合并后的最新合法修订及源行定位。
- `manifest.json`：日期、时区、来源回执、文件快照摘要、读取状态。
- `daily-browser.md`：供阅读的访问清单；主题归纳由 Agent 按
  [Daily Record 浏览材料说明](../../plugins/toolkit/skills/daily-record/references/browser-history.md)执行。

`collect` 和 `read` 只读源文件，不自动上传、写随记或配置定时任务。
`read --verify-source` 核对原行摘要及其与材料的一致性；源日志移走后不能声称回查通过。

## 记录语义

只记录启用之后的 HTTP(S) 主框架提交及实际同文档 URL 变化。重定向中间地址、iframe、
未提交失败、浏览器内部页不记；不回填原生浏览历史。标题晚到以同一 visit 的 revision 追加，
不增加访问数；缺标题保留 null。内置 Browser 隐藏、重新显示和休眠恢复不算新访问。

网址移除账号密码、query 和 hash，只保存 origin 与 path；query/hash 路由变化仍可产生访问，
但其值不落盘。标题最多 512 个 Unicode 字符，可能含页面本身提供的文本。
不读取正文、Cookie、截图、键盘输入或停留时长，也不区分访问是用户还是 Agent 发起
（`actor: unknown`）。外部扩展禁用无痕模式。

每个写入进程拥有独立 stream，使用串行追加和 fsync；目录权限 0700、日志 0600。
原始 JSONL 允许重放及修订；计数和去重以 collect 的访问视图为准，不按物理行数计数。
不同来源的同网址访问保留，Agent 可以合并主题叙述并保留所有依据。

`coverage: observed-only` 表示只覆盖实际记录到的访问。`readStatus: complete` 只表示
已登记来源的现存日志读取完整，不代表全天活动、所有浏览器或所有设备已覆盖。
非法 JSON、尾部半行、未来 schema、身份冲突或已登记日志缺失会降低读取状态，保留有效材料
和原因；不能据此写“当天没有浏览”。本地没有登记来源时也返回 partial。

## 接收协议与恢复

接收器只接受登记扩展 origin，使用固定 hello / append / status 协议；sourceId / visitId
必须是 UUID。批次最多 100 条、256 KiB，每条最多 8 KiB。没有任意文件路径或执行命令操作。
只有写入同步完成后才返回原始 `(sourceId, visitId, revision)` ACK。

扩展将队列写入 storage.local 后交付；失联、超时或未知 ACK 保留原身份重试。
Worker 重启从队列恢复；相同原始观察重放不会增加访问数。待发送队列达到 4 MiB 时暂停新采集，
保留旧记录；恢复接收器后先交付旧队列，再手动重新开启。暂停期间不补造访问。
内置 Browser 先将观察同步保存至 userData 的 `browser-history-outbox/<profile>`，再交付日志。
写入失败保留原身份待重试，状态按 Profile 隔离；每 30 秒自动重试，也可从菜单“重试保存”。
队列及最后落盘回执跨重启保留，容量同为 4 MiB；暂存失败或容量耗尽会暂停新采集并显示错误，
旧数据保留，恢复后手动开启。只有日志同步写入成功才更新落盘状态，正常退出等待当前队列排空。

## 验证入口

```bash
pnpm --filter @runweave/browser-history typecheck
pnpm --filter @runweave/browser-history verify
pnpm --filter @runweave/browser-history fixture
```

`verify` 使用临时目录与真实 stdio 子进程验证协议和文件读写，不连接真实用户历史。
真实 Chrome、Edge、Runweave 交互按[验收用例](../../docs/testing/browser/history-collection.testplan.yaml)
另行执行；构建通过不能替代浏览器验收。
