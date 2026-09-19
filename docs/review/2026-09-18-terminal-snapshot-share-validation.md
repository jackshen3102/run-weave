# 终端快照分享：实施与验证记录

日期：2026-09-18。过程记录，不替代[当前产品合同](../cli/terminal-snapshot-share.md)。

## 实施状态

[实施计划](../plans/2026-09-18-terminal-snapshot-share.md)的 T1–T4 和活文档已完成，未新增依赖或单元测试，未提交代码。用户原有 iOS、模拟器和 Toolkit 改动未修改。

独立审查发现并关闭了两项问题：

1. Header 在切换连接时卸载会丢失分享结果。现在使用仅内存的 `snapshot-share-store.ts`，通知挂载在 App 的连接 keyed providers 外；不把 bearer URL 写入持久化状态。
2. 文件 fsync 不保证发布目录项的耐久性。现在同步首次创建的目录所在父目录，以及发布、临时文件清理后的快照目录，失败不返回 201。

独立复核结论：两项已静态关闭，无新增阻断。普通 Backend 重启不等于断电耐久性验证，本次未做断电试验。

## 环境与版本归属

- source root：仓库的 `.worktree/wt-1` 工作区。
- source revision：`8f912b9b16a8bb4b78bb90f6070227bce43ebeca` 加本次未提交改动。
- planner 要求 `beta`；使用 `pnpm dev:session`，没有降低 profile 或手工启动产品服务。
- 第一轮 `dvs-631e26` / `pool-04` 仅验证早期构建，不作为最终代码证据。实际启动时控制面验证旧槽位进程已不存在，自动回收陈旧租约后分配；没有手动抢占。
- 审查修复后重新 dry-run、构建并创建最终 Session：`dvs-f9f6ba` / `pool-04`。Backend、App Server、Electron 和 CDP 均为该 Session 的 dedicated 资源。
- 最终 desktop / terminal-browser 均由 `dev:open --session dvs-f9f6ba` 解析，使用仓库固定 Playwright CLI 附着，没有复用 ambient endpoint。
- 两个 Session 均已 `dev:stop` 成功：`stopped`、`failure: null`、自有进程已退出、lease 已释放。没有停止其他 Session。

## 静态门禁

以下均通过；父会话修复后重新执行受影响的 frontend/backend 类型检查、lint 与架构门禁：

- shared/backend/frontend typecheck；backend/frontend lint。
- `pnpm architecture:check`：runtime/type-only cycles、forbidden imports、shared-root imports 均为 0。
- `TMPDIR=/tmp pnpm backend:verify-lifecycle`：最终代码复验通过，`ok: true`，7 项检查完成。首次在 context-mode 的深层临时目录执行遇到 Unix socket 路径过长；仅为该命令缩短 TMPDIR 后重跑通过，未修改产品绕过门禁。verifier 故意注入的清理错误日志不等于命令失败。
- `pnpm docs:check`、`pnpm testplan:validate docs/testing/terminal/snapshot-share.testplan.yaml`。
- `git diff --check`；没有 staged 文件。

## 最终构建的真实运行证据

所有请求发往最终 Session 的真实 Backend，通过正常认证创建 Session/Panel，再由真实 tmux 捕获。没有伪造快照响应。临时 HTTP 驱动脚本位于 `/tmp`，不作为新增单元测试入库。

### 顺序执行的 YAML 主链

依据[16 条验收合同](../testing/terminal/snapshot-share.testplan.yaml)先执行主链：

| Case    | 结果                   | 关键证据                                                                                                                                |
| ------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| TSS-001 | 通过                   | A 为选中 Panel，显式请求 B；创建 201，匿名读取 200，包含 `FINAL_B_001` 与 `FINAL_B_090`，无 A 标记；期限差恰为 86400000ms；正文 99 行。 |
| TSS-002 | 通过                   | 创建后继续输出、清屏、改名、删除源 Session，重新读取 HTML 与原内容完全一致，仍为 200。                                                  |
| TSS-003 | 通过                   | 不存在 Session、其他 Session 的 Panel、已删除 Panel、缺失/额外路径均 404，无 sharePath，记录数不变。                                    |
| TSS-004 | 通过                   | 匿名初始 HTML 包含全文；通过原生 desktop CDP 禁用页面脚本后刷新，仍有 99 行和 Unicode 内容，按钮/input/h1/header/footer 数量均为 0。    |
| TSS-005 | 前置未满足，未完整执行 | 本轮 Beta 没有启用 tunnel scope all。没有把局部无凭据请求检查当作完整 tunnel/WS 隔离通过。                                              |

