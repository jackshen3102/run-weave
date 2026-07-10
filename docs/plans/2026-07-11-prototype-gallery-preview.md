# 多项目原型轮巡库实施计划

> 状态：已实施并验收。计划粒度：L2（共享协议、后端目录发现与静态资源、Terminal Sidecar UI、真实浏览器验收）。

## 结论

原型轮巡库直接集成到 Runweave Terminal 右侧 Sidecar，新增 `Prototypes` 工具：

```text
Runweave 已登记项目
        ↓
<project.path>/docs/prototypes/*
        ↓
┌────────────────────────┬──────────────────────────────────┐
│ 项目 A                  │ 当前原型 iframe                  │
│   prototype-1           │                                  │
│   prototype-2           │                                  │
│ 项目 B                  │                                  │
│   prototype-1           │                                  │
└────────────────────────┴──────────────────────────────────┘
```

不新增独立端口、全局配置文件或第二套项目注册表。只要项目已出现在 Runweave 项目列表中，并把原型放在该项目的 `docs/prototypes/<slug>/`，同一个入口就能发现和预览。

## 目标与成功标准

1. 展示全部 Runweave 已登记项目，并扫描每个项目的 `docs/prototypes` 一级目录。
2. 左侧按项目分组展示原型，右侧运行当前原型；项目或原型同名时仍按 `projectId + slug` 唯一定位。
3. `index.html`、相对 JS/CSS/JSON/图片资源在 iframe 中直接工作，不要求用户为每个项目启动静态服务。
4. 无 project path、无 `docs/prototypes`、目录不可读、无 `index.html` 都显示确定状态，不静默消失或白屏。
5. 选择在当前 Runweave 服务范围内持久化；切换工具、关闭再打开 Sidecar 后仍回到上次原型。
6. 原型脚本不能获得父页面同源权限；短期预览票据只能读取指定项目的指定原型，并拒绝路径逃逸。
7. 共享协议、前后端类型检查和 lint 通过，真实浏览器完成跨项目、同名隔离、选择恢复与 iframe 加载验证。

## 代码现状与约束

- 项目事实源是 `TerminalSessionManager.listProjects()`；`TerminalProjectRecord.path` 已表达每个项目的本地根路径。
- 原型约定已稳定为 `<project>/docs/prototypes/<slug>/index.html`，多数原型通过相对路径加载脚本和 mock 数据。
- 浏览器不能可靠地用 `file://` 运行 ES Module 和相对 `fetch()`，因此仍需要 HTTP 响应，但可以复用 Runweave 已运行的 backend，而不是新增端口。
- Terminal Sidecar 已有 `Preview`、`Browser`、`Agent Team` 工具，原型库属于并列的运行预览能力，不应塞进源码文件渲染分支。
- 本仓库不新增单元测试；行为验收使用真实 Chromium 和 `$playwright-cli`。

## 用户行为

### 入口

- Terminal 顶部 `...` 菜单提供 `Prototypes`，点击后直接打开右侧 Sidecar。
- Sidecar 顶部工具栏同时保留 `Preview`、`Prototypes`、`Browser`，存在 Agent Team 上下文时继续显示 `Agent Team`。
- `Prototypes` 不依赖当前 terminal session 的实时 `cwd`。

### 左侧项目和原型列表

- 项目顺序沿用 Runweave 项目列表，不另做排序或收藏。
- 每个项目扫描 `<project.path>/docs/prototypes` 的一级真实目录。
- 标题优先取 `index.html` 的 `<title>`，其次取 `README.md` 第一个 H1，最后回退到目录名。
- 文件摘要只包含原型根部普通文件；深层目录仍可作为预览资源访问，但不扩展成第二层列表。
- 项目无 path、无原型根目录或目录不可用时保留项目分组并显示状态。
- 原型没有 `index.html` 时仍显示，点击后列出一级文件并提示缺少运行入口。

### 右侧预览与选择

- 点击有入口的原型后，前端先申请 15 分钟短期票据，再把返回路径放入 `sandbox="allow-scripts"` 的 iframe。
- iframe 不授予 `allow-same-origin`，并使用 `referrerPolicy="no-referrer"`。
- 当前选择以 `{ projectId, slug }` 保存到按 `apiBase` 隔离的 localStorage key；列表刷新时优先恢复当前或已存选择，其次选择 active project 的首项，再回退到全局首项。
- “刷新原型库”重新扫描全部项目；“重新加载当前原型”重新签发票据并刷新 iframe。

## 后端接口与安全边界

### 鉴权 API

- `GET /api/terminal/prototype-gallery`
  - 返回全部已登记项目、项目状态和一级原型摘要。
