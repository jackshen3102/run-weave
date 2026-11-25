# Agent 提问的 iPhone 接力实施计划

用户离开电脑后，iPhone 收到一条待答通知，点开即可回答原 Codex 任务的问题，并在原终端看到该轮继续。首版覆盖 Runweave 能识别的 macOS Codex Unix 共享执行服务，入口使用普通系统通知和现有「回复辅助」。产品交互以 [可视化方案](../prototypes/terminal-question-handoff/index.html) 为准，本计划用 iOS 模拟器验收首版。

## 核心流程

1. Codex 发出结构化问题。Backend 从已鉴权的 Hook 获取 terminal、panel、thread、turn、toolUseId，登记一次待核对事件并尽快返回。
2. Backend 后台接入原执行服务，只匹配同一线程、轮次和问题。收到仍有效的 `pending` 请求后建立短期定位记录，对同一手机安装最多发一条通知。预检查缺少身份或问题已结束时，本次事件就地结束。
3. iPhone 在后台收到普通系统通知。锁屏文案只显示「Codex 等你回答」和一般提示，完整问题与选项由登录后的 App 读取。
4. 点开后先切到通知归属的已保存电脑，再按定位记录找到原终端、面板及问题。当前仍待答就展示选项，已结束就显示「问题已结束」，连接不可用就显示「暂时无法核对」并提供重新检查。
5. 用户提交后沿现有接口写回原请求。收到可信的解决状态时显示「问题已处理」。验收另查原终端后续输出，证明是原轮次实际消费了测试选项。

源码基线 `c2cea2f2`。隔离运行使用 Codex 0.172.0 并显式启用默认模式的结构化提问，已看到 `PreToolUse` 与请求身份匹配、提问约 30 秒后可接回、电脑先答后旧提交被拒绝。当前 [问答服务](../../backend/src/terminal/questions/service.ts) 仍由读取入口创建连接，[通知协调器](../../packages/app-ios/Sources/RunweaveIOS/Services/NotificationCoordinator.swift) 目前只区分电脑与已有定时任务定位。第一版验收保持结构化提问的真实执行服务这一前提。

## 实施顺序

### 1. 后台发现与定位

- [ ] 从 [公共 Hook](../../packages/agent-bridge/hooks/runweave-hook-bridge.cjs) 和 [Backend 接收路由](../../backend/src/routes/terminal/completion.ts) 追到受认证的结构化提问入口，复用现有已核验的 Hook / terminal / panel 身份。仅在 Codex 的 `request_user_input` 具备线程、轮次和工具调用 ID 时进入本链路。Hook 确认接收后立即返回，由 Backend 后台有界等待请求发布。初次查询为空是允许的时序，建议等待上限 5 秒，之后结束本次发现。
- [ ] 在 [问答服务](../../backend/src/terminal/questions/service.ts) 与 [问答网关](../../backend/src/terminal/questions/gateway.ts) 复用已加载线程、原 socket 检查及请求状态。通知目标以 Backend 内部稳定身份为准，至少包括 host、terminal、panel、thread、turn、item。网关会话生成的 `requestId` 和 `generation` 只用于本次已连接的表单提交。允许连接重建后核对同一原始身份，身份改变时原定位进入结束状态。首版只处理提问来源仍是该终端当前面板的情况，沿用现有面板校验。后台发现不改变终端焦点或 tmux 面板选择。
- [ ] 在 Backend 问答领域增加短期定位记录。用稳定事件身份去重，生成不携带业务信息的 UUID `questionRef`，保存会话归属、原始身份、到期时间及投递资格。保存采用现有的持久化和领取方式，作用域固定在该 Backend。采用 15 分钟定位有效期，过期时给出明确结束提示，源服务的实际待答窗口仍是权威。重启或投递结果未知时沿用既有去重规则，状态未知的发送保留记录。
- [ ] 在 [问答路由](../../backend/src/routes/terminal/questions.ts) 增加已鉴权的 `GET /api/terminal/questions/notifications/:questionRef`。根据当前登录与安装的授权检查定位，再核对原面板和问题状态。返回 `pending` 及 terminal/panel 和现有问答 DTO，或返回 `closed`、`unavailable`。格式错误返回 400，未知或无权访问的引用统一返回 404。原提交接口继续按 panel、thread、turn、item、generation、operationId 校验和去重。同机已切换面板时，拒绝旧表单访问与提交；App 显示无法核对，并保留返回原终端的入口。

### 2. 普通通知与 iOS 跳转

