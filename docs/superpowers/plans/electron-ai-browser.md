# Electron AI 浏览器 — 技术架构文档

> 本文档描述在 Electron 应用中内嵌多 Tab 浏览器，并通过 CDP 代理层安全接入 AI（Claude）控制的完整架构方案。

---

## 一、整体架构

### 1.1 分层概览

```
┌─────────────────────────────────────────────────────────────┐
│                        用户 / Claude                         │
│                     自然语言指令输入                          │
└────────────────────────────┬────────────────────────────────┘
                             │ MCP tool_call
┌────────────────────────────▼────────────────────────────────┐
│                    @playwright/mcp                           │
│              MCP Server（SSE / stdio 协议）                  │
│         browser_click / browser_navigate / ...              │
└────────────────────────────┬────────────────────────────────┘
                             │ CDP WebSocket
┌────────────────────────────▼────────────────────────────────┐
│                    CDP Proxy Server                          │
│              你自己写的中间层（主进程内）                     │
│    • Target 白名单过滤   • 命令黑名单   • 参数校验            │
└────────┬────────────────────────────────────────────────────┘
         │ Electron debugger API（per-view 级别）
┌────────▼──────────────────────────────────────────────────┐
│                    TabManager                              │
│         WebContentsView A  (aiAllowed: true)  ✅          │
│         WebContentsView B  (aiAllowed: true)  ✅          │
│         主窗口 Renderer    (aiAllowed: false) ❌ 永不暴露  │
└───────────────────────────────────────────────────────────┘
         │ IPC (ipcMain / ipcRenderer)
┌────────▼──────────────────────────────────────────────────┐
│                  React 前端（Renderer）                    │
│   <TabBar />  <BrowserArea />  <AIPanel />  <StatusBar /> │
└───────────────────────────────────────────────────────────┘
```

### 1.2 核心设计原则

- **AI 永远不直接碰原始 CDP 端口**，只通过 MCP Tools 间接操作。
- **CDP Proxy 是唯一安全边界**，主窗口对 AI 来说根本不存在。
- **`webContents.debugger` 是 per-view 级别的**，天然隔离各 Tab 和主进程。
- **不开全局 `remote-debugging-port`**，杜绝 AI 通过端口直接枚举所有 Target。

---

## 二、技术选型

| 层次        | 技术                             | 说明                                    |
| ----------- | -------------------------------- | --------------------------------------- |
| 浏览器容器  | Electron `WebContentsView`       | Electron 28+ 官方推荐，替代 BrowserView |
| AI 控制协议 | `@playwright/mcp`                | Playwright 官方 MCP Server，工具链最全  |
| CDP 代理    | 自研 WebSocket Server（`ws` 库） | 核心安全层，过滤 Target 和危险命令      |
| 前端框架    | React 18 + Tailwind CSS          | Tab UI / AI 面板                        |
| 状态管理    | Zustand                          | 轻量，与 Electron IPC 配合简洁          |
| IPC 桥      | contextBridge（preload.js）      | 安全暴露主进程能力                      |
| 动画        | Framer Motion                    | Action Queue 状态切换                   |
| 长列表      | @tanstack/react-virtual          | CDP 日志条目虚拟化                      |

---

## 三、核心模块实现

### 3.1 TabManager

负责 WebContentsView 的生命周期管理，是 AI 可控 Tab 的唯一入口。