没有宣称 16 条全部通过；后续 Case 不作为一次完整顺序 YAML run 的通过项。下列为实现阶段另做的定向检查。

### 定向 HTTP 检查

- 无凭据，以及把分享 token 当 bearer，访问列表、创建、input、interrupt 均返回 401。
- 公开 URL 的 POST/PUT/DELETE 返回 405，附加子路径返回 404。
- 对本 Session 真实创建记录，仅将 expiresAt 改到过去：GET、HEAD、带 If-None-Match / If-Modified-Since 的请求均返回 404，没有正文或 304；未改机器时钟或产品期限。这是边界 fixture，不是等待了 24 小时。
- 把一份自有记录改为损坏 JSON：返回 404，不泄露正文；另一有效快照仍 200。
- 将本 Session 的快照目录临时设为不可写：创建返回 500 且无 sharePath；恢复权限后创建 201。
- 通过真实创建接口填到 100 份记录：下一份返回 507，已有快照仍可读。只删除本次配额检查新建的记录，之后由 Dev Session 停止流程清理整个自有 fixture。
- 成功响应带 no-store、no-referrer、nosniff、noindex、固定 hash CSP，无 ETag 或 Set-Cookie。

### 定向浏览器检查

- 从真实 Terminal 的 `…` →「分享终端快照」创建，通知显示复制成功；读取真实剪贴板与链接一致，HTTP origin 属于本次 Backend，而非 `runweave://app`。
- 暂缓真实创建响应（不改服务端响应内容），通过真实连接切换 UI 从 `127.0.0.1` 连接切到同一隔离 Backend 的 `localhost` 连接，再放行响应：请求数为 1、服务端 201、成功通知仍出现、链接仍使用原请求的 Backend base。
- 点击第 25 行、Shift 点击第 28 行，得到 `#L25-L28`；刷新恢复 4 行高亮。390px 窄屏文档宽度仍为 390px，行数和范围不变。
- 越界 hash 清空高亮，不隐藏任何正文；清空 hash 不残留旧范围。
- 捕获的 `<script>window.TSS_XSS=1</script>` 作为转义文本呈现，页面未设置该变量；没有把此项当作完整恶意输入矩阵通过。

## 尚未覆盖与工具限制

- 未完成 tunnel scope all、真实 WS 鉴权矩阵、同 profile 重启保留、10 MiB/100 MiB 字节边界、4 并发边界、Vite 同源代理、反向代理路径前缀与完整日志泄漏扫描。
- Electron 中尝试通过 CDP 将 clipboard-write 权限设为 denied，权限查询为 denied，但实际写入仍成功；因此未声称真实剪贴板拒绝分支验证通过。该分支和通知跨卸载结构经静态审查，仍需补实际拒绝环境。
- terminal-browser CDP 不支持本次禁用脚本方法；改用同一 Dev Session resolver 提供的原生 desktop CDP，选中同一自有分享页面完成验证。没有另开无关浏览器。
- 截图存在 CDP 超时，本轮以真实交互、DOM、剪贴板和 HTTP 证据为准，不提供虚构截图，也不使用原型截图替代产品验收。
- HTTP 驱动最初把 204 和 HTML 404 当成 JSON 解析，修正驱动后重新执行；未修改产品去掩盖工具错误。

## 续验：TSS-005 环境启动与回收阻塞

用户要求继续后，按独立执行模式重验 schema（16 required cases，通过），从首个未完成的 TSS-005 开始准备环境；没有跳过该条并宣称全量通过。

- 相同 source root 的新 dry-run 仍要求 Beta，容量可用。为启动命令的进程环境设置随机 `RUNWEAVE_TUNNEL_TOKEN` 和 `RUNWEAVE_TUNNEL_AUTH_SCOPE=all`，未设置系统级变量或改产品代码。
- 实际分配 `dvs-2331cb` / `pool-04`；构建执行完成，但启动返回 `Beta instance update/start failed`、`unhealthyComponents=backend`、`Beta did not reach desktop/backend/CDP health before timeout`。
- 自有 Backend 运行日志有 190 余条 `tunnel-auth.rejected`，路径为 `/health`。原因与代码一致：健康检查不携带 tunnel 凭据，而 scope all 明确保护 `/health`。这属于验收环境前提失败，不能据此判定快照分享实现失败。
- `dev:status` 解析出该 Session 为 stale，manifest 服务条目没有 PID/完整进程身份。恢复指引明确要求 `pnpm dev:stop --session dvs-2331cb --cleanup-stale --json`。
- 已核对 Beta status 的 `devSessionId=dvs-2331cb`、`instanceId=pool-04`、App PID 53665 与实际可执行文件匹配，再执行上述恢复命令；命令仍退出 5：`stale service identity drifted; refusing to reset or release Beta slot`，`resetUnsafe=true`。
- 最后观测：Backend 已记录 `backend.shutdown.completed`，但回滚后的 Beta App 仍在，槽位未获准释放。**该 Session 清理尚未完成**；没有通过杀进程、修改 manifest、删除 lease 或手工低层启动来绕过控制面。

