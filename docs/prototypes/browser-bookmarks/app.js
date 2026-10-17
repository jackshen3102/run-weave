const $ = (s) => document.querySelector(s);
const app = $("#app");
const layers = $("#layers");
const storageKey = "runweave-bookmarks-prototype-v1";
const paths = {
  star: "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z",
  folder: "M3 7V5h6l2 2h10v13H3Z",
  back: "m14 6-6 6 6 6",
  forward: "m10 6 6 6-6 6",
  reload: "M20 7v5h-5M20 12a8 8 0 1 0-2 6",
  plus: "M12 5v14M5 12h14",
  close: "m6 6 12 12M6 18 18 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  chevron: "m6 9 6 6 6-6",
  overflow: "m6 7 5 5-5 5m7-10 5 5-5 5",
  book: "M4 4h16v16H4zM9 4v16",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z",
  copy: "M9 9h11v11H9zM15 9V4H4v11h5",
  terminal: "m5 7 5 5-5 5m8 0h6",
  check: "m5 12 4 4L19 6",
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`;
const esc = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uid = () => crypto.randomUUID();
let state,
  popup = null,
  drawer = false,
  draggedId = null,
  toastTimer;
const activeTab = () => state.tabs.find((t) => t.id === state.activeTab);
const currentBookmark = () =>
  state.items.find((i) => i.type !== "folder" && i.url === activeTab().url);
const favicon = (item) =>
  item.type === "folder"
    ? `<span class="folder-icon">${icon("folder")}</span>`
    : `<span class="favicon" style="color:${item.color || "#7dd3fc"}">${esc(item.icon || item.title.slice(0, 1).toUpperCase())}</span>`;
function save() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2200);
}
function bookmarkButton(i) {
  return `<button class="bookmark" draggable="true" data-item="${i.id}" title="${esc(i.url || i.title)}">${favicon(i)}<span class="label">${esc(i.title)}</span></button>`;
}
function render() {
  const tab = activeTab();
  app.innerHTML = `<div class="shell"><header class="titlebar"><div class="traffic"><i></i><i></i><i></i></div><span class="brand">Runweave</span><span class="path">browser-viewer / main</span><span class="connected">本机已连接</span></header><div class="workspace">
 <aside class="projects"><div class="section-label">项目 <span>＋</span></div><div class="project selected">${icon("folder")} browser-viewer</div><div class="tree"><div class="active">main</div><div>agent-team-2</div></div><div class="project muted">${icon("folder")} toolkit</div><div class="project muted">${icon("folder")} personal-site</div><div class="project-footer">⌘ &nbsp; 工作区设置</div></aside>
 <section class="terminal"><div class="pane-head">${icon("terminal")} 终端 1 <span class="right">＋ &nbsp; ···</span></div><div class="terminal-content"><div class="terminal-mark">✳ &nbsp; Codex</div><p class="log">browser-viewer <span class="green">main</span></p><p class="prompt">❯ 帮我梳理项目的浏览器模块</p><p>浏览器模块主要由页面导航、标签页和独立的 Profile 构成。</p><div class="terminal-card"><span class="green">✓</span> 已读取项目结构<br><span class="green">✓</span> 已定位浏览器入口</div><p class="log">frontend/src/components/<br>└─ terminal/browser/<br>&nbsp;&nbsp; ├─ header/<br>&nbsp;&nbsp; ├─ tabs/<br>&nbsp;&nbsp; └─ annotations/</p><p class="log">可以从右侧浏览器查看项目文档。</p></div><div class="terminal-input">输入消息…<footer><span>GPT-6.1 · Default</span><span>↵</span></footer></div></section>
 <section class="browser"><div class="tabs">${state.tabs.map((t) => `<button class="tab ${t.id === state.activeTab ? "active" : ""}" data-tab="${t.id}"><span class="favicon">${esc(t.title[0])}</span><span>${esc(t.title)}</span></button>`).join("")}<button class="icon" data-action="new-tab" aria-label="新建标签页">${icon("plus")}</button></div>
 <div class="navigation"><button class="icon" data-action="back" aria-label="后退" ${tab.previous ? "" : "disabled"}>${icon("back")}</button><button class="icon" disabled aria-label="前进">${icon("forward")}</button><button class="icon" data-action="reload" aria-label="刷新">${icon("reload")}</button><form class="address-form" id="address-form">${icon("lock")}<input aria-label="网址" name="url" value="${esc(tab.url)}"><button type="button" class="icon star ${currentBookmark() ? "active" : ""}" data-action="star" aria-label="${currentBookmark() ? "编辑当前收藏" : "收藏当前网页"}">${icon("star")}</button></form><button class="icon" data-action="copy" aria-label="复制网址">${icon("copy")}</button><span class="profile" title="Profile 1">1</span><button class="icon" data-action="tools" aria-label="浏览器菜单">${icon("more")}</button></div>
 ${
   state.showBar
     ? `<div class="bookmarks-bar"><div class="bookmarks-items">${state.items
         .filter((i) => !i.parent)
         .map(bookmarkButton)
         .join(
           "",
         )}</div><button class="icon" data-action="overflow" aria-label="更多收藏">${icon("overflow")}</button><button class="all-button" data-action="all">${icon("book")} 收藏夹</button></div>`
     : ""
 }
 <div class="page">${renderPage(tab)}</div></section></div></div>`;
  requestAnimationFrame(fitBar);
  renderLayers();
}
function renderPage(tab) {
  if (tab.url.includes("docs.runweave.dev"))
    return `<header class="site-header"><span class="site-logo">≋</span> Runweave <small>文档</small></header><div class="site-body"><aside class="site-sidebar"><div class="selected">开始使用</div><div>安装与配置</div><div>项目与工作区</div><div>终端</div><div>浏览器</div><div>快捷指令</div></aside><article class="article"><div class="crumb">文档 &nbsp; / &nbsp; 开始使用</div><span class="eyebrow">GETTING STARTED</span><h1>你的工作，从这里开始。</h1><p class="intro">把项目、终端和浏览器放在一起，<br>让想法到结果的距离更近一点。</p><h2>打开你的第一个项目</h2><p>选择本地项目目录，在工作区中打开终端。浏览器会随时留在手边，方便查看文档和预览页面。</p><div class="code"><span style="color:#64748b"># 启动工作区</span><br>rw open ~/Code/my-project</div><h2>专注于正在做的事</h2><p>在终端中与 Agent 协作，在浏览器中查看结果。切换任务时，也能随时回到熟悉的工作环境。</p><div class="doc-cards"><div class="doc-card">项目与工作区 &nbsp; ↗<span>组织项目和工作目录</span></div><div class="doc-card">浏览器 &nbsp; ↗<span>查看页面与调试应用</span></div></div></article></div>`;
  return `<header class="site-header"><span class="site-logo">${esc(tab.title[0])}</span>${esc(tab.title)}</header><div class="site-generic"><span class="site-logo">${esc(tab.title[0])}</span><h1>${esc(tab.title)}</h1><p>${esc(tab.url)}</p></div>`;
}
function fitBar() {
  const list = $(".bookmarks-items");
  if (!list) return;
  const entries = [...list.children];
  entries.forEach((el) => (el.style.display = "flex"));
  let used = 0;
  entries.forEach((el) => {
    used += el.getBoundingClientRect().width + 2;
    el.style.display = used > list.clientWidth ? "none" : "flex";
  });
  const overflow = $('[data-action="overflow"]');
  overflow.style.visibility = entries.some((el) => el.style.display === "none")
    ? "visible"
    : "hidden";
}
function anchor(el) {
  return el.getBoundingClientRect();
}
function showPopup(type, el, data = {}) {
  popup = {
    type,
    ...data,
    rect: el ? anchor(el) : { left: window.innerWidth - 350, bottom: 130 },
  };
  renderLayers();
}
function positionPopup() {
  const el = $(".popup");
  if (!el) return;
  const r = popup.rect;
  const left = Math.min(
    Math.max(10, r.left),
    window.innerWidth - el.offsetWidth - 10,
  );
  const top = Math.min(r.bottom + 5, window.innerHeight - el.offsetHeight - 12);
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(10, top)}px`;
}
function menuRow(item) {
  return `<button class="menu-row" draggable="true" data-item="${item.id}">${favicon(item)}<span class="row-text">${esc(item.title)}</span>${item.type === "folder" ? `<span class="sub">${icon("forward")}</span>` : ""}</button>`;
}
function renderLayers() {
  layers.innerHTML = drawer ? renderDrawer() : "";
  if (!popup) return;
  let html = "";
  if (popup.type === "edit") {
    const saved = state.items.find((i) => i.id === popup.id);
    if (!saved) return;
    const i = { ...saved, ...popup.draft };
    html = `<form id="edit-form" class="popup edit-popup" role="dialog" aria-label="${popup.fresh ? "已添加收藏" : "编辑收藏"}"><h3>${popup.fresh ? "已添加收藏" : "编辑收藏"}</h3><label class="field">名称<input name="title" value="${esc(i.title)}" required></label><label class="field">网址<input name="url" value="${esc(i.url)}" required></label><label class="field">文件夹<select name="parent"><option value="">收藏栏</option>${state.items
      .filter((x) => x.type === "folder")
      .map(
        (x) =>
          `<option value="${x.id}" ${x.id === i.parent ? "selected" : ""}>${esc(x.title)}</option>`,
      )
      .join(
        "",
      )}</select></label><button type="button" class="link-button" data-action="new-folder" data-return="${i.id}">＋ 新建文件夹</button><div class="error" id="form-error"></div><div class="actions"><button type="button" class="btn danger" data-action="delete" data-id="${i.id}">移除收藏</button><button class="btn primary" type="submit">完成</button></div></form>`;
  } else if (popup.type === "folder-edit") {
    const i = state.items.find((i) => i.id === popup.id);
    html = `<form id="folder-form" class="popup edit-popup" role="dialog" aria-label="${i ? "重命名文件夹" : "新建文件夹"}"><h3>${i ? "重命名文件夹" : "新建文件夹"}</h3><label class="field">名称<input name="title" value="${esc(i?.title || "")}" placeholder="文件夹名称" required autofocus></label><div class="actions"><button type="button" class="btn" data-action="cancel-folder">取消</button><button class="btn primary" type="submit">${i ? "保存" : "创建"}</button></div></form>`;
  } else if (popup.type === "folder") {
    const folder = state.items.find((i) => i.id === popup.id);
    const items = state.items.filter((i) => i.parent === popup.id);
    html = `<div class="popup" role="menu"><div class="popup-header">${esc(folder.title)}<span>${items.length}</span></div>${items.map(menuRow).join("") || '<div class="empty">此文件夹为空</div>'}<div class="divider"></div><button class="menu-row" data-action="save-here" data-id="${folder.id}">${icon("plus")}收藏当前网页到此处</button></div>`;
  } else if (popup.type === "context") {
    const i = state.items.find((i) => i.id === popup.id);
    html = `<div class="popup" role="menu">${i.type !== "folder" ? `<button class="menu-row" data-action="open-new" data-id="${i.id}">在新标签页打开</button>` : ""}<button class="menu-row" data-action="edit" data-id="${i.id}">${i.type === "folder" ? "重命名文件夹" : "编辑收藏"}</button><div class="divider"></div><button class="menu-row" data-action="delete" data-id="${i.id}">删除${i.type === "folder" ? "文件夹" : ""}</button></div>`;
  } else if (popup.type === "confirm-delete") {
    const i = state.items.find((i) => i.id === popup.id);
    html = `<div class="popup edit-popup" role="dialog" aria-label="删除文件夹"><h3>删除「${esc(i.title)}」？</h3><p class="muted">其中的 ${state.items.filter((x) => x.parent === i.id).length} 项收藏也会被删除。</p><div class="actions"><button class="btn" data-action="close-popup">取消</button><button class="btn primary" data-action="confirm-delete" data-id="${i.id}">删除</button></div></div>`;
  } else if (popup.type === "overflow") {
    const ids = [...document.querySelectorAll(".bookmarks-items>[data-item]")]
      .filter((el) => el.style.display === "none")
      .map((el) => el.dataset.item);
    html = `<div class="popup" role="menu"><div class="popup-header">更多收藏</div>${state.items
      .filter((i) => ids.includes(i.id))
      .map(menuRow)
      .join("")}</div>`;
  } else if (popup.type === "tools") {
    html = `<div class="popup" role="menu"><button class="menu-row" data-action="all">${icon("book")}收藏夹</button><button class="menu-row" data-action="toggle-bar"><span style="width:16px">${state.showBar ? icon("check") : ""}</span>显示收藏栏</button><div class="divider"></div><button class="menu-row" data-action="new-folder">${icon("folder")}新建文件夹</button></div>`;
  }
  layers.insertAdjacentHTML("beforeend", html);
  positionPopup();
  if (popup.type === "folder-edit") $(".popup input").focus();
}
function renderDrawer() {
  return `<aside class="drawer" aria-label="收藏夹面板"><div class="drawer-header">收藏夹<button class="icon" data-action="close-drawer" aria-label="关闭收藏夹">${icon("close")}</button></div><input class="search" id="search" aria-label="搜索收藏" placeholder="搜索名称或网址"><div class="drawer-list" id="drawer-list">${drawerRows("")}</div><div class="drawer-footer"><button class="link-button" data-action="new-folder">＋ 新建文件夹</button><span class="muted">${state.items.filter((i) => i.type !== "folder").length} 项收藏</span></div></aside>`;
}
function collectionRow(i) {
  return `<div class="collection-row" draggable="true" data-drag-id="${i.id}"><button class="menu-row" data-item="${i.id}">${favicon(i)}<span class="row-text">${esc(i.title)}${i.url ? `<small>${esc(i.url)}</small>` : ""}</span></button><button class="icon" data-action="context" data-id="${i.id}" aria-label="管理 ${esc(i.title)}">${icon("more")}</button></div>`;
}
function drawerRows(query) {
  const q = query.trim().toLowerCase();
  if (q) {
    const found = state.items.filter((i) =>
      (i.title + " " + (i.url || "")).toLowerCase().includes(q),
    );
    return (
      found.map(collectionRow).join("") ||
      '<div class="empty">没有找到匹配的收藏</div>'
    );
  }
  return (
    state.items
      .filter((i) => !i.parent)
      .map((i) =>
        i.type === "folder"
          ? `${collectionRow(i)}<div class="nested">${state.items
              .filter((x) => x.parent === i.id)
              .map(collectionRow)
              .join("")}</div>`
          : collectionRow(i),
      )
      .join("") || '<div class="empty">还没有收藏的网页</div>'
  );
}
function navigate(item, newTab = false) {
  popup = null;
  if (item.type === "folder") return;
  if (newTab) {
    const tab = { id: uid(), title: item.title, url: item.url };
    state.tabs.push(tab);
    state.activeTab = tab.id;
  } else {
    const t = activeTab();
    t.previous = { url: t.url, title: t.title };
    t.title = item.title;
    t.url = item.url;
  }
  save();
  render();
}
function addCurrent(el, parent) {
  let i = currentBookmark();
  let fresh = false;
  if (!i) {
    i = {
      id: uid(),
      title: activeTab().title,
      url: activeTab().url,
      parent: parent || null,
    };
    state.items.push(i);
    fresh = true;
  } else if (parent) i.parent = parent;
  save();
  render();
  showPopup("edit", el?.isConnected ? el : $(".star"), { id: i.id, fresh });
}
function deleteItem(id) {
  const i = state.items.find((x) => x.id === id);
  if (i.type === "folder" && state.items.some((x) => x.parent === id)) {
    popup = { ...popup, type: "confirm-delete", id };
    renderLayers();
    return;
  }
  removeItem(id);
}
function removeItem(id) {
  state.items = state.items.filter((i) => i.id !== id && i.parent !== id);
  popup = null;
  save();
  render();
  toast("已删除");
}
function click(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (button.dataset.tab) {
    state.activeTab = button.dataset.tab;
    popup = null;
    save();
    render();
    return;
  }
  if (button.dataset.item) {
    const i = state.items.find((x) => x.id === button.dataset.item);
    if (i.type === "folder") showPopup("folder", button, { id: i.id });
    else navigate(i, event.metaKey || event.ctrlKey);
    return;
  }
  switch (action) {
    case "star":
      addCurrent(button);
      break;
    case "all":
      drawer = true;
      popup = null;
      renderLayers();
      $("#search").focus();
      break;
    case "close-drawer":
      drawer = false;
      popup = null;
      renderLayers();
      break;
    case "tools":
    case "overflow":
      showPopup(action, button);
      break;
    case "toggle-bar":
      state.showBar = !state.showBar;
      popup = null;
      save();
      render();
      break;
    case "close-popup":
      popup = null;
      renderLayers();
      break;
    case "new-folder": {
      const returnId = button.dataset.return;
      const draft = returnId
        ? Object.fromEntries(new FormData($("#edit-form")))
        : undefined;
      showPopup("folder-edit", button, { returnId, draft });
      break;
    }
    case "cancel-folder":
      if (popup.returnId) {
        popup = { ...popup, type: "edit", id: popup.returnId };
        renderLayers();
      } else {
        popup = null;
        renderLayers();
      }
      break;
    case "context":
      showPopup("context", button, { id });
      break;
    case "edit":
      showPopup(
        state.items.find((i) => i.id === id).type === "folder"
          ? "folder-edit"
          : "edit",
        button,
        { id },
      );
      break;
    case "delete":
      deleteItem(id);
      break;
    case "confirm-delete":
      removeItem(id);
      break;
    case "open-new":
      navigate(
        state.items.find((i) => i.id === id),
        true,
      );
      break;
    case "save-here":
      addCurrent($(".star"), id);
      break;
    case "new-tab":
      navigate({ title: "新标签页", url: "about:blank" }, true);
      break;
    case "copy":
      navigator.clipboard
        ?.writeText(activeTab().url)
        .then(() => toast("网址已复制"));
      break;
    case "reload":
      render();
      toast("页面已刷新");
      break;
    case "back": {
      const t = activeTab();
      Object.assign(t, t.previous, { previous: null });
      save();
      render();
      break;
    }
  }
}
document.addEventListener("click", click);
document.addEventListener("pointerdown", (e) => {
  if (
    popup &&
    !e.target.closest(".popup") &&
    !e.target.closest("[data-action]") &&
    !e.target.closest("[data-item]")
  ) {
    popup = null;
    renderLayers();
  }
});
document.addEventListener("contextmenu", (e) => {
  const target = e.target.closest("[data-item]");
  if (target) {
    e.preventDefault();
    popup = {
      type: "context",
      id: target.dataset.item,
      rect: { left: e.clientX, bottom: e.clientY },
    };
    renderLayers();
  } else if (e.target.closest(".bookmarks-bar")) {
    e.preventDefault();
    showPopup("tools", e.target);
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search")
    $("#drawer-list").innerHTML = drawerRows(e.target.value);
});
document.addEventListener("submit", (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  if (e.target.id === "address-form") {
    let url = String(form.get("url")).trim();
    if (!/^https?:\/\//i.test(url) && url !== "about:blank")
      url = "https://" + url;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "about:"].includes(parsed.protocol)) return;
      navigate({ url, title: parsed.hostname || "新标签页" });
    } catch {
      toast("请输入有效的网址");
    }
  }
  if (e.target.id === "edit-form") {
    const i = state.items.find((i) => i.id === popup.id);
    const title = String(form.get("title")).trim();
    const url = String(form.get("url")).trim();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) throw Error();
      if (!title) throw Error();
      if (state.items.some((x) => x.id !== i.id && x.url === url)) {
        $("#form-error").textContent = "这个网址已经在收藏夹中";
        return;
      }
      Object.assign(i, { title, url, parent: form.get("parent") || null });
      popup = null;
      save();
      render();
      toast("收藏已保存");
    } catch {
      $("#form-error").textContent = "请输入名称和有效的 HTTP(S) 网址";
    }
  }
  if (e.target.id === "folder-form") {
    const title = String(form.get("title")).trim();
    if (!title) return;
    const returnId = popup.returnId;
    const draft = popup.draft;
    let folder = state.items.find((i) => i.id === popup.id);
    if (folder) folder.title = title;
    else {
      folder = { id: uid(), title, type: "folder", parent: null };
      state.items.push(folder);
    }
    if (returnId) state.items.find((i) => i.id === returnId).parent = folder.id;
    popup = null;
    save();
    render();
    if (returnId)
      showPopup("edit", $(".star"), {
        id: returnId,
        draft: { ...draft, parent: folder.id },
      });
    else toast("文件夹已保存");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (popup) {
      popup = null;
      renderLayers();
      $(".star")?.focus();
    } else if (drawer) {
      drawer = false;
      renderLayers();
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    addCurrent($(".star"));
  }
});
document.addEventListener("dragstart", (e) => {
  const target = e.target.closest('[draggable="true"]');
  if (!target) return;
  draggedId = target.dataset.item || target.dataset.dragId;
  e.dataTransfer.setData("text/plain", draggedId);
  e.dataTransfer.effectAllowed = "move";
  popup = null;
});
document.addEventListener("dragover", (e) => {
  const target = e.target.closest("[data-item],[data-drag-id]");
  if (target && draggedId) {
    e.preventDefault();
    target.classList.add("drag-over");
  }
});
document.addEventListener("dragleave", (e) =>
  e.target.closest(".drag-over")?.classList.remove("drag-over"),
);
document.addEventListener("drop", (e) => {
  const target = e.target.closest("[data-item],[data-drag-id]");
  if (!target || !draggedId) return;
  e.preventDefault();
  const from = state.items.find((i) => i.id === draggedId);
  const to = state.items.find(
    (i) => i.id === (target.dataset.item || target.dataset.dragId),
  );
  if (from && to && from.id !== to.id) {
    if (from.type === "folder" && to.parent) {
      toast("文件夹只支持一层");
    } else {
      state.items = state.items.filter((i) => i.id !== from.id);
      if (to.type === "folder" && from.type !== "folder") {
        from.parent = to.id;
        state.items.push(from);
      } else {
        from.parent = to.parent;
        state.items.splice(state.items.indexOf(to), 0, from);
      }
      save();
      toast(
        to.type === "folder" && from.type !== "folder"
          ? "已移入文件夹"
          : "顺序已保存",
      );
    }
  }
  draggedId = null;
  render();
});
document.addEventListener("dragend", () => {
  draggedId = null;
  document
    .querySelectorAll(".drag-over")
    .forEach((e) => e.classList.remove("drag-over"));
});
window.addEventListener("resize", () => {
  fitBar();
  positionPopup();
});
async function start() {
  const initial = await fetch("./mock-state.json").then((r) => r.json());
  if (new URLSearchParams(location.search).has("reset"))
    localStorage.removeItem(storageKey);
  try {
    state = JSON.parse(localStorage.getItem(storageKey)) || initial;
  } catch {
    state = initial;
  }
  render();
}
start().catch((error) => {
  app.textContent = "无法加载原型：" + error.message;
});