```js
// main/tabManager.js
import { WebContentsView } from "electron";
import crypto from "crypto";

class TabManager {
  constructor() {
    this.tabs = new Map(); // tabId → TabEntry
    this.win = null; // 主窗口引用，由外部注入
  }

  setWindow(win) {
    this.win = win;
  }

  // 创建新 Tab
  // aiAllowed 默认 false，需要显式开启
  createTab({ url = "about:blank", aiAllowed = false } = {}) {
    const tabId = crypto.randomUUID();
    const view = new WebContentsView();

    view.webContents.loadURL(url);
    this.win.contentView.addChildView(view);
    this._layoutView(view);

    const entry = {
      id: tabId,
      view,
      aiAllowed,
      debuggerAttached: false,
      status: "loading", // loading | ready | error
    };

    this.tabs.set(tabId, entry);

    // 只对 aiAllowed Tab 附加 debugger
    if (aiAllowed) this._attachDebugger(tabId);

    // 通知 React 前端
    this.win.webContents.send("tab:created", {
      tabId,
      url,
      aiAllowed,
      title: "",
    });

    return tabId;
  }

  closeTab(tabId) {
    const entry = this.tabs.get(tabId);
    if (!entry) return;

    if (entry.debuggerAttached) {
      try {
        entry.view.webContents.debugger.detach();
      } catch {}
    }

    this.win.contentView.removeChildView(entry.view);
    entry.view.webContents.close();
    this.tabs.delete(tabId);

    this.win.webContents.send("tab:closed", { tabId });
  }

  switchTab(tabId) {
    this.tabs.forEach((entry, id) => {
      entry.view.setVisible(id === tabId);
    });
    this.win.webContents.send("tab:switched", { tabId });
  }

  // 只返回 AI 可控的 Tab（用于 /json/list 端点）
  getAITabs() {
    return [...this.tabs.values()].filter((t) => t.aiAllowed);
  }

  _attachDebugger(tabId) {
    const entry = this.tabs.get(tabId);
    try {
      entry.view.webContents.debugger.attach("1.3");
      entry.debuggerAttached = true;
    } catch (e) {
      console.error(
        `[TabManager] debugger attach failed for ${tabId}:`,
        e.message,
      );
    }
  }

  _layoutView(view) {
    const bounds = this.win.getBounds();
    // 预留 Tab Bar（40px）+ 地址栏（44px）+ 标题栏（32px）
    view.setBounds({
      x: 0,
      y: 116,
      width: bounds.width,
      height: bounds.height - 116,
    });
  }
}

export const tabManager = new TabManager();
```

---

### 3.2 CDP Proxy Server

这是整个方案的核心安全层，实现了一个标准 Chrome DevTools Protocol WebSocket 服务端。

#### 3.2.1 HTTP 端点（Playwright MCP 启动时探测）

```js
// main/cdpProxy.js
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { tabManager } from "./tabManager.js";
import { CDPBridge } from "./cdpBridge.js";

export function startCDPProxy(port = 9229) {
  const http = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");

    // Playwright MCP 启动时会先请求这两个端点
    if (req.url === "/json/version") {
      res.end(
        JSON.stringify({
          Browser: "Electron/CDP-Proxy/1.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://localhost:${port}`,
        }),
      );
      return;
    }

    if (req.url === "/json" || req.url === "/json/list") {
      // 核心：只返回 aiAllowed 的 Tab，主窗口永远不在这里
      const targets = tabManager.getAITabs().map((tab) => ({
        id: tab.id,
        type: "page",
        title: tab.view.webContents.getTitle(),
        url: tab.view.webContents.getURL(),
        webSocketDebuggerUrl: `ws://localhost:${port}/tab/${tab.id}`,
      }));
      res.end(JSON.stringify(targets));
      return;
    }

    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });

  wss.on("connection", (clientWs, req) => {
    const tabId = req.url?.split("/tab/")[1];
    const tab = tabManager.tabs.get(tabId);

    if (!tab || !tab.aiAllowed) {
      clientWs.close(1008, "Target not found or not AI-controllable");
      return;
    }

    const bridge = new CDPBridge(tab, clientWs, tabManager);
    bridge.connect();
  });

  http.listen(port, () =>
    console.log(`[CDP Proxy] Listening on http://localhost:${port}`),
  );
}
```

#### 3.2.2 CDPBridge — 双向转发 + 命令过滤

```js
// main/cdpBridge.js

// ── 永久封锁的命令 ──────────────────────────────────────────
const BLOCKED = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.setDownloadBehavior", // 禁止修改下载路径
  "Target.setDiscoverTargets", // 防止 AI 主动枚举所有 Target
  "Target.setRemoteLocations",
  "Network.clearBrowserCookies", // 影响全局 Session
  "Network.clearBrowserCache",
  "Storage.clearDataForOrigin", // 防止清掉登录态
  "Security.setIgnoreCertificateErrors",
  "SystemInfo.getProcessInfo",
  "Debugger.enable", // 防止 AI 调试自身
  "HeapProfiler.enable",
  "Profiler.enable",
]);

// ── URL 协议黑名单 ──────────────────────────────────────────
const BLOCKED_PROTOCOLS = new Set([
  "file:",
  "chrome:",
  "devtools:",
  "javascript:",
]);