本轮 TSS-005 标记未执行（环境阻塞），TSS-006–016 未在本次顺序续跑中执行；保留上轮定向证据，不提升为完整 Case 通过。解决此项需要扩展到 Dev Session / packaged Backend 的带鉴权健康检查和失败启动回收，已暂停并请求用户确认，不擅自修改这些外围行为。

本机证据：`/tmp/tss-continuation-{plan,start,status,stop}.log`、`/tmp/tss-continuation-health-evidence.json`。临时凭据不写入本文或源码。

## 用户追加：显式签名 URL

用户随后明确批准将随机 opaque-token 链接改为显式签名链接。本节对应更新后的代码；前面的旧链接验证仅为历史证据，不代替新合同的验收。

- 新 URL：`/share/terminal/<snapshotId>?expires=<Unix毫秒>&signature=<HMAC-SHA256>`。HMAC 绑定固定版本/只读用途、UUID 和到期时间。
- `.signing-key` 独立持久化为 32 字节随机密钥，`0600`，文件及目录 fsync、独占原子发布；不复用 Backend 登录或 tunnel 密钥。异常长度密钥不静默轮换。
- Backend 先规范解析、验签和验期限，再读取记录并比对 ID、存储期限；前端使用同一共享解析合同，保留签名 query。旧无签名 URL 不提供兼容回退。
- 独立 fresh-context 安全复核无发现，结论 `OK with notes`；明确是静态复核，不作为重启、代理链路证据。
- 已同步活文档与 YAML 合同，新增 TSS-017（签名篡改矩阵）、TSS-018（正确签名但过期）；总计 18 条 required，不代表全量通过。

### 本次签名专项运行

重新经过 planner 创建独立 Beta：`dvs-b81ca0` / `pool-01`，source root 与 revision 同上，构建包含新的签名实现。普通 Backend 认证仍开启；本轮没有启用阻塞中的 tunnel scope all，也没有改称 TSS-005 通过。未操作旧阻塞 Session 或其他人的资源。

- 正常创建返回显式签名链接；匿名 GET/HEAD 均 200，24 小时期限制值为 86400000ms。读取本隔离目录密钥进行独立 HMAC 计算，与真实返回签名一致；密钥长度 32、权限 0600，目录权限 0700。
- 15 组拒绝输入分别执行 GET/HEAD（30 个请求）均为 404：裸 ID、缺签名、缺期限、篡改签名、延长期限、跨快照替换、重复期限、重复签名、额外 query、交换字段顺序、非规范期限、旧 opaque URL、其他密钥签名、正确签名但与记录期限不一致、正确签名但已过期。均未返回正文或条件缓存 304。
- 针对 TSS-018 另创建独立真实记录，将 createdAt/expiresAt 整体移到过去并保持差值 24 小时，再以自有密钥签名；条件 GET/HEAD 均 404，随后清理该记录。这是隔离时间 fixture，不是实际等待 24 小时，也没有改变系统时钟或生产期限。
- signature 或完整 sharePath 作为 Backend bearer 调用终端列表均 401；对有效公开链接的 POST/PUT/DELETE 均 405。本隔离 Backend 日志扫描未发现测试签名、完整 URL 或密钥十六进制值。
- 从实际 Electron Terminal 菜单创建：通知复制成功，真实剪贴板与链接完全一致，包含 expires/signature，使用 HTTP Backend origin。
- 通过 `dev:open` 返回的 terminal-browser CDP 打开本次新建页面：64 行正文、无额外控件。选 25–28 行并刷新，返回 200，4 行高亮，签名 query 原样保留。
- 本次浏览器客户端已 detach；`dev:stop --session dvs-b81ca0` 返回 stopped，failure=null，slotProcessesAbsent=true，releasedLease=true。

证据：`/tmp/tss-signed-{static,evidence,expiry-evidence,status}.json` 与 `/tmp/tss-signed-stop.log`。签名和密钥不放入本文。仍未完成实际同 profile 重启验证、tunnel scope all 及先前其余完整验收项；本次不修改 Dev Session 健康探针或失败回收代码。

后续补齐剩余验收后再清理实施计划与本过程记录；长期合同保留在 `docs/cli/terminal-snapshot-share.md`。

## 用户批准的 Dev Session 修复与最终续验

