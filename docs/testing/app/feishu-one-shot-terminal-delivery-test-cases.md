# 飞书一次性回复投递到 Terminal 测试用例

## 1. 范围

验证飞书企业自建应用发送 Runweave 完成通知、用户引用回复、本地 Bridge 通过现有 CLI 输入链路一次性投递，以及成功/失败回执、权限、绑定、幂等和迁移行为。

不验证 AI CLI 是否理解或完成用户回复，不等待新的 completion，不验证卡片、图片、文件、自由文本或云端中继。

## 2. 前提事实

- 通知源为 `electron/resources/hooks/runweave-hook-bridge.cjs` 和 `electron/resources/hooks/feishu_stop_notify.sh`。
- Terminal 投递权威入口为 `rw terminal send` 及后端 `POST /api/terminal/session/:id/input`。
- 成功只表示 Terminal Input 已被 backend 接受/入队，不表示 AI CLI 已完成。
- 飞书事件类型为 `im.message.receive_v1`，平台可能重复推送同一消息，因此以入站 `message_id` 去重。
- 测试环境需要飞书企业自建测试应用、测试群、允许用户 `open_id`、真实 Runweave backend 和 tmux-backed Terminal。

测试前配置独立目录，避免污染正式状态：

```bash
export RUNWEAVE_CONFIG_FILE="$(mktemp -d)/runweave-config.json"
export RUNWEAVE_BASE_URL="${RUNWEAVE_BASE_URL:-http://127.0.0.1:5001}"
export RUNWEAVE_FEISHU_STATE_DIR="$(mktemp -d)"
export RW_BIN="node packages/runweave-cli/dist/index.js"
```

敏感的 `FEISHU_APP_SECRET` 不得写入测试证据、终端 history 或日志摘录。

## 3. 用例设计方法

- 场景法：完成通知 → 引用回复 → CLI 接受 → 飞书回执主路径。
- 等价类：有效/空/非文本/超长回复，有效/无效引用，有权限/无权限用户。
- 判定表：sender、chat、reference、binding、TTL 和 terminal 状态共同决定是否投递。
- 状态迁移：未见事件 → processing → succeeded/failed；遗留 processing 不自动重投。
- 错误猜测：飞书重复推送、Bridge 重启、通知与 Bridge 并发写状态、后端不可达和凭据泄露。

## 4. 必跑门禁

按顺序执行，任一失败即停；这些命令仅是代码质量门禁，不能替代后续真实行为用例：

```bash
pnpm typecheck
pnpm lint
pnpm --filter @runweave/cli build
git diff --check
```

## 5. 通知与绑定

| ID     | 场景                                 | Given                                        | When                                                  | Then（可取证）                                                                                 | 失败判断                                                      |
| ------ | ------------------------------------ | -------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| FS-001 | 应用通知成功后建立 Terminal 绑定     | 测试应用、目标 chat 和运行中 Terminal 已配置 | 触发一次带明确 `terminalSessionId` 的 completion 通知 | 群中仅出现一条应用机器人通知；状态文件中对应飞书 `message_id` 绑定到该 Terminal，权限为 `0600` | 通知重复、无 binding、目标 ID 错误或文件权限更宽              |
| FS-002 | 飞书发送失败时不创建虚假绑定         | 将应用凭据替换为无效值，使用独立状态目录     | 触发 completion 通知                                  | notify 非 0；hook 主流程不失败；状态中无该通知 binding；日志只有脱敏错误分类                   | 写入不存在的 `message_id`、阻断 completion hook 或泄露 Secret |
| FS-003 | 缺少 Terminal 身份时不发送可回复通知 | completion payload 和环境均无 Terminal ID    | 触发通知                                              | 不发送应用通知；日志说明缺少 Terminal 身份且无敏感 payload                                     | 发出无法路由的通知或创建空 Terminal binding                   |
| FS-004 | 绑定过期后被清理                     | 使用 TTL 已过期的独立 fixture 状态           | 启动 Bridge 或执行下一次状态读写                      | 过期 binding 不再可查询，未过期 binding 保留                                                   | 过期 binding 仍有效或误删未过期项                             |
| FS-005 | 并发通知不会覆盖 binding             | 两个不同 Terminal 同时产生通知               | 并发执行两次 notify                                   | 状态中存在两个不同 `message_id` 的正确绑定                                                     | 只剩一条、Terminal 串绑或状态 JSON 损坏                       |

## 6. 一次性投递主路径

