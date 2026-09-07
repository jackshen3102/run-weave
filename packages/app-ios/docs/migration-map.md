# 新旧客户端映射

[legacy-map.json](./legacy-map.json) 是唯一映射数据源，包含 21 个稳定 MAP ID。
所有路径相对于仓库根，Swift DTO 对照 `packages/shared/src/`，旧业务对照 `app/src/`。
`mapping:check` 检查路径、YAML case ID、基线 SHA 和旧源码/合同的 SHA-256。
源码改变会报 STALE；必须检查真实行为差异后手动更新哈希，脚本不会自动接受漂移。

状态含义：planned 是尚未完成整个功能；implemented 要求全部 native 路径存在；
verified 还要求 evidencePath 指向 JSON，其中 `cases[caseId]` 有 `verdict: pass`
和非空 `evidence` 引用。文件存在和构建通过都不构成功能验证。

排查时先固定 Backend、测试会话、字体和行列，再按 MAP 查旧入口、Swift 入口、合同及用例。
相同流的画面差异检查 renderer；恢复后差异检查 snapshot 与增量边界；切连接差异检查
generation 和缓存 scope。同一远端会话只允许一个客户端拥有输入/resize。

当前 21 项均已接入实现；没有映射标为 verified。完整运行验收仍在进行。

- MAP-11：手势按旧端区分本地历史和 tmux alternate-screen 滚轮，文字选择交由 SwiftTerm。
- MAP-16：旧端实际范围是 Files/Changes 图片预览。此前将“终端输出图片点击打开”列为缺口有误；
  旧 App 的 TerminalRenderer 未加载图片 addon 或图片打开扩展，不把新增能力混入 1:1 迁移。
- MAP-19：APIClient 拥有连接/endpoint 作用域内的预览缓存，15 秒有效期、30 分钟闲置回收，
  合并同键请求，手动刷新绕过缓存，登录/退出/切换连接清理；另设 32 MiB 内存上限。
- MAP-20：日志按连接标记，后台写入独立 App Support，最多 2,000 条 / 2 MiB；导出包含旧进程
  记录，清空只清理当前连接。读取损坏文件时保留原件并提示内存降级。

所有映射都指向实际 Swift 归属；不为对齐文件名创建空 Service/Store。
最新状态见 [实现收尾记录](../../../docs/review/2026-09-06-ios-native-completion-execution.md)。