- [ ] 在 [共享推送合同](../../packages/shared/src/push-notifications.ts) 增加 `terminal-question` 定位类型，`resourceId` 只带 `questionRef`。新增独立订阅 kind `terminal-question` 和投递 category `terminal.question`。在 [Backend 设备通知路由](../../backend/src/routes/device-notifications.ts) 和 [订阅实现](../../backend/src/device-monitor/subscriptions.ts) 加入 `questions=1` 能力协商，沿用已授权、已确认、仍登录的安装和相同 host。旧客户端沿用所声明的类别。
- [ ] 更新 Push Gateway 的[目标类型校验](../../packages/push-gateway/src/notifications.ts)与编码，检查 [投递去重](../../packages/push-gateway/src/delivery.ts) 和 [APNs payload](../../packages/push-gateway/src/apns.ts)。网关只转发经校验的短 ID，category 限定该目标类型。发送前再次确认资格与问题状态，重试使用相同事件 ID 和正文。现有电量、定时任务、未读、回复通知按原合同处理。部署先更新网关和 Backend，再让新客户端协商订阅。回滚时先关闭新类别投递，已有通知点击时按目标是否仍能核对给出状态。
- [ ] 在 [iOS 通知合同](../../packages/app-ios/Sources/RunweaveIOS/Contracts/DeviceNotification.swift)、[通知协调器](../../packages/app-ios/Sources/RunweaveIOS/Services/NotificationCoordinator.swift) 和 [问答模型](../../packages/app-ios/Sources/RunweaveIOS/State/TerminalQuestionsModel.swift) 消费新目标。复用现有连接切换和 [回复辅助](../../packages/app-ios/Sources/RunweaveIOS/Features/Terminal/CodexReplyAssistant.swift)。绑定原 Backend、terminal、panel 和问题身份，旧异步结果不能覆盖新页面。跳转后仍通过现有表单选择、显式提交和核对结果。
- [ ] 收到 `409 question_changed` 时回读该定位，显示已结束或暂不可核对。提交后断线时保留草稿并明确提示提交状态待核对，原操作 ID 继续参与去重。当前请求已结束、目标已更换或结果未知时隐藏重复提交入口。

## iOS 模拟器验收

使用本 Worktree 的 Debug 候选 App、独立测试 Backend 和一个真实、专用的 Codex 终端。可视化原型只用于检查交互设计。候选 App 通过 [agent-device](../../plugins/toolkit/skills/agent-device/SKILL.md) 真正操作系统通知和 SwiftUI 页面。后续修改业务代码时以 [TQ-009 至 TQ-014](../testing/app/ios-terminal-questions.testplan.yaml) 为验收门槛，已有问答场景保留 TQ-001 至 TQ-008。

从仓库根目录申请设备、构建安装、初始化交互会话。先设置 `AGENT_DEVICE_SKILL_DIR` 为当前已加载的 agent-device 技能目录。

```bash
set -o pipefail
task="$PWD/.runweave/mobile-qa/terminal-question-handoff-$(date +%Y%m%d-%H%M%S)"
lease_receipt="$(mktemp /tmp/runweave-question-handoff-lease.XXXXXX)"
node scripts/ios-simulators/cli.mjs start --app runweave --task-dir "$task" --json | tee "$lease_receipt"
udid="$(jq -er 'select(.ok == true) | .udid' "$lease_receipt")"
node packages/app-ios/scripts/ios.mjs run --task-dir "$task" --configuration Debug
python3 "$AGENT_DEVICE_SKILL_DIR/scripts/device.py" init "$task" --kind simulator --udid "$udid" --app com.runweave.app.native
python3 "$AGENT_DEVICE_SKILL_DIR/scripts/device.py" run "$task" -- open --foreground
```

- [ ] 在隔离测试环境捕获该次 Hook 经 Backend 生成并由候选 Push Gateway 编码的真实通知数据。保留原事件关联的 hostId、notificationId、category 和 target，去除设备 token、凭据和传输头。使用返回的 UDID 注入捕获的 JSON，只注入测试 Bundle ID。候选网关使用本地捕获传输。若模拟器拿不到 APNs 注册 token，在隔离 Backend 上用该模拟器的合法登录和安装身份，经正常注册及确认 API 建立测试订阅，token 使用仅供捕获传输使用的合成值。
- [ ] 将 App 切到后台，通过系统通知中心或横幅点该条通知。辅助入口保留真实 App 生命周期。记录原终端的 thread、turn、item 与候选路由命中，核对是否回了原问题。每条用例保存截图、原任务输出和不含凭据的关联记录。
- [ ] 模拟器通过条件为系统通知已呈现、点击跳转可用、选项与旧状态符合 YAML，各案例能用原任务或协议证据确认结果。模拟可证明系统注入至 App 导航这部分，Apple APNs 网络送达与真机系统策略属于另一层证据。

```bash
xcrun simctl push "$udid" com.runweave.app.native "$task/notification.apns"
node scripts/ios-simulators/cli.mjs finish --task-dir "$task" --json
```

任何 case 结束后先收集证据，整轮结束时执行 `finish` 释放同一设备租约。若使用 Dev Session，按 [Dev Session 生命周期技能](../../plugins/toolkit/skills/runweave-dev-session/SKILL.md) 绑定并验证当前 Worktree 的 Backend。

## 合并前门槛

- [ ] YAML 格式通过 `pnpm testplan:validate docs/testing/app/ios-terminal-questions.testplan.yaml`。文档入口通过 `pnpm docs:check`。
- [ ] 运行 `pnpm --filter @runweave/shared typecheck`、`pnpm --filter @runweave/backend typecheck`、`pnpm --filter @runweave/push-gateway typecheck` 及 `pnpm architecture:check`。公共 Hook 有变动时执行 `pnpm agents:build` 与 `pnpm toolkit:verify-hooks`。
- [ ] 以同一候选版本完成模拟器验收矩阵，记录构建身份、UDID、对应的通知和原请求。汇报保留三类证据的区别：原型操作、候选 App 模拟器和实际 APNs 真机。