| ID     | 场景                              | Given                                             | When                                            | Then（可取证）                                                                                                | 失败判断                                                   |
| ------ | --------------------------------- | ------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| FS-006 | 有权限用户引用通知后只投递一次    | FS-001 类通知存在；允许用户；目标 Terminal 运行中 | 用户引用该通知回复唯一标记文本 `FS006-DELIVERY` | Terminal history 仅出现一次该标记；用户原消息出现 `DONE` 打钩 reaction 且无新增成功文本；幂等状态为 succeeded | 未投递、出现两次、新增成功文本、缺少打钩或状态非 succeeded |
| FS-007 | 投递成功后不等待终端回复          | 目标 Terminal 接受输入后执行一个持续任务          | 用户引用通知回复文本                            | `rw terminal send` 短确认完成后立即出现 `DONE` reaction；Bridge 可继续处理下一事件                            | 打钩等待持续任务结束、Bridge 阻塞或轮询 completion         |
| FS-008 | 带 panel 绑定时只投递到目标 panel | 同一 session 有两个 panel，binding 指定其中一个   | 用户引用通知回复唯一标记文本                    | 目标 panel history 出现一次标记，另一 panel 不出现                                                            | 投到默认/错误 panel 或两个 panel 都收到                    |
| FS-009 | 同一通知的两条不同回复各执行一次  | 同一有效通知与允许用户                            | 依次发送两条具有不同 `message_id` 的引用回复    | 两段文本各在目标 Terminal 出现一次，各有独立回执                                                              | 第二条因 binding 已使用被拒，或任一文本重复                |

## 7. 路由、输入与权限拒绝

| ID     | 场景                                 | Given                                                     | When                                            | Then（可取证）                                                                   | 失败判断                                      |
| ------ | ------------------------------------ | --------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| FS-010 | 非 allowlist 用户不能投递            | 有效通知 binding；发送者不在 allowlist                    | 未授权用户引用回复                              | Terminal history 无回复文本；Bridge 记录 unauthorized 分类，不泄露 Terminal 详情 | Terminal 收到输入或向未授权者泄露完整目标信息 |
| FS-011 | 未引用通知的普通消息不投递           | 允许用户和目标群存在                                      | 用户发送普通文本但不引用机器人通知              | Terminal history 无该文本；事件被 ignored                                        | 任意普通群消息进入 Terminal                   |
| FS-012 | 引用非绑定消息不投递                 | 允许用户引用群内普通消息或旧 Webhook 通知                 | 发送文本回复                                    | Terminal history无该文本；结果为 binding_not_found                               | 根据文本中的 Terminal ID 猜测路由或发生投递   |
| FS-013 | 不同 chat 不能复用 binding           | 将有效 parent `message_id` 置于不匹配 chat 的事件 fixture | 向 Bridge 注入事件                              | 不调用 Terminal Input；结果为 chat_mismatch                                      | 跨群投递成功                                  |
| FS-014 | 空文本不投递                         | 有效引用和允许用户                                        | 回复空白文本                                    | Terminal history无新增；收到或记录 invalid_input                                 | Terminal 收到空行                             |
| FS-015 | 非文本消息不投递                     | 有效引用和允许用户                                        | 回复图片或文件                                  | Terminal history无新增；收到或记录 unsupported_message_type                      | 文件路径、图片内容或占位符进入 Terminal       |
| FS-016 | 超过 Terminal Input 上限的文本不投递 | 有效引用和允许用户                                        | 回复超过共享 input 协议上限的文本               | Terminal 无新增；回执为输入过长，不截断后投递                                    | 文本被静默截断或后端收到部分内容              |
| FS-017 | 特殊字符按原文作为单个 line 输入     | 有效引用和允许用户                                        | 回复包含引号、反引号、`$()`、换行展示字符的文本 | Terminal 收到同一文本数据；Bridge 未通过 shell 执行其中内容                      | 本机出现额外 shell 副作用或文本被参数拆分     |
| FS-018 | 过期 binding 不投递                  | parent binding 已超过 TTL                                 | 用户引用回复                                    | Terminal 无新增；回执或日志为 binding_expired                                    | 过期通知仍能控制 Terminal                     |

## 8. 幂等、崩溃与恢复

| ID     | 场景                                  | Given                                                   | When                           | Then（可取证）                                         | 失败判断                         |
| ------ | ------------------------------------- | ------------------------------------------------------- | ------------------------------ | ------------------------------------------------------ | -------------------------------- |
| FS-019 | 同一飞书事件重复推送只投递一次        | 有效事件 fixture 的 `message_id` 固定                   | 连续向 Bridge 交付同一事件两次 | Terminal 标记只出现一次；第二次不调用 send，复用终态   | Terminal 出现两次标记            |
| FS-020 | Bridge 重启后不重投 succeeded 事件    | FS-006 已完成并落盘                                     | 重启 Bridge，再投递同一事件    | Terminal 无新增；读取持久化 succeeded 结果             | 重启清空去重状态导致重复输入     |
| FS-021 | 遗留 processing 状态不自动重投        | fixture 中事件处于 processing，无 succeeded/failed      | 重启 Bridge 并再次收到该事件   | Terminal 无输入；回执/日志提示状态未知并要求发送新回复 | 自动重投造成潜在重复输入         |
| FS-022 | notify 与 Bridge 并发写状态不损坏数据 | 一个 notify 写新 binding，同时 Bridge 写 processed 状态 | 并发执行两条操作               | JSON 可解析，binding 和 processed 项均存在             | 文件损坏、任一更新丢失或权限变化 |

