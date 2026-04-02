# 计划：Electron 客户端增加远程连接配置

## 摘要

将 Electron 客户端从"硬编码后端地址"改为"支持多后端连接管理"。在 Electron 环境下，用户可以添加、切换、删除后端连接配置（名称 + IP 地址），每次启动自动连接上次使用的后端；在 Web 模式下行为不变。

---

## 当前状态分析

### 前端 apiBase 流转

1. **源头**：`App.tsx:L8` — `const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ""`
2. **传播方式**：纯 prop-drilling，`API_BASE` 作为 `apiBase` prop 从 App → 页面 → 组件 → hooks/services 逐层传递
3. **底层使用**：`services/http.ts` 的 `buildUrl(apiBase, path)` 拼接请求地址；`features/viewer/url.ts` 的 `resolveApiBase()` 做 fallback（空值 → `VITE_PROXY_TARGET` → `window.location.origin`）

### Electron 主进程

- `main.ts:L18-19`：`BACKEND_URL` 从环境变量读取，fallback `http://localhost:5001`
- `setupCSP()` 将 `BACKEND_URL` 硬编码到 CSP 的 `connect-src` 里
- `preload.ts` 仅暴露 `{ platform, isElectron }`

### 关键观察

- `apiBase` 是一个**编译时/初始化时确定**的值，整个运行时不会变化
- 没有 React Context / 全局状态管理，全靠 prop-drilling
- localStorage 只用于 auth token 和记住密码，不存储连接配置

---

## 设计方案

### 核心思路

1. **前端**：将 `apiBase` 从常量改为 **React state**，由新增的连接管理逻辑提供。Electron 环境下从 localStorage 读取活跃连接；Web 环境下保持原有逻辑不变。
2. **Electron 主进程**：CSP 放宽 `connect-src` 允许动态连接多个后端；preload 增加连接配置 IPC 通道。
3. **连接配置页面**：新增一个 `/connections` 页面，显示连接列表（名称 + 地址），支持添加/编辑/删除/切换。仅在 `isElectron` 时显示。

### 数据模型

```typescript
interface ConnectionConfig {
  id: string; // crypto.randomUUID()
  name: string; // 用户自定义名称，如 "本地开发"、"生产服务器"
  url: string; // 后端地址，如 "http://192.168.1.100:5001"
  createdAt: number; // 创建时间戳
}

interface ConnectionStore {
  connections: ConnectionConfig[];
  activeId: string | null; // 当前选中的连接 ID
}
```

### 存储位置

- **localStorage** key = `"viewer.connections"` — 存储 `ConnectionStore` JSON
- 理由：和现有 auth token / remembered-credentials 存储方式一致

---

## 具体改动

### 1. 前端：新增连接管理 hook

**新建文件** `frontend/src/features/connection/use-connections.ts`

- `useConnections(storageKey)` hook，管理 ConnectionStore 的 CRUD
- 返回 `{ connections, activeConnection, addConnection, removeConnection, setActive, updateConnection }`
- 仅读写 localStorage，无 IPC 调用
- Web 模式下不使用此 hook

### 2. 前端：新增连接选择页面

**新建文件** `frontend/src/pages/connections-page.tsx`

- 展示连接列表（卡片式，每个卡片显示名称和地址）
- "添加连接"按钮 → 弹出表单（名称 + 后端地址），带地址可达性检测（`fetch(url + '/health')`）
- 点击已有连接 → 设为活跃 → 跳转登录/首页
- 编辑/删除按钮
- 路由：`/connections`

### 3. 前端：新增连接配置组件

**新建文件** `frontend/src/components/connection-page.tsx`

- 实际 UI 实现，与 `login-page.tsx` 同级
- 样式风格和 LoginPage 保持一致（圆角卡片、Tailwind utilities、`Button` 组件）

### 4. 前端：修改 App.tsx

- 引入 `useConnections` hook
- 检测 `window.electronAPI?.isElectron`
  - **Electron**：若无活跃连接 → 重定向到 `/connections`；有活跃连接 → `apiBase = activeConnection.url`
  - **Web**：保持原逻辑 `apiBase = import.meta.env.VITE_API_BASE_URL ?? ""`
- 新增 `/connections` 路由

### 5. 前端：首页增加"切换连接"入口

**修改文件** `frontend/src/pages/home/components/home-header.tsx`

- 仅 Electron 模式下显示，在 header 右侧添加当前连接名称 + "切换"按钮
- 点击跳转 `/connections`

### 6. Electron 主进程：放宽 CSP

**修改文件** `electron/src/main.ts`

- `setupCSP()` 中 `connect-src` 改为 `connect-src 'self' http://* https://* ws://* wss://*`
- 因为用户可以配置任意后端地址，CSP 不能再硬编码单一 BACKEND_URL
- 移除 `BACKEND_URL` 常量（不再需要）

### 7. Electron preload：增加 isElectron 标识（已有，无需改动）

当前 `preload.ts` 已暴露 `window.electronAPI.isElectron = true`，足够前端判断。

---

## 文件变更清单

| 类型 | 文件                                                  | 改动                                                          |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------- |
| 新建 | `frontend/src/features/connection/use-connections.ts` | 连接管理 hook                                                 |
| 新建 | `frontend/src/features/connection/types.ts`           | ConnectionConfig / ConnectionStore 类型                       |
| 新建 | `frontend/src/components/connection-page.tsx`         | 连接配置 UI 组件                                              |
| 新建 | `frontend/src/pages/connections-page.tsx`             | 连接页面路由适配                                              |
| 修改 | `frontend/src/App.tsx`                                | apiBase 改为 state，增加 /connections 路由，Electron 判断逻辑 |
| 修改 | `frontend/src/pages/home/components/home-header.tsx`  | Electron 下显示"切换连接"入口                                 |
| 修改 | `electron/src/main.ts`                                | 放宽 CSP connect-src，移除 BACKEND_URL 硬编码                 |

---

## 假设与决策

1. **存储在 localStorage 而非 Electron Store** — 保持和现有 auth token 一致的存储模式，避免引入新依赖
2. **不需要 IPC 通道** — 连接配置完全在渲染进程管理，主进程只需放宽 CSP
3. **连接切换时清除 auth token** — 不同后端的 token 不互通，切换连接时清除 token 强制重新登录
4. **Web 模式完全不受影响** — `window.electronAPI?.isElectron` 为 falsy 时走原有路径
5. **添加连接时做 `/health` 检测** — 用户体验更好，但不强制（允许离线添加）

---

## 验证步骤

1. **Web 模式**：`pnpm dev` → 确认行为完全不变，不显示连接管理相关 UI
2. **Electron 模式**：`pnpm dev:electron` → 首次启动跳转到连接配置页 → 添加 `http://localhost:5001` → 自动跳转登录页 → 登录后进入首页
3. **切换连接**：首页 header 点击"切换连接" → 回到连接列表 → 选择另一个连接 → token 被清除 → 重新登录
4. **持久化**：关闭 Electron → 重新打开 → 自动使用上次的活跃连接
5. **TypeScript**：`pnpm typecheck` 无新增错误
6. **Lint**：`pnpm lint` 无新增错误