// ── 危险快捷键掩码 ──────────────────────────────────────────
const CTRL = 2;
const ALT = 1;
const DANGEROUS_KEYS = [
  { mod: CTRL, key: "w" }, // 关闭窗口
  { mod: CTRL, key: "r" }, // 刷新（主进程）
  { mod: CTRL, key: "F4" },
  { mod: ALT, key: "F4" }, // 关闭应用
];

export class CDPBridge {
  constructor(tab, clientWs, tabManager) {
    this.tab = tab;
    this.clientWs = clientWs;
    this.tabManager = tabManager;
  }

  connect() {
    const dbg = this.tab.view.webContents.debugger;

    // Electron → Playwright MCP（CDP 事件推送）
    dbg.on("message", (_, method, params) => {
      this._send({ method, params });
    });

    // Playwright MCP → Electron（命令接收）
    this.clientWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      await this._handleCommand(msg);
    });

    this.clientWs.on("close", () => {
      // 断开时保留 Tab 状态，不 detach debugger
      console.log(`[CDPBridge] Client disconnected from tab ${this.tab.id}`);
    });
  }

  async _handleCommand(msg) {
    const { id, method, params = {} } = msg;

    try {
      // ① 永久封锁
      if (BLOCKED.has(method)) {
        return this._error(id, `Command "${method}" is blocked by CDP Proxy`);
      }

      // ② Target 相关命令 — 拦截后交 Electron 处理
      if (method.startsWith("Target.")) {
        return await this._handleTarget(id, method, params);
      }

      // ③ URL 协议过滤
      if (
        (method === "Page.navigate" || method === "Page.setContent") &&
        params.url
      ) {
        const proto = new URL(params.url).protocol;
        if (BLOCKED_PROTOCOLS.has(proto)) {
          return this._error(id, `Protocol "${proto}" is not allowed`);
        }
      }

      // ④ 危险快捷键过滤
      if (method === "Input.dispatchKeyEvent") {
        const { modifiers, key } = params;
        const isDangerous = DANGEROUS_KEYS.some(
          (k) => modifiers & k.mod && key === k.key,
        );
        if (isDangerous) {
          // 静默丢弃，不报错
          return this._send({ id, result: {} });
        }
      }

      // ⑤ Runtime.evaluate — 关键词过滤
      if (
        method === "Runtime.evaluate" ||
        method === "Runtime.callFunctionOn"
      ) {
        const code = params.expression || params.functionDeclaration || "";
        const FORBIDDEN = [
          "require(",
          "process.",
          "__dirname",
          "__filename",
          "ipcRenderer",
          "ipcMain",
          "shell.",
          "remote.",
          "electron",
        ];
        if (FORBIDDEN.some((kw) => code.includes(kw))) {
          return this._error(id, "Expression contains forbidden keywords");
        }
      }

      // ⑥ 截图限流：强制降质量，防止高频大图打爆内存
      if (method === "Page.captureScreenshot") {
        params.format = "webp";
        params.quality = Math.min(params.quality ?? 80, 60);
      }

      // ⑦ 通过所有检查，透传给真实 debugger
      const result = await this.tab.view.webContents.debugger.sendCommand(
        method,
        params,
      );
      this._send({ id, result });
    } catch (e) {
      this._error(id, e.message);
    }
  }

  // ── Target 命令处理 ──────────────────────────────────────
  async _handleTarget(id, method, params) {
    switch (method) {
      case "Target.getTargets": {
        // 只返回 AI 可控的 Tab
        const targets = this.tabManager.getAITabs().map((tab) => ({
          targetId: tab.id,
          type: "page",
          title: tab.view.webContents.getTitle(),
          url: tab.view.webContents.getURL(),
          attached: true,
        }));
        return this._send({ id, result: { targetInfos: targets } });
      }

      case "Target.createTarget": {
        const url = params?.url || "about:blank";
        const newTabId = this.tabManager.createTab({ aiAllowed: true, url });

        // 推送 targetCreated 事件，模拟真实浏览器行为
        this._send({
          method: "Target.targetCreated",
          params: {
            targetInfo: {
              targetId: newTabId,
              type: "page",
              title: "",
              url,
              attached: false,
            },
          },
        });

        return this._send({ id, result: { targetId: newTabId } });
      }

      case "Target.attachToTarget": {
        const { targetId } = params;
        const tab = this.tabManager.tabs.get(targetId);

        if (!tab || !tab.aiAllowed) {
          return this._error(id, "Target not allowed");
        }
        // sessionId 用 tabId 本身，保持简单
        return this._send({ id, result: { sessionId: targetId } });
      }

      case "Target.closeTarget": {
        const { targetId } = params;
        const tab = this.tabManager.tabs.get(targetId);

        if (!tab || !tab.aiAllowed) {
          return this._error(id, "Target not allowed");
        }
        this.tabManager.closeTab(targetId);
        return this._send({ id, result: { success: true } });
      }

      case "Target.activateTarget": {
        const { targetId } = params;
        const tab = this.tabManager.tabs.get(targetId);

        if (!tab || !tab.aiAllowed) {
          return this._error(id, "Target not allowed");
        }
        this.tabManager.switchTab(targetId);
        return this._send({ id, result: {} });
      }

      default:
        return this._error(id, `Target command "${method}" is not supported`);
    }
  }

  _send(data) {
    this.clientWs.send(JSON.stringify(data));
  }
  _error(id, msg) {
    this._send({ id, error: { message: msg } });
  }
}
```

---

### 3.3 主进程启动流程

```js
// main/index.js
import { app, BrowserWindow } from "electron";
import { tabManager } from "./tabManager.js";
import { startCDPProxy } from "./cdpProxy.js";
import { spawn } from "child_process";

