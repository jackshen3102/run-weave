# beta-resource-management（Beta 资源管理架构诊断）

Runweave Beta 固定资源池的可运行 HTML 架构说明。重点解释 Dev Session、slot lease、物理 Beta 实例、组件身份与清理器之间的关系，并用 2026-07-18 的真实现场说明资源为什么会“显示占用但已经部分失效”。

## 启动

```bash
python3 -m http.server 6194 --directory docs/architecture-flows/beta-resource-management
```

打开：

```text
http://127.0.0.1:6194/
```

## 核心结论

Beta pool 不是单一状态机，而是三套事实的组合：

1. **slot lease**：只回答“容量名额现在分配给谁”。
2. **Dev Session manifest**：回答“控制面认为生命周期走到哪里、应该拥有哪些服务”。
3. **runtime identity**：由进程签名、lock、health、Electron status 与 CDP 共同回答“现在真正运行的是谁”。

`allocatorPid` 是创建 lease 的启动 CLI PID，不是长期资源 owner。CLI 在启动完成后退出是正常行为，因此 `allocatorLive=false` 不能单独推导槽位失效。

当前主要管理缺口不是“缺少强制删除”，而是没有把上述三套事实合成一个清晰、可操作的资源池视图。系统为了避免误杀，在身份漂移时会拒绝释放 lease；这个安全选择是正确的，但如果恢复结论不可见、没有后续闭环，就会形成容量泄漏。

## 真实现场基线

- 时间：`2026-07-18 22:12 CST`
- 代码 revision：`b13d801027f66484409ab2963eda467a655b4e11`
- pool-01：idle；前一个 Session 已正常停止并释放 lease。
- pool-02：lease 占用，manifest 仍为 `ready`；Electron 与 Backend 记录 PID 已不存在，App Server PID 仍存活。
- pool-03：manifest 为 `stale`；记录 PID 已不存在，Backend lock 指向不存在的 PID，App Server lock 缺失，lease 仍保留。
- pool-04：manifest 为 `stale`；桌面 status、Backend lock、App Server lock 均缺失，但 lease 仍保留。
- pool-05：当前自测 Session `dvs-3d9fe4` 为 `ready`，Electron、Backend、App Server 与 CDP 身份一致。

现场会继续变化，因此 HTML 明确标记为时间点快照，不是实时控制台。

## 已确认问题

| 编号 | 结论                                                                                                                 | 证据等级                      |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| P1   | `allocatorLive` 容易被误读为资源健康，但 allocator 只是短命启动进程                                                  | 代码事实 + 当前 ready Session |
| P2   | manifest 可以保持 `ready`，而实际组件已经部分退出                                                                    | 当前 pool-02 现场             |
| P3   | 身份漂移时拒绝释放是正确的安全边界，但会保留 lease 并消耗容量                                                        | 代码事实 + pool-03/04         |
| P4   | janitor 的扫描与恢复摘要被 `runStart()` 丢弃，操作者看不到为什么某个槽位没有恢复                                     | 代码事实                      |
| P5   | capacity snapshot 只看 lease 文件，并明确标记 `authoritative: false`，无法表达 partial / reclaimable / manual states | 代码事实                      |

## 建议方向

第一步不是自动强杀，而是增加统一的只读资源投影：每个 slot 同时显示 lease、manifest、runtime、recovery 四组事实，并派生 `idle / healthy / partial / stale-reclaimable / stale-manual / broken` 状态。随后再把 janitor 结果和安全恢复入口接到这份投影上。

## 代码源

- `scripts/dev-session/cli.mjs`
- `scripts/dev-session/cli-stop.mjs`
- `scripts/dev-session/beta-slot-pool-core.mjs`
- `scripts/dev-session/beta-slot-pool-janitor.mjs`
- `scripts/dev-session/beta-slot-pool-storage.mjs`
- `scripts/dev-session/beta-service.mjs`
- `scripts/dev-session/service-runtime.mjs`
- `scripts/dev-session/registry.mjs`
- `scripts/runweave-beta.mjs`

## 边界

- 页面是架构诊断文档，不是 Runweave 产品 UI。
- 页面不执行启动、停止、清理或释放操作。
- 没有把身份漂移等同于可以安全删除；无法证明身份时仍应拒绝释放。
- 当前运行中的 pool-05 不受该页面影响。
