# System Monitor 架构边界

System Monitor 是 Runweave macOS Electron 客户端里的本机诊断面板，用来快速判断当前机器 CPU、内存、电池和高占用应用。它是只读看板，不是进程管理器。

## 当前能力

- 入口：Electron 菜单提供 `System Monitor`，快捷键为 `CmdOrCtrl+Shift+M`；前端路由为 `/system-monitor`。
- 总览：展示系统 CPU 总占用、内存使用、内存压力、Swap、电池电量、充电状态、剩余时间和放电速率。
- 列表：按应用聚合进程，默认展示 CPU 和内存 Top 结果，并支持按 CPU 或内存排序。
- 详情：展开应用后展示当前窗口内的进程 PID、进程名、CPU 和内存。
- 平台：只在 macOS Electron 客户端提供完整数据；非 Electron 或非 macOS 环境展示空态。

## 数据边界

数据来自 Electron 主进程本机采样：

- CPU：`os.cpus()` 两帧 delta。第一帧没有前序样本，返回 `totalPercent: null` 和 `warmingUp: true`。
- 内存：`os.totalmem()` / `os.freemem()`，并结合 `vm_stat` 估算 active、wired、compressed 等已用内存。
- 内存压力：`memory_pressure`，无法解析时返回 `unknown`。
- Swap：`sysctl vm.swapusage`。
- 进程：`ps -axo pid,ppid,pcpu,rss,command`，主进程解析后只返回 UI 需要的字段。
- 电池：`pmset -g batt` 与 `ioreg -r -n AppleSmartBattery`。

主进程把同一 `.app` 下的进程聚合为应用；非 `.app` 进程退化为可执行名聚合。`appKey` 使用哈希值，避免把本机完整 app 路径作为稳定标识暴露给前端。

## 隐私与安全

- System Monitor 只读，不提供 kill、quit、自动清理或系统级写操作。
- 不使用 `sudo`、`powermetrics` 或 native 私有能耗 API。
- 不返回完整命令行参数；前端展示的是截断后的进程显示名和聚合应用名。
- 采样结果只通过 Electron preload 暴露给当前 Runweave renderer，不写入后端项目数据，不同步到远端。

## 前端行为

`useSystemMonitor` 通过 `window.electronAPI.getSystemMonitorSnapshot()` 轮询主进程，默认刷新间隔为 5 秒，页面可切换 2 / 5 / 10 / 30 秒并可暂停。前端只保留当前 UI 需要的快照，不持久化历史。

## 非目标

- 不做长时间历史趋势、数据库或导出。
- 不做跨平台系统监控。
- 不做 GPU、磁盘 IO、网络流量或真实能耗排序。
- 不做自动终止进程、阈值告警或后台规则引擎。

## 验证入口

- `pnpm --filter ./electron test -- system-monitor.test.ts`
- `pnpm typecheck`

纯文档整理不要求运行这些重验证；功能改动时应按影响范围补充运行。