app.whenReady().then(async () => {
  // 1. 不开全局端口 — 删掉这行
  // app.commandLine.appendSwitch('remote-debugging-port', '9222');

  // 2. 创建主窗口
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tabManager.setWindow(win);
  win.loadFile("index.html");

  // 3. 启动 CDP 代理（只监听 aiAllowed Tab）
  startCDPProxy(9229);

  // 4. 拉起 @playwright/mcp，指向代理而非真实端口
  const mcp = spawn(
    "npx",
    [
      "@playwright/mcp",
      "--cdp-endpoint",
      "http://localhost:9229",
      "--port",
      "3000", // Claude 连接的 MCP SSE 端口
    ],
    { stdio: "pipe" },
  );

  mcp.stdout.on("data", (d) => console.log("[MCP]", d.toString().trim()));
  mcp.stderr.on("data", (d) => console.error("[MCP ERR]", d.toString().trim()));
  app.on("before-quit", () => mcp.kill());

  // 5. 默认创建一个 AI 可控 Tab
  tabManager.createTab({ url: "https://google.com", aiAllowed: true });
});
```

---

### 3.4 Preload Bridge

```js
// main/preload.js
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ipc", {
  on: (ch, fn) => ipcRenderer.on(ch, (_, ...args) => fn(...args)),
  off: (ch, fn) => ipcRenderer.removeListener(ch, fn),
  invoke: (ch, data) => ipcRenderer.invoke(ch, data),
  send: (ch, data) => ipcRenderer.send(ch, data),
});
```

---

### 3.5 React 状态管理（Zustand）

```js
// renderer/store/agentStore.js
import { create } from "zustand";