## 9. Terminal 与依赖错误

| ID     | 场景                              | Given                                             | When             | Then（可取证）                                                         | 失败判断                                        |
| ------ | --------------------------------- | ------------------------------------------------- | ---------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| FS-023 | Terminal 不存在时明确失败         | binding 指向已删除 Terminal                       | 用户有效引用回复 | CLI 非 0；飞书回执为 Terminal 不存在；状态为 failed；不创建新 Terminal | 伪报成功、猜测其它 Terminal 或自动创建 Terminal |
| FS-024 | Terminal 已退出时明确失败         | binding 指向 exited session                       | 用户有效引用回复 | 无输入；回执为 Terminal 不可运行；状态为 failed                        | 伪报已投递                                      |
| FS-025 | Runweave backend 不可达时明确失败 | Bridge 在线但 backend 停止                        | 用户有效引用回复 | 回执为后端不可达；状态 failed；Bridge 仍保持飞书连接                   | 无回执、进程退出或无限重试同一 Terminal Input   |
| FS-026 | Runweave 登录失效时不绕过鉴权     | Bridge profile token 无效且不能 refresh           | 用户有效引用回复 | 回执为认证失败；不直接操作 tmux；状态 failed                           | 绕过 API 写 tmux 或泄露 token                   |
| FS-027 | 飞书回执发送失败不重投 Terminal   | Terminal send 已 succeeded，随后模拟飞书 API 失败 | 处理有效事件     | Terminal 仅收到一次；状态保持 succeeded 并记录 receipt_failed          | 因回执失败再次投递 Terminal                     |

## 10. 迁移与回归

| ID     | 场景                               | Given                                          | When                 | Then（可取证）                                                                    | 失败判断                                   |
| ------ | ---------------------------------- | ---------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------ |
| FS-028 | app transport 只发送应用通知       | `FEISHU_NOTIFY_TRANSPORT=app` 且两套凭据均存在 | 触发 completion      | 只有应用机器人一条通知，Webhook 群机器人无消息                                    | 两个机器人双发                             |
| FS-029 | webhook transport 保持旧单向通知   | `FEISHU_NOTIFY_TRANSPORT=webhook`              | 触发 completion      | 旧自定义机器人收到一条通知；不创建应用 message binding                            | 应用也发消息、旧通知失效或产生虚假 binding |
| FS-030 | transport 非法值快速失败且不双发   | transport 设置为未知值                         | 触发 completion      | 日志记录 invalid transport；两种机器人都不发送；hook 主流程不失败                 | 任一 transport 被隐式选中或阻断 completion |
| FS-031 | 原 completion 上报不受通知失败影响 | 飞书应用和 Webhook 均不可用                    | 触发真实 AI CLI Stop | `/internal/terminal-completion` 仍记录 completion event，前端 marker 链路不受影响 | 飞书失败导致 completion 丢失               |

## 11. 真实环境执行与证据

- 飞书行为：保存应用机器人通知、引用回复及结果回执的消息链接或截图；敏感字段打码。
- Terminal 行为：使用 `rw terminal history <id> --tail 100 --json` 保存唯一标记出现次数；不要用静态代码阅读替代。
- Bridge 行为：保存脱敏结构化日志，至少包含入站 `message_id` 短 ID、结果分类和 Terminal 短 ID。
- 进程恢复：保存 Bridge 重启前后 PID/启动状态以及重复事件未产生第二次 history 标记的证据。

## 12. 覆盖判断

- 主路径、输入等价类、权限、引用路由、错误态、重复事件、并发写、重启恢复和迁移回归：已覆盖。
- 异步晚到：回执失败不重投 Terminal 由 FS-027 覆盖。
- 多 panel 隔离：FS-008 覆盖；多 backend 不覆盖，第一期 Bridge 只绑定一个 `rw` profile。
- UI 浏览器路径：不覆盖，本功能无 Runweave Web UI 改动，因此不需要 Playwright。
- 桌面端 UI：不覆盖，本功能不新增 Electron 可视界面；真实进程托管以命令和日志取证。
- AI 后续回复/任务完成：明确非目标，不作为验收条件。

## 13. 通过标准

以下条件必须同时满足：

1. 必跑门禁全部通过。
2. FS-001 至 FS-031 全部通过，或因测试环境能力不可用而明确记录阻塞原因；安全、幂等和主路径用例不得豁免。
3. 有效回复按飞书入站 `message_id` 精确一次投递，成功口径只采用 CLI input accepted/enqueued。
4. 所有拒绝和错误路径均无 Terminal 输入副作用。
5. 日志、状态文件和测试证据不含 App Secret、Runweave token 或完整用户回复正文。
