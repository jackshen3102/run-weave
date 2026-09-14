# 真机预检、按需准备与批内会话复用方案

状态：实现已落地，正在完成真机验收。日期：2026-09-14。目标范围：Runweave 原生 iOS 本机真机执行工具。

下文保留实施前方案基线供验收核对；当前入口、缓存限制和操作合同以 [iOS README](../../packages/app-ios/README.md#真机操作与取证) 为准。

## 1. 结论与目标

推荐先保留 Xcode + devicectl + XCUITest，增加仓库内统一入口，实现“只读预检 → 按变化准备 → 一轮 XCTest 执行整批 → 逐例取证”。第一版优先复用构建产物和同一批执行内的自动化上下文；不把一次性 XCTest runner 当成已有常驻服务。

目标是减少重复构建检查、安装、自动化启动与人工等待，同时保证执行的是指定设备、指定 App 和当前代码。不能以使用旧包、保留错误页面、跳过断言换速度。

本方案不承诺减少系统密码要求的次数：可减少不必要的启动与等待，但尚无证据证明反复启动就是本机密码提示的原因。普通锁屏与 UI Automation 授权必须分开记录。Apple 工程师说明没有官方自动输入后者密码的方式；其历史答复不能用于预测当前系统的授权有效期。[Apple 开发者论坛](https://developer.apple.com/forums/thread/693273)

## 2. 已核查的代码现状

| 位置                                                   | 当前行为                                                                                         | 对方案的约束                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `packages/app-ios/scripts/ios.mjs:27`、`:56`           | 参数只支持模拟器与配置；doctor 检查工具链、runtimes、destinations                                | 保留模拟器原行为，新增独立 device 子命令                            |
| `.runweave/native-device-runner/build-app.py:4`、`:8`  | 每次调用 xcodebuild build，再显式 devicectl install；设备、Team、产物目录固定                    | 有重复准备入口；调用 build 不等于每次完整重编译，Xcode 可能增量命中 |
| `.runweave/native-device-runner/run.py:6`、`:9`、`:12` | 快照当前 UIProbe，始终 build-for-testing，再 test-without-building；名称决定证据文件名和部分超时 | 不存在按名称选择旧用例，也没有跨命令可附着的活会话                  |
| `.runweave/native-device-runner/UIProbe.swift:4`       | 当前是 `testLegacyPerformance`，激活 Safari 并输入测试文本                                       | 不能作为只读预检；迁移时不可原样当成默认 Runweave 用例              |
| `packages/app-ios/README.md:33`                        | 真机工具在忽略的本地目录，不随源码分发                                                           | 需要将无个人配置的执行器模板纳入仓库                                |
| `packages/app-ios/ios/RunweaveNative/Info.plist:23`    | 有 CFBundleVersion，本次未找到能证明完整代码输入版本的现成 build fingerprint                     | 不能仅凭 Bundle ID/营销版本或一份旧安装回执跳过安装                 |

本机只读核对得到 Xcode 26.6（17F113）。本机 devicectl 提供 `list devices`、`device info details/apps/processes/lockState`；其 help 要求自动化消费 `--json-output`，不解析展示表格。`details` 失败时可能返回历史最佳信息，因此列出设备不等于设备当前在线。

本次没有启动真机 App、执行当前 UIProbe、解锁设备或重启任何运行中的执行器。

## 3. 推荐用户流程与命令合同

以下为拟新增接口，当前不可执行；从 `packages/app-ios` 运行：

```bash
# 只读检查，不构建、不安装、不启动 XCTest
node scripts/ios.mjs device doctor --device <UDID> --json

# 显式选择套件；按需准备并执行整批
node scripts/ios.mjs device run --device <UDID> --suite <suite目录> --configuration Debug --json

# 查看本次运行结果，不能靠 status 延续或恢复一个已退出的 XCTest 会话
node scripts/ios.mjs device status --run <runId> --json
```

`--device` 必填，不默认选第一台手机；可以通过设备列表帮助用户选择。Team 从本机 Xcode 已有有效签名配置解析，歧义或缺失时要求显式本机参数，不把 Team、UDID 或私钥提交到仓库。第一版 device 执行只支持 Debug/Profile；Release 与 APNs 的原有发布路径不变。

`doctor` 输出分项状态，不能只返回一个笼统 ready：

```json
{
  "schemaVersion": 1,
  "state": "preflight_ok",
  "device": { "udid": "<明确目标>", "observedAt": "<本次时间>" },
  "checks": [
    { "id": "transport", "status": "pass", "source": "devicectl-json" },
    { "id": "unlocked", "status": "pass", "source": "lockState-json" },
    {
      "id": "ui_automation",
      "status": "unknown",
      "reason": "requires_active_probe"
    }
  ],
  "nextAction": "run_explicit_suite"
}
```

`preflight_ok` 只表示静态条件可继续；`automation_ready` 只能由本轮 XCTest 成功建立连接、读取目标 App 的新控件树证明。未实现或当前工具不可查询的状态必须 unknown；不能由 Enable UI Automation 开关、历史通过记录或进程存在推导授权有效。

错误统一带阶段、原因、证据路径和下一步：`device_unavailable`、`device_locked`、`device_busy`、`signing_unavailable`、`artifact_unverified`、`automation_authorization_required`、`automation_start_failed`、`case_failed`、`delivery_unknown`、`evidence_export_failed`。只有取得明确授权提示/错误证据才分类为 authorization_required；普通超时归 automation_start_failed，避免误诊。

退出码：0 表示 doctor 预检完成且无硬阻塞，或 run 全部通过；2 参数错误；3 环境阻塞/设备占用；4 业务断言失败；5 执行器或证据故障。doctor 的 0 不表示能立即操控 UI，必须结合 state/checks。

## 4. 分层预检与复用规则

### 4.1 只读预检：便宜、明确、不触碰业务

检查本机工具版本及可用 SDK、目标设备身份和当前连接、配对与开发条件、lockState、目标 App 安装元数据、runner 产物及签名状态、当前拥有者和套件物料。

所有设备信息来自本轮有超时的 JSON 查询；每项查询默认 10 秒，总预算 30 秒。超时返回阶段与 unknown/blocked，不靠猜测补齐。并行读取限于不改变设备状态的独立查询。

不读取私钥内容；不自动关闭锁屏、不重置配对、不重置权限、不清 Keychain、不启动历史 UIProbe。doctor 可写本机诊断报告，这不属于设备业务写入。

### 4.2 准备：只重做失效层

分别计算 App 和 runner 的构建输入摘要，记录工具版本、SDK、配置、有效 build settings、签名身份摘要、依赖锁、相关源文件与资源。必须包含 dirty/untracked 的参与构建文件和本地依赖输入；只记录 Git HEAD 不够。遇到无法完整描述的生成输入、脚本或依赖，交给 Xcode 做增量构建，不能宣称缓存命中。不得擅自跳过已有插件信任校验。

App 与套件/runner 使用不同摘要：只改测试逻辑不应触发 App 重新构建安装；App 源码变化必须使 App 缓存失效。产物目录使用构建身份区分，生成的 xctestrun 与 bundle 路径必须匹配，不能误用别的 worktree 的 DerivedData。

| 资源                 | 可复用条件                                                    | 失效处理                                                 |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| App 本机构建产物     | 输入摘要一致，产物存在且签名/内容校验通过                     | 增量构建并记录原因；不默认 clean                         |
| runner 编译产物      | 执行器、套件、工具链、签名输入一致，xctestrun 引用有效        | 仅重建 runner                                            |
| 手机上已安装 App     | 本批拥有安装及目标身份连续性；或获得足够强的当前产物身份验证  | 无法确认时重新安装本批目标包一次，不卸载；安装失败即停   |
| 自动化执行上下文     | 同一轮未退出的 XCTest，设备/目标/启动参数一致，刚通过主动检查 | 失效后中止或在业务开始前有限恢复；不把旧状态文件当活会话 |
| App 前台状态         | 当前 PID/状态合理且本例前置条件重新确认                       | 先 activate；确需冷启动才按用例规则 launch               |
| 控件引用、截图、坐标 | 仅用于当前页面状态下的观察                                    | 页面变化立即重新查询，不跨例复用元素对象                 |

第一版安装复用承诺以同一批为边界：批内不重复安装。跨批如果只能确认同 Bundle ID/版本号，仍视作产物身份未知，保守安装一次。后续若确有跨批安装耗时，再独立设计可验证 build identity；不要为了追求零安装放宽证据要求。

Apple 支持将 build-for-testing 与 test-without-building 分开，后者读取已有构建产物；这不是保持之前 XCTest 进程的接口。[Apple TN2339](https://developer.apple.com/library/archive/technotes/tn2339/_index.html)

### 4.3 主动就绪检查：嵌入同一次测试执行

执行器是仓库内独立、固定目标的 Swift XCTest UI runner，入口为 `testBatch`。它先建立自动化连接，对 `com.runweave.app.native` 做激活和新控件树读取，再按套件声明执行用例。这里的“无业务写入”允许激活 App；不自动登录、发消息、输入终端、购买或修改权限。

不能先启动一个 standalone smoke XCTest，结束后再为业务重新启动 XCTest。若用户只诊断环境，doctor 返回 automation unknown 即可；真正主动探测放进 run 的同一轮。

遇到系统授权提示时，先给一次明确提示并记录开始时间。在 Xcode 仍正常等待授权期间，保留同一进程等待最多 120 秒，用户处理后直接继续。若 Xcode 已退出，不伪装成继续该会话；下次调用重新核对环境，复用可信构建产物。等待期不循环重签/重装，不记录密码内容。

### 4.4 批内复用与用例隔离

同一 `testBatch` 内按显式列表顺序运行，使用 XCTContext activity 标记 case ID；每例开始检查前置条件，结束保存断言、树和截图。用例可复用 App 进程，但不能依赖未声明的上一例页面或业务结果。

套件提供明确的 case ID、目标 Bundle ID、前置导航/物料检查、执行函数及预期后置条件；可将现有 Swift UI 场景整理成函数集，由固定 runner 顺序调用。第一版不做任意动作解释器，不为每次点击生成/编译 Swift。被测行为是冷启动、登录、重启恢复时，允许显式要求本例重启，记录原因；不强迫所有 case 共用错误状态。

第一例断言失败立即停止业务；已通过的例子保留 pass，失败例为 fail，未执行例为 blocked。运行中崩溃或未知提交结果归 unknown，不能重复发起同一业务动作。保留尽可能完整的 xcresult 与附件；导出失败独立返回 evidence_export_failed，不能将其误报为业务断言失败。

## 5. 本机资源归属与状态合同

设备排他覆盖多个 worktree 的新入口，锁应位于统一用户级状态目录（例如 `~/.runweave/native-device/locks/<UDID>/`），而不是各自工作树。获得锁后再进入主动准备/执行；其他请求只读查看并返回 device_busy。

锁记录本轮 UUID、规范化 worktree、主机进程 PID 与启动身份、目标 UDID 和开始时间。操作系统原子创建；持有者活着不抢占。持有者死亡也不能直接抢锁：先确认它启动的子进程均已结束，身份不确定则 blocked。禁止全局 pkill xcodebuild，禁止杀其他测试或回收未知 runner。该锁不能阻止用户手动 Xcode 或旧脚本操作；检测到身份变化/冲突后应停止并要求协调，不宣称系统级独占。

运行日志与证据存放 `packages/app-ios/.build/ios/device/runs/<runId>/`，至少包含：

- `run.json`：设备/构建/套件身份、起止时间、阶段与最终结果。
- `events.jsonl`：阶段变化、准备动作及理由、人工等待、case 开始/完成。
- `result.xcresult`、附件目录与导出状态。

稳定缓存与运行证据分开，不用证据名称决定超时或选择套件。计数区分本工具主动请求的 App 构建/安装、runner 构建、XCTest 启动、App restart、以及 Xcode 自行产生的 runner 部署；后者不可观察时标记 unknown，不能承诺 Xcode 内部绝不部署。

状态主链：`checking → preparing → starting_automation → automation_ready → running → finished`；环境门禁进入 `blocked`，待用户授权进入 `waiting_for_user`，业务失败进入 `failed`，结果不足进入 `unknown`。状态文件用于审计，不能恢复已退出的执行器。只有本批业务还没开始、且确认本工具自己的旧子进程已退出时，允许一次自动化启动恢复；业务开始后默认不重放。

## 6. 文件与实施任务

| 文件（候选新增除现有入口外）                                | 职责                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/app-ios/scripts/ios.mjs`                          | 路由 device 子命令，保留现有模拟器命令                                                                         |
| `packages/app-ios/scripts/device/cli.mjs`                   | 参数、错误及 JSON/人类可读输出                                                                                 |
| `packages/app-ios/scripts/device/preflight.mjs`             | devicectl JSON 与工具/产物检查，不做业务动作                                                                   |
| `packages/app-ios/scripts/device/prepare.mjs`               | App/runner 独立缓存、构建与安装决策                                                                            |
| `packages/app-ios/scripts/device/run.mjs`                   | 锁、阶段、子进程、批执行和证据导出                                                                             |
| `packages/app-ios/scripts/device/runner/`                   | 去掉个人签名/设备配置的 Xcode UI runner 模板、固定 `BatchRunner.swift`；这是 UI 执行基础设施，不是新增单元测试 |
| `packages/app-ios/README.md`                                | 正式真机入口、doctor 的证据边界、旧工具迁移                                                                    |
| `docs/testing/app/ios-device-preflight-reuse.testplan.yaml` | 本方案的独立验收合同                                                                                           |

只在工具内部使用的 manifest/JSON 留在 iOS 工具目录，暂不增加 shared 跨运行时协议。未来若提供 Backend/App Server API，再单独把合同提升到 shared。

实施顺序：

1. 预检和诊断输出（约 1 人日）。先把设备锁屏、连接失败、签名缺失和自动化未知分开；只读入口先可用。
2. 工具归仓、独立构建身份和设备排他（约 1–2 人日）。沿用 Xcode 增量能力；保留旧脚本但不默认调用。
3. 单轮批执行、主动检查和附件归档（约 1–2 人日）。先迁移 3 个无外部提交的代表性场景，失败立即停。
4. 真机验收与对比（约 1 人日，需可用设备及授权窗口）。执行配套 YAML；记录所有阻塞，不用静态检查替代。

总计粗估 4–6 人日；前两天可先交付预检与准备可解释性。这比雷达中的 2–3 人日粗估更大，因为本次已经确认执行器未归仓、没有常驻会话、默认 Swift 场景还会随历史任务变化。工期不含常驻驱动、跨机器设备池或跨批产物证明能力。

兼容与回滚：旧模拟器入口和 Bundle ID/Keychain/UserDefaults 保留；新入口先显式调用，不替换旧本地脚本。回滚为停用新入口并保留本轮日志；只清理已确认无占用、属于本工具的缓存，不卸载 App、不删除用户登录状态或个人签名。

## 7. 验收与收益度量

配套验收计划：[真机预检与批内复用](../testing/app/ios-device-preflight-reuse.testplan.yaml)。所有用例是候选实现的验收标准，本次只完成编写和格式校验，不执行设备操作。

以同一真机、同一 App 构建、同一组 3 个场景比较逐次执行与批执行；设备、数据、用例、签名条件保持一致。先记录冷环境，再做两组各 3 轮稳定环境运行，逐轮展示数据，不将 3 次样本当作总体性能结论。

主要目标：

- 3 个 case 合成一批，正常路径本工具请求的 XCTest 启动次数从逐例 3 次变为 1 次；批内中途不重新 build-for-testing。
- 构建输入与产物可验证时，重复批执行不主动重建相同 runner；未变化的 App 不因更换套件而重新构建。
- 同批 App 主动安装最多 1 次；跨批产物无法确认时允许安装 1 次并解释原因。
- 健康 App 不被无理由重启；前置条件或用例要求重启时清楚记录，正确性优先。
- 锁屏/授权阻塞期间没有循环重装、重签；不发生重放业务动作、目标串用或旧包误验收。
- 每个 case 有独立状态与可关联的真实证据；人工等待、构建、安装、启动、业务执行、导出分别计时。

总耗时与人工等待的降幅不预设为已实现目标。需要先判断主要成本究竟在准备、授权、业务等待还是 Agent 思考；若准备只占很小部分，则不继续扩大常驻驱动投入。

本轮文档验证命令：

```bash
pnpm testplan:validate docs/testing/app/ios-device-preflight-reuse.testplan.yaml
pnpm docs:check
```

## 8. 下一阶段决策

第一版适合一次确定若干场景后连续执行。如果需求是 Agent 在相隔数分钟的多轮对话里随时点击、截图，批处理不等于交互会话复用。届时再单独评估常驻 XCUITest 命令通道或 WDA，并以本轮基线中的自动化重复启动成本证明投入必要性。

在第一版验收前，不引入 WDA/Lookin，不更改手机密码或自动锁屏，不修改个人 Agent 全局权限，也不承诺真机测试从此无人工授权。
