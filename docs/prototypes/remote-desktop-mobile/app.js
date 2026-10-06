const app = document.querySelector("#app");
const query = new URLSearchParams(location.search);
const paths = {
  keyboard:
    '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
  menu: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  monitor:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>',
  fit: '<path d="M9 3H3v6M15 3h6v6M21 15v6h-6M9 21H3v-6M8 8h8v8H8z"/>',
  mouse:
    '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 2v8M6 10h12"/>',
  stats: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/>',
  collapse: '<path d="m9 6 6 6-6 6M20 5v14"/>',
  exit: '<path d="M9 4H4v16h5M13 7l5 5-5 5M8 12h12"/>',
  down: '<path d="m6 10 6 6 6-6M5 4h14"/>',
  send: '<circle cx="12" cy="12" r="9"/><path d="M12 17V7m-4 4 4-4 4 4"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const button = (action, label, symbol, cls = "") =>
  `<button class="${cls}" data-action="${action}" aria-label="${label}" title="${label}">${icon(symbol)}</button>`;
let data,
  state,
  toastTimer,
  floatingPosition = null;
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

function desktop() {
  return `<section class="surface" aria-label="远程桌面画布"><div class="remote-screen">
 <div class="macbar"><strong>●</strong><b>Terminal</b><span>Shell</span><span>Edit</span><span>View</span><span>Window</span><span class="spacer"></span><span>Tue 11:04</span></div>
 <div class="editor"><div class="windowbar"><i class="dot"></i><i class="dot yellow"></i><i class="dot green"></i><span class="windowtitle">runweave — RemoteDesktopView.swift</span></div><div class="editorbody"><aside class="files"><strong>EXPLORER</strong><b>⌄ RUNWEAVE</b>${data.files.map((f, i) => `<div class="file ${i === 2 ? "selected" : ""}">${i < 2 ? "⌄" : "&nbsp;"} ${escape(f)}</div>`).join("")}</aside><div class="workspace"><div class="tab">◇ &nbsp; RemoteDesktopView.swift &nbsp; ×</div><div class="code"><span class="comment">// A little more room for your desktop.</span>
<em>struct</em> RemoteDesktopView: View {
    <em>var</em> body: <em>some</em> View {
        ZStack(alignment: .bottomTrailing) {
            RemoteDesktopSurface()
            SessionControls()
        }
    }
}</div><div class="terminal"><div class="terminal-label">TERMINAL &nbsp;&nbsp; OUTPUT &nbsp;&nbsp; PROBLEMS</div>${data.terminal.map((s, i) => `<div class="${i === 1 ? "command" : ""}">${escape(s) || "&nbsp;"}</div>`).join("")}<div class="remote-output">${escape(state.sent)}</div><div><span style="color:#89caa6">❯</span> <span class="cursor"></span></div></div></div></div></div><div class="dock"><span>▣</span><span>⌘</span><span>◉</span><span>›_</span></div></div><div class="pointer"><svg viewBox="0 0 20 26"><path d="M2 1v20l5-5 4 8 4-2-4-8h7z"/></svg></div>${state.context ? '<div class="context-menu"><div>复制</div><div>粘贴</div><div>全选</div></div>' : ""}</section>`;
}
function row(action, label, symbol, trailing = "", cls = "") {
  return `<button class="menu-row ${cls}" data-action="${action}">${icon(symbol)}<span>${label}</span><span class="trailing">${trailing}</span></button>`;
}
function menu() {
  if (state.panel === "stats" || state.panel === "help") {
    const stats = state.panel === "stats";
    const rows = stats
      ? [
          ["往返延迟", data.statistics.latency],
          ["帧率", data.statistics.fps],
          ["桌面分辨率", data.statistics.resolution],
          ["连接方式", data.statistics.network],
        ]
      : [
          ["移动指针", "单指滑动"],
          ["点击 / 双击", "轻点 / 连点两下"],
          ["右击", "双指轻点"],
          ["滚动", "双指滑动"],
          ["缩放画面", "双指捏合"],
          ["移动画面", "三指拖动"],
          ["拖拽", "长按后移动"],
        ];
    return `<section class="sheet" aria-label="${stats ? "连接统计" : "手势帮助"}"><div class="subheading"><button data-action="back" aria-label="返回菜单">‹</button>${stats ? "连接统计" : "手势帮助"}</div><div class="details">${rows.map(([k, v]) => `<div class="detail"><span>${k}</span><strong>${v}</strong></div>`).join("")}</div></section>`;
  }
  return `<section class="sheet" aria-label="会话菜单"><header><div class="host-row"><div class="host-icon">${icon("monitor")}</div><div><div class="host-name">${escape(data.host)}</div><div class="connection"><i></i>可以控制 · ${data.statistics.network}</div></div></div></header><div class="mode-switch" role="group" aria-label="输入模式"><button data-action="trackpad" class="${state.mode === "trackpad" ? "active" : ""}" aria-pressed="${state.mode === "trackpad"}">触控板</button><button data-action="direct" class="${state.mode === "direct" ? "active" : ""}" aria-pressed="${state.mode === "direct"}">直接点击</button></div><div class="menu-actions">${row("fit", "适应屏幕", "fit", `${Math.round(state.zoom * 100)}%`)}${row("right", "右击", "mouse")}${row("stats", "连接统计", "stats", data.statistics.latency)}${row("help", "手势帮助", "help")}<div class="divider"></div>${row("collapse", state.collapsed ? "展开工具栏" : "收起工具栏", "collapse")}${row("exit", "结束会话", "exit", "", "danger")}</div></section>`;
}
function keyboard() {
  return `<section class="keyboard-panel" aria-label="远程键盘">${state.shortcuts ? '<div class="shortcut-row">' + ["⌘", "⌃", "⌥", "⇧", "Esc", "Tab", "←", "↑", "↓", "→"].map((k) => `<button data-key="${k}" class="${state.modifiers.includes(k) ? "selected" : ""}">${escape(k)}</button>`).join("") + "</div>" : ""}<div class="inputbar"><button data-action="shortcuts" aria-label="展开快捷键" aria-expanded="${state.shortcuts}" style="font-size:24px">⌘</button><input aria-label="输入文字" placeholder="输入文字…" inputmode="none" value="${escape(state.draft)}">${button("send", "发送", "send", "send")}${button("hide-keyboard", "收起键盘", "down")}</div><div class="keys">${(state.numeric ? ["1234567890", "-/:;()@", ".,?!+="] : ["qwertyuiop", "asdfghjkl", "zxcvbnm"]).map((row, i) => `<div class="keyrow">${i === 2 ? '<button class="key utility" data-key="shift" aria-label="大写">⇧</button>' : ""}${[...row].map((k) => `<button class="key" data-key="${k}">${state.shift ? k.toUpperCase() : k}</button>`).join("")}${i === 2 ? '<button class="key utility" data-key="delete" aria-label="删除">⌫</button>' : ""}</div>`).join("")}<div class="keyrow"><button class="key utility" data-key="123">${state.numeric ? "ABC" : "123"}</button><button class="key space" data-key="space">空格</button><button class="key utility" data-action="send">发送</button></div></div></section>`;
}
function render() {
  app.innerHTML = `<div class="statusbar" aria-hidden="true"><span>11:04</span><div class="island"></div><div class="status-icons"><svg viewBox="0 0 20 20"><path d="M3 15v-3M7 15V9M11 15V6M15 15V3" stroke-width="3"/></svg><svg viewBox="0 0 20 20"><path d="M2 7q8-7 16 0M5 10q5-5 10 0M8 13q2-2 4 0M10 16h.01" stroke-width="2"/></svg><div class="battery"><span></span></div></div></div>${desktop()}${state.panel ? '<div class="backdrop" data-action="dismiss"></div>' + menu() : ""}${!state.keyboard && !state.ended ? `<div class="floating ${state.collapsed ? "collapsed" : ""} ${state.panel ? "open" : ""}" aria-label="悬浮工具栏">${button("keyboard", "打开键盘", "keyboard", "keyboard-button")}${button("menu", state.panel ? "关闭菜单" : "打开菜单", state.panel ? "close" : "menu", "menu-button")}</div>` : ""}${state.keyboard ? keyboard() : ""}${query.get("connection") === "reconnecting" ? '<div class="reconnecting" role="status">正在重新连接…</div>' : ""}${state.ended ? `<section class="ended">${icon("monitor")}<h1>会话已结束</h1><p>${escape(data.host)}</p><button data-action="reconnect">重新连接</button></section>` : ""}<div class="toast" role="status" hidden></div><div class="home" aria-hidden="true"></div>`;
  layout();
  bindDrag();
  const input = app.querySelector("input");
  if (input) {
    input.addEventListener("input", () => {
      state.draft = input.value;
      app.querySelector(".send").disabled = !state.draft;
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") act("send");
    });
    app.querySelector(".send").disabled = !state.draft;
  }
}
function layout() {
  const surface = app.querySelector(".surface"),
    screen = app.querySelector(".remote-screen");
  const fit = Math.min(surface.clientWidth / 1100, surface.clientHeight / 688);
  const offset = state.keyboard
    ? Math.min(130, surface.clientHeight * 0.15)
    : 0;
  screen.style.transform = `translate(calc(-50% + ${state.panX}px),calc(-50% - ${offset}px + ${state.panY}px)) scale(${fit * state.zoom})`;
  const floating = app.querySelector(".floating"),
    sheet = app.querySelector(".sheet");
  if (floating && floatingPosition) {
    floating.style.left = floatingPosition.side === "left" ? "16px" : "auto";
    floating.style.right = floatingPosition.side === "right" ? "16px" : "auto";
    floating.style.bottom = `${Math.min(floatingPosition.bottom, app.clientHeight - 125)}px`;
  }
  if (sheet && floatingPosition) {
    sheet.style.left = floatingPosition.side === "left" ? "16px" : "auto";
    sheet.style.right = floatingPosition.side === "right" ? "16px" : "auto";
    sheet.style.bottom = `${Math.max(35, Math.min(floatingPosition.bottom + 64, app.clientHeight - sheet.offsetHeight - 68))}px`;
  }
}
function toast(message) {
  const el = app.querySelector(".toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 1600);
}
function act(action) {
  if (action === "menu") state.panel = state.panel ? "" : "menu";
  if (action === "dismiss") {
    state.panel = "";
    state.context = false;
  }
  if (action === "keyboard") {
    state.keyboard = true;
    state.panel = "";
  }
  if (action === "hide-keyboard") {
    state.keyboard = false;
    state.shortcuts = false;
    state.modifiers = [];
  }
  if (action === "shortcuts") state.shortcuts = !state.shortcuts;
  if (action === "back") state.panel = "menu";
  if (action === "stats" || action === "help") state.panel = action;
  if (action === "trackpad" || action === "direct") {
    state.mode = action;
    localStorage.setItem("remote-prototype-mode", action);
  }
  if (action === "fit") {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.panel = "";
  }
  if (action === "collapse") {
    state.collapsed = !state.collapsed;
    state.panel = "";
  }
  if (action === "right") {
    state.context = true;
    state.panel = "";
  }
  if (action === "send" && state.draft.trim()) {
    state.sent = "$ " + state.draft;
    state.draft = "";
    render();
    toast("已发送");
    return;
  }
  if (action === "exit") {
    state.ended = true;
    state.panel = "";
    state.keyboard = false;
    state.draft = "";
    state.modifiers = [];
  }
  if (action === "reconnect") {
    state.ended = false;
    state.sent = "";
  }
  render();
}
let dragged = false;
function bindDrag() {
  const floating = app.querySelector(".floating");
  if (!floating) return;
  let start = null;
  floating.addEventListener("pointerdown", (e) => {
    start = {
      x: e.clientX,
      y: e.clientY,
      bottom: app.clientHeight - (floating.offsetTop + floating.offsetHeight),
    };
    dragged = false;
  });
  floating.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x,
      dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > 8) {
      dragged = true;
      floating.setPointerCapture(e.pointerId);
      floating.style.transform = `translate(${dx}px,${dy}px)`;
    }
  });
  floating.addEventListener("pointerup", (e) => {
    if (start && dragged) {
      floatingPosition = {
        side:
          e.clientX - app.getBoundingClientRect().left < app.clientWidth / 2
            ? "left"
            : "right",
        bottom: Math.max(
          40,
          Math.min(
            app.clientHeight - 125,
            start.bottom - (e.clientY - start.y),
          ),
        ),
      };
      localStorage.setItem(
        "remote-prototype-position",
        JSON.stringify(floatingPosition),
      );
      render();
    }
    start = null;
  });
  floating.addEventListener("pointercancel", () => {
    start = null;
    floating.style.transform = "";
  });
}
app.addEventListener("click", (e) => {
  if (dragged) {
    dragged = false;
    return;
  }
  const action = e.target.closest("[data-action]");
  if (action) {
    act(action.dataset.action);
    return;
  }
  const key = e.target.closest("[data-key]");
  if (key) {
    const k = key.dataset.key;
    if (k === "delete") state.draft = state.draft.slice(0, -1);
    else if (k === "space") state.draft += " ";
    else if (k === "shift") state.shift = !state.shift;
    else if (k === "123") state.numeric = !state.numeric;
    else if (["⌘", "⌃", "⌥", "⇧"].includes(k)) {
      state.modifiers = state.modifiers.includes(k)
        ? state.modifiers.filter((m) => m !== k)
        : [...state.modifiers, k];
    } else if (k.length > 1 || ["←", "↑", "↓", "→"].includes(k)) {
      state.modifiers = [];
      render();
      toast("已发送按键 " + k);
      return;
    } else state.draft += state.shift ? k.toUpperCase() : k;
    render();
    return;
  }
  if (e.target.closest(".surface")) {
    if (state.context) {
      state.context = false;
      render();
    }
    const pointer = app.querySelector(".pointer");
    pointer.style.left = `${e.clientX - app.getBoundingClientRect().left}px`;
    pointer.style.top = `${e.clientY - app.getBoundingClientRect().top - 59}px`;
  }
});
app.addEventListener(
  "wheel",
  (e) => {
    if (!e.target.closest(".surface")) return;
    e.preventDefault();
    state.zoom = Math.max(1, Math.min(3, state.zoom - e.deltaY * 0.003));
    layout();
  },
  { passive: false },
);
window.addEventListener("resize", layout);
fetch("./mock-state.json")
  .then((r) => {
    if (!r.ok) throw Error("Unable to load prototype");
    return r.json();
  })
  .then((mock) => {
    data = mock;
    let mode = mock.mode;
    try {
      mode = localStorage.getItem("remote-prototype-mode") || mode;
      floatingPosition = JSON.parse(
        localStorage.getItem("remote-prototype-position") || "null",
      );
    } catch {}
    state = {
      mode,
      zoom: Number(query.get("zoom")) || data.zoom,
      panel: query.get("state") === "menu" ? "menu" : "",
      keyboard: query.get("state") === "keyboard",
      draft: query.get("state") === "keyboard" ? data.initialDraft : "",
      shortcuts: false,
      shift: false,
      numeric: false,
      collapsed: query.get("state") === "collapsed",
      ended: false,
      context: false,
      sent: "",
      modifiers: [],
      panX: 0,
      panY: 0,
    };
    render();
  })
  .catch((error) => {
    app.textContent = "原型加载失败：" + error.message;
  });