export const useAgentStore = create((set, get) => ({
  tabs: [],
  activeTabId: null,
  actions: [], // Action Queue
  cdpLogs: [], // CDP 日志流
  chatMessages: [],
  agentStatus: "idle", // idle | running | error

  initListeners() {
    window.ipc.on("tab:created", (tab) =>
      set((s) => ({ tabs: [...s.tabs, tab] })),
    );
    window.ipc.on("tab:closed", ({ tabId }) =>
      set((s) => ({ tabs: s.tabs.filter((t) => t.tabId !== tabId) })),
    );
    window.ipc.on("tab:switched", ({ tabId }) => set({ activeTabId: tabId }));
    window.ipc.on("tab:update", (patch) =>
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.tabId === patch.tabId ? { ...t, ...patch } : t,
        ),
      })),
    );
    window.ipc.on("cdp:log", (log) =>
      // 只保留最近 200 条，防止内存泄漏
      set((s) => ({ cdpLogs: [...s.cdpLogs.slice(-199), log] })),
    );
    window.ipc.on("queue:update", ({ id, status, result }) =>
      set((s) => ({
        actions: s.actions.map((a) =>
          a.id === id ? { ...a, status, result } : a,
        ),
      })),
    );
  },

  async runAgent(prompt) {
    set({ agentStatus: "running" });
    try {
      await window.ipc.invoke("agent:run", { prompt });
      set({ agentStatus: "idle" });
    } catch (e) {
      set({ agentStatus: "error" });
    }
  },
}));
```

---

## 四、命令处理分类总表

### 4.1 分类规则

| 类型           | 说明                                         |
| -------------- | -------------------------------------------- |
| ① 拦截自己处理 | 命令涉及 Electron 主进程逻辑（Tab 生命周期） |
| ② 直接转发     | 安全，无副作用                               |
| ③ 加工后转发   | 需要参数校验或结果过滤                       |
| ④ 永久 Block   | 危及主进程或全局状态                         |

### 4.2 完整命令清单

**Tab 生命周期（全部拦截）**

| 命令                        | 类型 | 说明                                       |
| --------------------------- | ---- | ------------------------------------------ |
| `Target.createTarget`       | ①    | 转 `tabManager.createTab()`                |
| `Target.closeTarget`        | ①    | 转 `tabManager.closeTab()`，校验 aiAllowed |
| `Target.attachToTarget`     | ①    | 返回伪造 sessionId                         |
| `Target.activateTarget`     | ①    | 转 `tabManager.switchTab()`，同步 UI       |
| `Target.getTargets`         | ①    | 只返回 aiAllowed Tab                       |
| `Target.setDiscoverTargets` | ④    | 防止 AI 主动枚举所有 Target                |

**页面导航**

| 命令               | 类型 | 说明                                     |
| ------------------ | ---- | ---------------------------------------- |
| `Page.navigate`    | ③    | 过滤 `file://` `chrome://` `devtools://` |
| `Page.reload`      | ②    | 安全                                     |
| `Page.goBack`      | ②    | 安全                                     |
| `Page.goForward`   | ②    | 安全                                     |
| `Page.stopLoading` | ②    | 安全                                     |
| `Page.setContent`  | ③    | 允许，记录日志                           |

**截图**

| 命令                     | 类型 | 说明                             |
| ------------------------ | ---- | -------------------------------- |
| `Page.captureScreenshot` | ③    | 强制 webp + 限制质量，防高频大图 |
| `Page.printToPDF`        | ③    | 允许，禁止写入本地文件系统       |
| `Page.captureSnapshot`   | ②    | 安全                             |

**点击 / 输入**

| 命令                       | 类型 | 说明                             |
| -------------------------- | ---- | -------------------------------- |
| `Input.dispatchMouseEvent` | ②    | 安全，坐标限定在 webview 内      |
| `Input.dispatchKeyEvent`   | ③    | 过滤 Ctrl+W / Ctrl+R / Alt+F4 等 |
| `Input.dispatchTouchEvent` | ②    | 安全                             |
| `Input.insertText`         | ②    | 安全                             |

**JS 执行（最危险）**

| 命令                     | 类型 | 说明                                      |
| ------------------------ | ---- | ----------------------------------------- |
| `Runtime.evaluate`       | ③    | 过滤 `require` `process` `ipcRenderer` 等 |
| `Runtime.callFunctionOn` | ③    | 同上                                      |
| `Runtime.getProperties`  | ②    | 安全                                      |

**网络 / Cookie**

| 命令                          | 类型 | 说明                |
| ----------------------------- | ---- | ------------------- |
| `Fetch.enable`                | ③    | 默认关，按需开启    |
| `Network.getCookies`          | ③    | 只允许当前 Tab 域名 |
| `Network.setCookies`          | ③    | 同上                |
| `Network.clearBrowserCookies` | ④    | 影响全局 Session    |
| `Network.clearBrowserCache`   | ④    | 影响全局缓存        |

**永久 Block 汇总**

| 命令                                  | 原因                               |
| ------------------------------------- | ---------------------------------- |
| `Browser.close` / `Browser.crash`     | 直接破坏主进程                     |
| `Browser.setDownloadBehavior`         | 修改下载路径，可被用于文件写入攻击 |
| `Target.setDiscoverTargets`           | 暴露所有 Target 包括主窗口         |
| `Network.clearBrowserCookies`         | 清除全局登录态                     |
| `Storage.clearDataForOrigin`          | 破坏存储数据                       |
| `Security.setIgnoreCertificateErrors` | 降级 HTTPS 安全性                  |
| `Debugger.enable`                     | 允许 AI 调试自身逻辑               |
| `HeapProfiler.enable`                 | 暴露内存信息                       |

---

## 五、React 组件结构