- `POST /api/terminal/project/:id/prototype/:slug/preview-ticket`
  - 需要有效 access token。
  - 仅当该项目的该原型存在真实 `index.html` 时签发票据。
  - 票据资源固定为 `projectId + prototypeSlug`，有效期 15 分钟。

### 静态预览路由

- `GET|HEAD /prototype-preview/:ticket/:projectId/:prototypeSlug/*`
- URL 中保留票据、project id 和 slug，使 iframe 内相对资源请求天然携带同一资源范围。
- 只读取原型目录内真实普通文件；目录请求回退到该目录的 `index.html`。
- `realpath + path.relative` 同时约束 project root、prototype root、prototype dir 和最终文件，拒绝 `..` 与 symlink 逃逸。
- 非 `GET|HEAD` 返回 405；票据与 URL 资源不匹配返回 401。
- 响应设置 `Cache-Control: no-store`、`Access-Control-Allow-Origin: *`、`Cross-Origin-Resource-Policy: cross-origin`、`Referrer-Policy: no-referrer` 和 `X-Content-Type-Options: nosniff`。

## 改动范围

### 共享协议

- `packages/shared/src/terminal-protocol.ts`
  - 项目状态、原型摘要、gallery 响应和 preview ticket 响应类型。

### Backend

- `backend/src/terminal/prototype-gallery.ts`
  - 多项目发现、标题解析、入口检查和安全文件解析。
- `backend/src/routes/terminal-prototype-gallery-routes.ts`
  - gallery 与 ticket API。
- `backend/src/routes/prototype-preview.ts`
  - 带资源绑定票据的只读静态路由。
- `backend/src/auth/{jwt,service}.ts`
  - 新增 `prototype-preview` 临时 token 类型和资源字段。
- `backend/src/routes/terminal.ts`、`backend/src/index.ts`
  - 注册鉴权 API 和静态预览路由。

### Frontend

- `frontend/src/components/terminal/terminal-prototype-gallery.tsx`
  - 左右轮巡 UI、状态、选择持久化和 iframe。
- `frontend/src/services/terminal-prototype-gallery.ts`
  - gallery 和 ticket API client。
- `frontend/src/features/terminal/preview-store.ts`
  - 新增 `prototypes` Sidecar tool。
- `terminal-preview-panel*`、`terminal-workspace-header.tsx`
  - 挂载工具内容和菜单入口。
- `frontend/vite.config.ts`
  - Web 开发环境代理 `/prototype-preview` 到 backend。

### 文档

- 本计划。
- `docs/testing/prototype-gallery-preview-test-cases.md`。
- `docs/architecture/terminal-code-preview.md`。
- `docs/prototypes/README.md` 与 `docs/README.md` 索引。

## 验证步骤

1. 共享协议、backend、frontend 分别执行 typecheck 和 lint。
2. 执行 `pnpm build` 与 `git diff --check`。
3. 启动隔离的 Runweave 开发环境，登记至少两个都含 `docs/prototypes` 的项目，以及一个无 project path 的项目。
4. 通过 API 对照项目状态、原型数量、HTML/JS/JSON/图片 MIME、GET/HEAD、404/405、票据资源绑定和响应安全头。
5. 使用 `$playwright-cli` 从 Terminal 菜单打开 `Prototypes`，验证左右布局、跨项目点击、同 slug 隔离、iframe 内容、选择恢复和无关工具按钮隐藏。

详细验收见 `docs/testing/prototype-gallery-preview-test-cases.md`。

## 非目标

- 不增加独立 prototype server、固定端口或每个项目的启动脚本。
- 不自动扫描磁盘上的所有 Git 仓库；未登记到 Runweave 的项目不属于本工具作用域。
- 不做搜索、标签、收藏、缩略图、截图生成、编辑、发布或远程共享。
- 不修改、打包或代理原型引用的外部 CDN 依赖。
- 不递归把任意 HTML 文件都识别为独立原型；首版只认一级目录根部的 `index.html`。
- 不修改既有冻结原型内容。

## 风险与回退

- 扫描项目路径可能受 macOS 文件权限约束；该项目会显示“目录不可用”，不会让整个 gallery 失败。
- 票据在 URL 中短暂存在，因此有效期限制为 15 分钟，并由 `Referrer-Policy: no-referrer` 阻止向外部依赖发送引用地址。
- 依赖外部 CDN 的原型在离线时仍可能不完整，这是原型自身依赖，不伪装成本地加载成功。
- 回退时可以移除 `prototypes` Sidecar tool、两个路由注册和新增协议；现有 Preview、Browser、项目注册和原型目录均不需要迁移。
