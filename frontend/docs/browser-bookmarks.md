# 桌面浏览器收藏夹

Mac Electron 的 Terminal Browser 提供当前页星标、单行收藏栏、一级文件夹、手动排序、搜索管理侧栏及原生更多菜单入口。产品交互参考[历史原型](../../docs/prototypes/browser-bookmarks/README.md)，原型不是运行时能力证据。

## 数据归属

同一 Desktop userData 实例共用一份收藏，跨项目、Profile 与 Browser Group 可见。链接共享不共享网站 Cookie。Stable、Beta 和 Dev Session 使用各自的数据根；没有 Backend、云端或手机同步；首版不包含多层文件夹、导入导出、全局快捷键、独立管理页面或随记联动。

权威文件为 `desktopStateRoot()/terminal-browser-bookmarks.v1.json`，由主进程唯一写入，私有权限、临时文件 fsync 后 rename。收藏不是配置项，也不与标签页保存共用文件。首次没有文件时从空集合开始。

共享合同：[bookmarks.ts](../../packages/shared/src/browser/bookmarks.ts)。主进程入口：[handlers.ts](../../electron/src/browser/bookmarks/handlers.ts)，文件存储：[store.ts](../../electron/src/browser/bookmarks/store.ts)。前端状态：[store.ts](../src/features/terminal/bookmarks/store.ts)，交互：[use-bookmarks.ts](../src/components/terminal/browser/bookmarks/use-bookmarks.ts)。

## 保存与恢复

- 点击星标从主进程读取 Tab 的已提交 URL、标题和净化图标，不保存地址栏草稿；落盘成功后点亮星标。读取期间切换标签或 Profile 会放弃本次新增。
- URL 仅允许不含账号密码的 HTTP(S)，按 URL 序列化结果去重，保留 query/hash；标题 1–200 个 Unicode 标量，网址最多 8192 字节。
- 根级顺序和文件夹内部顺序明确保存，文件夹只允许一层。最多 5000 项、文件 16 MiB；超限整次拒绝，不截断旧内容。
- 每次修改携带 expectedRevision。旧版本返回冲突和最新快照，保留输入让用户核对，不自动覆盖或重放。
- 文件损坏、权限错误和未来 schema 都明确报错并保留文件，禁止以空集合覆盖。显式读取重试可在文件修复后恢复。
- 写入失败不更新内存 revision，不发送成功广播；IPC 结果未知时重新读取核对，不自动重放修改。
- 旧宿主缺少任一收藏 bridge 能力时隐藏入口，不使用 renderer localStorage 假装持久化。

旧客户端回退不会删除此独立文件，升级后继续读取。不要将原型 localStorage 导入产品收藏。

## 编辑与组织

收藏成功后可编辑名称、网址和位置；重复收藏同一 URL 进入原条目编辑。编辑中创建文件夹会保留草稿并预选新文件夹，位置和其他修改在“完成”时一起提交。Esc 取消未提交修改；文件夹选择器打开时 Esc 只关闭选择器。标签或 Profile 切换会关闭编辑，草稿不会写到新页面。取消编辑会保留已成功创建的空文件夹。

同层拖动改变手工顺序，链接可移入一级文件夹，通过编辑位置选择“收藏栏”移出。非空文件夹删除先显示子项数量并确认，文件夹和子项同次提交。栏宽变化仅将末尾项移入溢出菜单，不改变存储顺序；搜索匹配标题和网址、忽略大小写与两侧空格，显示所属文件夹并禁用重排。

## 导航与布局

打开收藏使用点击时的 Profile/标签组，默认复用当前标签；右键可在当前组新建标签。收藏不会保存网站登录态或收藏时的项目身份。

临时电脑本地预览暂不支持收藏。普通回环网址指向当前 Desktop 所在电脑；如果当前标签绑定了远端预览，则在当前组新建不带 source 的普通标签，避免复用旧绑定。不能保存连接 token 或内部隧道地址。

编辑使用公共 Dialog、Select；文件夹、溢出、右键菜单使用公共 Popover/ContextMenu。它们通过[浮层协调](overlay-coordination.md)让原生网页让位。收藏管理侧栏为布局面板，预留 320px 宽度，与批注、请求头、设备面板互斥；关闭不重载网页。

## 验证入口

```bash
pnpm --dir electron exec tsx ../scripts/verify/electron/browser-bookmarks.mjs
pnpm --dir electron exec tsx ../scripts/verify/electron/browser-bookmarks-ipc.mjs
```

第一条使用实际 store 与临时文件系统验证提交、冲突、损坏与容量边界。第二条启动一次性 Electron fixture，使用真实 IPC handlers、私有 writer 和实际前端 store 验证跨窗口广播、迟到读取与 sender 拒绝；仅替换 Desktop 身份配置以隔离生产配置，数据全部放在临时目录，不打包 fixture。fixture 会主动暴露测试子 frame bridge 以验证主进程拒绝，产品 preload 不开放该能力。

[交互用例](../../docs/testing/terminal/browser/bookmarks.testplan.yaml)与[数据完整性用例](../../docs/testing/terminal/browser/bookmarks-integrity.testplan.yaml)分别执行并记录实际 verdict。真实桌面验收通过 Dev Session 解析 desktop 和 terminal-browser surface，使用 Playwright CLI 操作；原生视图遮挡与菜单命中必须观察实际 Electron 合成窗口。类型检查和原型演示不替代这些证据。