本节更新前面历史阻塞结论：旧资源已回收，TSS-005 已通过；不代表快照全部 18 条用例通过。运行目录与 revision 仍同上，全部启动由无降级的 planner 选择 Beta。

### 修复及独立复核

- 健康检查及必要的登录/刷新只向身份已验证的回环 Backend 发送 profile 私有凭据；原始进程代际、确切监听地址、owner、lock 身份均校验，禁止重定向。`/health` 的 scope-all 保护未放宽。
- 独立审查曾发现错误监听者泄露凭据、转义 JSON 大小不一致、repair 与分配不互斥；父会话分别用隔离真实 HTTP/文件系统 fixture 确认并在修复后重跑。最终各轮复核通过。
- 实测又发现同端口但不同指定地址被误拒绝：局域网服务 `172.20.10.2:5003` 并不服务于回环目标。最终按确切 IP:port 检查，通配/无法证明的监听者仍拒绝；未停止无关服务。
- 启动前登记回收责任；Dev Session 失败恢复不重新启动 baseline Desktop/App Server。修复健康确认前过早删除旧备份、回滚后保存失效 previous 指针的问题。
- 显式旧产物修复要求已释放 Session 的回执、失败时间、源信息、App inode、恢复日志和全槽进程缺席等证明。修复与分配共用排他协议，未手工改 manifest、lease 或产物状态。

### 真实生命周期证据

- `dvs-2331cb / pool-04`：正式 `cleanup-stale` 成功，旧 App 退出、Session stopped、租约释放。其旧备份指针，以及失败 fixture `dvs-e05147 / pool-01` 的指针，经正式 `repair-retained-state` 分别修复；两槽恢复 healthy/idle。
- `dvs-1a8e9c / pool-04`：通过正式启动注入现有 `AUTH_ACCESS_TOKEN_TTL_SECONDS=0`，Backend 未就绪并自动回滚；回执记录全槽进程消失、租约释放，`failureReason=null`，没有 `retentionFailed`；池投影保持 healthy/idle，随后正式 stop。未捕获精确 TTL parser 错误栈，不把配置推断写成日志证据。
- 最终 `dvs-9acd13 / pool-01`：随机私有 tunnel token、scope all，真实 packaged 启动 ready；之后不携带原启动环境执行 status/open，全部服务 live、desktop resolver ready。Backend 为 `127.0.0.1:5003`，无需干预上述无关 LAN listener。
- 私有认证文件权限 0600、owner/token 匹配。正式 stop 返回 0；通过停止前保留的只读日志 FD 取得真实 `backend.shutdown.completed`（2026-09-18T17:51:03.894Z），停止后认证文件、Backend lock、App Server lock 均已移除。重复 stop 成功。此轮未做新的浏览器 UI 验收，resolver ready 不等于页面交互通过。

### TSS-005 最终 HTTP/WS 结果

在 `dvs-9acd13` 上重新执行真实 API/tmux/WebSocket 驱动：

- 匿名 health 401，正确 tunnel 凭据 200。
- 创建快照 201；匿名签名链接读取 200，不设置 Cookie。
- 无凭据、快照签名、完整分享 URL、正确 tunnel 加错误 Backend 凭据四组，对列表/input/interrupt/ticket 各 4 次均 401。
- 签名不能充当 WS ticket：无 tunnel 时升级 401；正确 tunnel 下连接仅收到 error 并以 1008 关闭。
- 正常列表/ticket 200、合法输入成功，未授权输入标记未进入终端；驱动清理自有终端。

本机证据：`/tmp/tss-endpoint-final-{start,status,open,stop,stop-again,pool}.log`、`/tmp/tss-endpoint-final-stop-evidence.json`、`/tmp/tss-devsession-tunnel-evidence.json`、`/tmp/tss-final-failure-{status,pool,stop}.log`、`/tmp/tss-repair-{01,04}-result.log`。最终 Backend 日志与 stop 输出未发现本轮 tunnel token；早先还扫描了 12 个本地日志/公开输出及进程 argv。均为限定范围扫描，不声称完整泄漏审计。

### 保留的限制

- claim/transition 排他要求所有并行控制进程遵守同一协议；旧版并行 allocator 不在保证范围。实际历史修复前检查未发现并行控制命令；没有新增持久化版本门禁。
- 中断留下的 transition guard 保守阻塞、不自动删除；OS 身份观察与连接也不是原子的 peer pinning。不宣称通用崩溃恢复或抵御恶意同 UID 文件替换。
- 同 profile 真正重启、字节/并发上限、代理前缀/Vite 链路、真实剪贴板拒绝等剩余快照验收仍未完成，前面的定向结果不升级为完整测试套件通过。
