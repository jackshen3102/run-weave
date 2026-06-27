# Terminal Panel Split Prototype

一次性 HTML + React 原型，用于验证 **tmux 原生 split 方案**下的 terminal session Panel target、CLI event 同步和程序化路由。

这个原型不再表达“多个独立 React TerminalSurface”。页面主体只有一个 `tmux attach surface`，内部用模拟 tmux panes 表达原生 split；外部的 target bar 只负责选择、拆分、发送和事件同步。

## 启动

```bash
python3 -m http.server 6188 --directory docs/prototypes/terminal-panel-split
```

打开：

```text
http://127.0.0.1:6188/
```

## 文件

- `index.html`：静态页面、样式和挂载点。
- `app.js`：React 原型逻辑，使用浏览器 ESM，不需要构建。
- `mock-state.json`：模拟 project、terminal session、tmux pane 映射和事件。
- `prototype-preview.png`：当前验证截图。

## 边界

- 不引用 `frontend/src`、`backend/src` 或主项目组件。
- 不连接真实 backend、tmux、WebSocket。
- 不实现真实 xterm；只模拟一个 session-level tmux attach surface。
- 不实现多个独立 Panel Surface，不模拟 panel-level WebSocket。
- `Simulate CLI split`、`Mock send`、event feed 和 toast 都是原型辅助控件，不是最终产品 UI。
- 原型文件不参与产品构建。

## 验证点

- 一个 terminal tab 内只有一个 tmux attach surface。
- Split Right / Split Down 在同一个 surface 内增加模拟 tmux pane。
- Panel chips 可以选择 active target，并对应 `select-pane -t %pane` 的业务含义。
- `rw terminal send ... --panel tests` 的目标路由可以直观看到，但不代表 WebSocket 被拆成 panel-level。
- CLI/API 事件同步更新 target bar 和 event feed，tmux 画面由同一个 surface 承载。