```
<App>
├── <TitleBar />                      — 窗口控制 + 应用标题
├── <TabBar>
│    ├── <Tab> × N                   — 每个 Tab 独立状态
│    │    ├── favicon + title
│    │    ├── 绿色呼吸灯（aiControlled）
│    │    └── 橙色 CDP 徽章（debuggerAttached）
│    └── <NewTabButton />
├── <AddressBar>
│    ├── <NavButtons />               — 前进/后退/刷新
│    ├── <URLBar />                   — 地址栏 + 安全锁
│    └── <AIToggleButton />           — 开启/关闭 AI 控制
├── <Main>
│    ├── <BrowserArea>                — WebContentsView 挂载区
│    │    ├── <AIHighlightOverlay />  — 注入页面的高亮框
│    │    └── <AICursorOverlay />     — AI 光标动画
│    └── <AIPanel>
│         ├── <ModelSelector />
│         ├── <AgentStatusBar />
│         ├── <ChatHistory />
│         │    ├── <UserMessage />
│         │    ├── <AgentMessage />
│         │    ├── <CDPLogBlock />    — 黑色 terminal 风格
│         │    └── <SystemEvent />
│         ├── <ActionQueue />         — pending / running / done
│         └── <CommandInput />
└── <StatusBar>
     ├── debugger 状态
     ├── CDP Session ID
     └── Agent 进度（step N/M）
```

---

## 六、数据流说明

### 6.1 AI 执行一个指令的完整链路

```
1. 用户在 <CommandInput /> 输入指令
       ↓ ipc.invoke('agent:run', prompt)
2. 主进程收到，调用 Claude API（挂载 MCP Server）
       ↓ Claude 决定调用 browser_screenshot
3. @playwright/mcp 向 CDP Proxy 发送 Page.captureScreenshot
       ↓ CDPBridge 校验通过，调用 debugger.sendCommand
4. Electron 截图，返回 base64 图片
       ↓ CDPBridge 将结果回传给 @playwright/mcp
5. @playwright/mcp 将图片作为 tool_result 返回给 Claude
       ↓ Claude 分析图片，决定下一步 browser_click
6. 循环步骤 3-5，直到任务完成
       ↓ 每一步通过 ipcMain.send 通知 React 更新 UI
7. React 实时更新 ActionQueue + CDPLogBlock + AgentStatusBar
```

### 6.2 新建 Tab 的特殊链路

```
Claude 调用 browser_navigate（新 URL）
  → @playwright/mcp 发送 Target.createTarget { url }
  → CDPBridge._handleTarget 拦截
  → tabManager.createTab({ aiAllowed: true, url })
  → Electron 创建 WebContentsView，附加 debugger
  → ipc 通知 React 更新 TabBar
  → CDPBridge 返回 { targetId: newTabId }
  → 推送 Target.targetCreated 事件
  → @playwright/mcp 继续发送 Target.attachToTarget
  → CDPBridge 返回 { sessionId: newTabId }
  → 后续操作正常透传
```

---

## 七、安全防护层级

```
Layer 1  tabManager.aiAllowed      主窗口永远不在 /json/list 里
Layer 2  BLOCKED 命令黑名单        危险命令直接拒绝
Layer 3  URL 协议过滤              file:// chrome:// devtools:// 不可访问
Layer 4  快捷键过滤                Ctrl+W / Alt+F4 等静默丢弃
Layer 5  Runtime.evaluate 关键词   require / process / ipcRenderer 等被拦截
Layer 6  webContents.debugger      per-view 级别，天然隔离主进程
```

---

## 八、关键依赖

```json
{
  "dependencies": {
    "electron": "^29.0.0",
    "@playwright/mcp": "latest",
    "ws": "^8.0.0",
    "react": "^18.0.0",
    "zustand": "^4.0.0",
    "framer-motion": "^11.0.0",
    "@tanstack/react-virtual": "^3.0.0",
    "tailwindcss": "^3.0.0",
    "zod": "^3.0.0"
  }
}
```

---

## 九、后续扩展方向

| 方向         | 说明                                                         |
| ------------ | ------------------------------------------------------------ |
| 多 AI 实例   | 每个 Tab 独立 Claude 对话上下文，互不干扰                    |
| 录制 / 回放  | 将 CDPBridge 的日志序列化，支持操作回放                      |
| Session 隔离 | 不同 Tab 使用不同 `session.fromPartition()`，Cookie 完全隔离 |
| 权限分级     | 对不同 AI 指令来源设置不同的命令白名单（只读 vs 读写）       |
| 审计日志     | 将所有 CDP 命令持久化到 SQLite，支持事后审查                 |
