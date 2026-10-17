# iPhone 无线更新恢复

用于已授权的同一台 iPhone 更新中出现 `device_unavailable`、设备查询超时或构建后断线。
同一局域网不等于 Apple 无线调试通道当前可用；一次不可达也不证明不能通过 Wi-Fi 更新。
CUA 负责查看 Xcode 设备状态，安装仍使用仓库统一更新 CLI。

## 先读本轮证据

- 保留原硬件 UDID、configuration、team、已生成的 appPath、version、buildNumber 和 buildId。
- 先看 `error.phase`、`connectionFailure` 和对应 `doctor.json`、查询日志。`connectionFailure.reason`
  区分查询超时、查询失败、设备身份不符和 tunnel 未连接；`tunnelState` 是设备报告的原值。
- `device_unavailable` 后的 `pairing_unverified`、`developer_services_unavailable`、
  `lock_state_unknown` 可能是连接检查失败的连带结果，不能据此要求用户重新配对或修改 Developer Mode。
- 已安装或启动过时，先核对安装、启动回执和当前版本；身份无法确认时停止写操作，不能直接重装。

## 用 CUA 检查原手机

有可用 CUA 时主动执行，无需等用户再次指定。按当前 CUA 工具文档取得 Xcode，打开
Window → Devices and Simulators → Devices。每次操作后重新观察界面，按硬件 UDID 确认目标；
不能仅按名称选择，也不要操作另一台同名的 Ignored 设备。

| 实际状态                                          | 下一步                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Connected，且有网络连接标记                       | 立即重新运行统一更新命令，由新预检确认身份、锁屏、开发服务和占用；不能仅凭 Xcode 显示就绕过预检。                                      |
| Preparing                                         | 让 Xcode 完成准备，随后重新观察；准备中不等于已能安装。                                                                                |
| Disconnected / Browsing on the local area network | 保持原设备选中，观察是否恢复；只有明确需要手机操作时才提示用户解锁、确认 Wi-Fi。用户已确认同网时，继续检查调试连接，不重复要求换网络。 |
| 明确的信任、Developer Mode、锁屏或配对提示        | 说明具体提示，交给用户完成手机端操作；不取消配对、不重置网络、不更改 VPN、防火墙或开发安全设置。                                       |

一次恢复窗口最多 120 秒，通常间隔 15–30 秒观察；每次工具等待不超过 30 秒。
只在状态变化或新的查询证据支持时重试，避免对无变化状态反复截图或无限调用命令。
窗口内恢复到 Connected 后立即继续原更新；本轮更新中再次断线时沿用剩余恢复预算。
超时或确需用户操作时，报告最后观察到的具体状态、已完成阶段、保留产物和所需动作。
不要只返回笼统的“检查同一网络”，也不把插 USB 作为默认要求。

没有 CUA 时，说明当前工具限制，使用更新 CLI 重新查询原 UDID 并按同样时间预算观察。
CLI 与 Xcode 矛盾时保留两边证据，按 `connectionFailure.query` 检查具体失败查询，不把可见设备当作 CLI 预检已通过。

## 恢复后继续

在原工作区重新执行相同命令：

```bash
pnpm --silent ios:update --json
```

源码、签名和产物身份仍匹配时，CLI 自动复用已有版本和构建号；以 `build=reused` 和相同
buildId 为准，不手动递增、不删除产物、不用 Xcode 的 Add installed app 绕过统一安装校验。
若源码或产物已变化，让 CLI 按现有规则重新规划，不能强行安装旧包。

只有退出码 0、`state=updated`、`install=verified`、`launch=verified` 才报告更新成功。
同时记录 `transport=localNetwork`（若为无线）、更新前后版本和 buildId。
CUA 中 Xcode 的已安装 App 构建号可作为补充证据；不等于手机页面交互验收，`uiVerified` 继续如实报告。

打开 Xcode 后连接恢复，只能证明先后观察到的状态和后续结果，不能据此断言打开窗口修复了底层连接。
