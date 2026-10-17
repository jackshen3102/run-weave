const app = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const params = new URLSearchParams(location.search);
const scheme = params.get("scheme") || "review";
const data = await fetch("./mock-state.json").then((r) => {
  if (!r.ok) throw new Error("原型数据加载失败");
  return r.json();
});
const state = {
  tab: "export",
  profile: "Browser 1",
  selected: new Set(["github.com"]),
  step: 1,
  server: "dev",
  target: "new",
  name: "GitHub 工作账号",
  mode: "copy",
  result: null,
  selectedId: "github-work",
  query: "",
  filter: "all",
  identities: structuredClone(data.identities),
  imported: null,
  error: "",
  busy: false,
};
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const button = (label, action, primary = false, disabled = false) =>
  `<button data-action="${action}" class="${primary ? "primary" : ""}" ${disabled ? "disabled" : ""}>${label}</button>`;
const badge = (status) =>
  ({
    verified: '<span class="badge green"><i class="dot"></i>已验证登录</span>',
    expired: '<span class="badge amber"><i class="dot"></i>需要重新登录</span>',
    unverified: '<span class="badge"><i class="dot"></i>未验证</span>',
    connected: '<span class="badge green"><i class="dot"></i>已连接本机</span>',
  })[status];
const server = () => data.servers.find((s) => s.id === state.server);
const targetName = () =>
  state.target === "new" ? state.name : "GitHub 工作账号";
const identity = () => state.identities.find((i) => i.id === state.selectedId);
const total = () =>
  data.sites
    .filter((s) => state.selected.has(s.domain))
    .reduce((n, s) => n + s.count, 0);
const profileOptions = () =>
  data.profiles
    .map(
      (p) => `<option ${p === state.profile ? "selected" : ""}>${p}</option>`,
    )
    .join("");
const serverOptions = () =>
  data.servers
    .map(
      (s) =>
        `<option value="${s.id}" ${s.id === state.server ? "selected" : ""} ${!s.online ? "disabled" : ""}>${s.name} · ${s.host}${!s.online ? "（离线）" : ""}</option>`,
    )
    .join("");
const kv = (key, value) =>
  `<div class="key-value"><span>${key}</span><span>${value}</span></div>`;
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.style.display = "none"), 3500);
}
function shell(content) {
  return `<header class="topbar"><div class="flex"><div class="window-dots"><i></i><i></i><i></i></div><div class="logo">r</div><strong>Runweave</strong><span class="muted">/</span><span class="muted">browser-viewer</span></div><span class="badge"><i class="dot"></i>MacBook Pro</span></header>
  <div class="workspace"><aside class="sidebar"><div class="workspace-name">个人工作区</div><div class="section-label">工作台</div><div class="nav">⌘ &nbsp; 终端</div><div class="nav active">▣ &nbsp; Browser</div><div class="nav">◷ &nbsp; 定时任务</div><div class="section-label">当前项目</div><div class="nav">browser-viewer</div><div class="nav">agent-team-2</div><div class="section-label">连接</div><div class="nav">● &nbsp; 本机</div><div class="nav">● &nbsp; 开发服务器</div></aside><section class="content">${content}</section></div>`;
}
function renderReview() {
  document.title = "登录态 · 三套交互原型";
  app.innerHTML = `<section class="review" data-prototype-helper="true"><div class="flex"><div class="logo">r</div><strong>Runweave</strong><span class="muted">/ 交互原型 · 待评审</span></div><p class="eyebrow" style="margin-top:60px">BROWSER / SESSION PORTABILITY</p><h1>把已登录的网站，<br>带到需要它的地方。</h1><p class="review-intro">同一个目标，三种使用方式。先比较入口与操作成本，再决定首版范围。下面每套都可以直接操作。</p><div class="review-grid">
  <a class="review-card" href="?scheme=quick"><div class="mini quick"><div class="mini-bar"></div><div class="mini-box"></div></div><div><span class="eyebrow">A / 轻量工具</span><h2>当前网站，随手带走</h2><p>浏览器侧面板内导入、导出 cookie。适合临时迁移和已有服务器脚本的使用者。</p><span class="open">打开快捷导入导出 →</span></div></a>
  <a class="review-card" href="?scheme=send"><div class="mini send"><div class="mini-bar"></div><div class="mini-box">本机 &nbsp; → &nbsp; 服务器</div></div><div><span class="eyebrow">B / 任务向导</span><h2>送到服务器，再验证</h2><p>选网站、选服务器、确认导入并验证。把迁移中的关键选择集中在一条路径里。</p><span class="open">打开服务器迁移向导 →</span></div></a>
  <a class="review-card" href="?scheme=library"><div class="mini library"><div class="mini-bar"></div><div class="mini-box"></div><div class="mini-box"></div><div class="mini-box"></div></div><div><span class="eyebrow">C / 长期管理</span><h2>账号有归属，失效可恢复</h2><p>按网站和服务器管理多个身份，查看验证状态、更新 cookie、处理重新登录。</p><span class="open">打开登录态管理 →</span></div></a></div><p class="review-note">此页是原型选型入口，不进入产品界面。三套原型均使用虚构数据，不连接真实浏览器或服务器。A 的下载文件也只包含虚构 cookie。<br>建议优先看 B；A 可作为快捷入口，C 适合需要管理多个账号时再引入。</p></section>`;
}
function scopeRows() {
  return data.sites
    .map(
      (s) =>
        `<label class="check-row"><input type="checkbox" data-domain="${s.domain}" ${state.selected.has(s.domain) ? "checked" : ""}><div class="grow">${s.domain}<small>${s.label}</small></div><small>${s.count} 项</small></label>`,
    )
    .join("");
}
function renderQuick() {
  app.innerHTML =
    shell(`<div class="flex between"><div><h1>Browser</h1><p class="subhead">本机 · ${state.profile}</p></div><select aria-label="当前 Browser" id="profile" style="width:150px">${profileOptions()}</select></div>
  <div class="browser"><div class="browser-top"><div class="browser-tab">◉ &nbsp; GitHub · run-weave</div><div class="grow"></div><span class="muted">${state.profile}</span><span class="badge green">登录态</span></div><div class="address">⌑ &nbsp; https://github.com/acme/run-weave</div><div class="browser-body"><div class="website"><div class="repo-header">acme / <strong>run-weave</strong></div><div class="repo-tabs"><span>Code</span><span>Issues</span><span>Pull requests</span></div><div class="row"><span class="badge">main ⌄</span><div class="grow"></div><span class="muted">128 commits</span></div><div style="margin-top:20px">${[".github", "backend", "docs", "frontend", "packages", "README.md"].map((f, i) => `<div class="file-row"><span>▱ &nbsp; ${f}</span><span class="muted">${i + 1} days ago</span></div>`).join("")}</div><div class="panel" style="margin-top:25px"><h3>Runweave</h3><p class="muted" style="margin-top:8px">Your workspace for agents and browsers.</p></div></div>
  <aside class="login-panel"><div class="flex between"><h2>网站登录态</h2><span class="badge">${state.profile}</span></div><p class="subhead">github.com</p><div class="segmented">${button("导出", "tab-export")}${button("导入", "tab-import")}</div>${
    state.tab === "export"
      ? `
  <h3>选择网站范围</h3><div style="margin-top:10px">${scopeRows()}</div><label for="format">导出格式</label><select id="format"><option value="state">Playwright storage-state JSON</option><option value="array">Cookie JSON 数组</option></select><div class="notice">仅包含 cookie，不包含 localStorage 或 IndexedDB。文件可用于支持该格式的服务器工具。</div><div class="key-value"><span>已选择</span><span>${state.selected.size} 个域名 · ${total()} 项</span></div><button class="primary full" data-action="export" ${!total() ? "disabled" : ""}>导出 cookie 文件</button><p class="muted" style="font-size:11px;margin-top:12px">文件包含网站登录凭据，请保存在可信位置。</p>`
      : `
  <h3>导入到 ${state.profile}</h3><p class="subhead">选择文件后先预览，再写入当前 Browser。</p><div class="drop-zone">Cookie JSON / storage-state<input type="file" id="quick-file" accept=".json,application/json" aria-label="选择 cookie 文件"></div>${button("粘贴 JSON", "paste")}<div class="notice">仅更新同名、同域、同路径的 cookie，保留其他网站的数据。</div>${state.imported ? `${badge("unverified")}<p class="subhead">${state.imported} 项已导入 · 等待网站验证</p><button class="full" style="margin-top:20px" data-action="quick-verify">验证网站登录</button>` : ""}`
  }</aside></div></div>`);
  app.querySelector(`[data-action="tab-${state.tab}"]`).classList.add("active");
}
function steps() {
  return `<div class="steps">${["选择网站", "选择目标", "确认并验证"].map((s, i) => `<div class="step ${state.step >= i + 1 ? "active" : ""}"><b>${i + 1}</b>${s}</div>`).join("")}</div>`;
}
function renderSend() {
  app.innerHTML = shell(
    `<div><p class="eyebrow">BROWSER / 登录态</p><h1 style="margin-top:10px">发送到服务器</h1><p class="subhead">从本机选择网站，在指定服务器上使用。</p></div><div class="wizard">${steps()}<section class="panel ${state.busy ? "busy" : ""}">${state.result ? resultView() : state.step === 1 ? sourceView() : state.step === 2 ? targetView() : confirmView()}</section></div>`,
  );
}
function sourceView() {
  return `<div class="panel-head"><h2>选择要带走的网站</h2><span class="badge">01 / 03</span></div><label for="source-profile">来源 Browser</label><select id="source-profile">${profileOptions()}</select><div class="row"><div class="site-icon">G</div><div><h3>GitHub</h3><p class="muted">本机 · ${state.profile}</p></div></div>${scopeRows()}<div class="notice">此次迁移仅包含 cookie。部分网站还需要在服务器上重新登录。</div><div class="footer">${button("选择服务器 →", "next", true, !total())}</div>`;
}
function targetView() {
  return `<div class="panel-head"><h2>在哪里运行浏览器？</h2><span class="badge">02 / 03</span></div><label for="server">目标服务器</label><select id="server">${serverOptions()}</select><label for="mode">使用方式</label><select id="mode"><option value="copy" ${state.mode === "copy" ? "selected" : ""}>在服务器独立运行</option><option value="local" ${state.mode === "local" ? "selected" : ""}>服务器使用本机 Browser</option></select>${state.mode === "copy" ? `<label for="target">服务器身份</label><select id="target"><option value="new" ${state.target === "new" ? "selected" : ""}>新建独立身份</option><option value="existing" ${state.target === "existing" ? "selected" : ""}>更新 GitHub 工作账号</option></select>${state.target === "new" ? `<label for="identity-name">身份名称</label><input id="identity-name" value="${escape(state.name)}" maxlength="50">` : '<div class="notice amber">将覆盖此身份内匹配的 cookie。服务器上刷新过的登录态可能比本机更新。</div>'}<div class="notice">服务器保存自己的登录态；本机离线后仍可运行。以后需手动更新。</div>` : `<div class="notice amber">Browser 继续运行在本机。本机必须在线；此操作不会复制 cookie 到服务器。</div>`}<div class="footer">${button("上一步", "back")}${button("查看确认信息 →", "next", true)}</div>`;
}
function confirmView() {
  return `<div class="panel-head"><h2>${state.mode === "copy" ? "确认导入范围" : "确认连接"}</h2><span class="badge">03 / 03</span></div><div class="route"><div><small>来源</small><strong style="margin-top:8px">本机 · ${state.profile}</strong><small>${[...state.selected].join("、")}</small></div><span class="muted">→</span><div><small>目标</small><strong style="margin-top:8px">${server().name}</strong><small>${state.mode === "copy" ? escape(state.target === "new" ? state.name : "GitHub 工作账号") : "使用本机 Browser"}</small></div></div>${kv("运行位置", state.mode === "copy" ? server().name : "本机 MacBook Pro")}${kv("数据范围", state.mode === "copy" ? `${total()} 项 cookie` : "不传输 cookie")}${state.mode === "copy" ? `${kv("写入方式", state.target === "new" ? "新建独立身份" : "合并并覆盖匹配项")}${kv("网站验证", "github.com/settings/profile")}<div class="notice${state.target === "existing" ? " amber" : ""}">${state.target === "existing" ? "更新可能替换服务器当前账号。其他网站的数据保持不变。" : "导入后会验证网站是否认可登录。需要额外验证时，你可以打开服务器浏览器继续登录。"}</div>` : '<div class="notice amber">本机断线后，此连接不可用。</div>'}<div class="footer">${button("上一步", "back")}${button(state.busy ? "处理中…" : state.mode === "copy" ? "导入并验证" : "连接本机 Browser", "transfer", true, state.busy)}</div>`;
}
function resultView() {
  const result = state.result;
  return `<div class="center"><div class="success-mark">${result === "expired" ? "!" : result === "unverified" ? "○" : "✓"}</div><h2>${result === "connected" ? "已连接本机 Browser" : result === "verified" ? "服务器登录已验证" : result === "expired" ? "已导入，需要重新登录" : "已导入，暂时无法确认登录"}</h2><p class="subhead">${server().name} · ${state.mode === "copy" ? escape(targetName()) : state.profile}</p><div style="margin-top:16px">${badge(result)}</div></div><div style="margin-top:24px">${kv("数据传输", result === "connected" ? "未复制 cookie" : `${total()} 项 cookie 已导入`)}${kv("登录证据", result === "verified" ? "账号页面 · @alex-work" : result === "connected" ? "Browser 通道已连接" : "未获得网站账号信息")}${kv("运行位置", result === "connected" ? "本机 MacBook Pro" : server().name)}</div>${result === "expired" ? '<div class="notice amber">网站要求重新验证身份。打开服务器浏览器完成登录后再验证。</div>' : result === "unverified" ? '<div class="notice">数据写入已完成，但未识别到登录账号。可打开浏览器检查。</div>' : ""}<div class="footer">${button("返回网站选择", "restart")}${result === "connected" ? "" : button(result === "verified" ? "查看服务器身份" : "打开浏览器继续登录", result === "verified" ? "show-transferred" : "recover", true)}</div>`;
}
function renderLibrary() {
  const list = state.identities.filter(
    (i) =>
      (state.filter === "all" || i.status === state.filter) &&
      `${i.name} ${escape(i.domain)} ${i.server}`
        .toLowerCase()
        .includes(state.query.toLowerCase()),
  );
  if (list.length && !list.some((i) => i.id === state.selectedId))
    state.selectedId = list[0].id;
  const item = identity();
  app.innerHTML = shell(
    `<div class="flex between"><div><p class="eyebrow">BROWSER / IDENTITIES</p><h1 style="margin-top:10px">登录态</h1><p class="subhead">每个账号都有独立的服务器身份。</p></div>${button("＋ 导入登录态", "library-import", true)}</div><div class="stats"><div class="stat"><b>${state.identities.length}</b> 个身份<small>分布于 2 台服务器</small></div><div class="stat"><b>${state.identities.filter((i) => i.status === "verified").length}</b> 已验证<small>已获得网站账号信息</small></div><div class="stat"><b style="color:var(--amber)">${state.identities.filter((i) => i.status === "expired").length}</b> 需处理<small>网站要求重新登录</small></div></div><div class="filters"><input id="search" aria-label="搜索身份" placeholder="搜索网站、身份或服务器…" value="${escape(state.query)}"><select id="status-filter" aria-label="筛选状态">${[
      ["all", "全部状态"],
      ["verified", "已验证登录"],
      ["expired", "需要重新登录"],
      ["unverified", "未验证"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${state.filter === v ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select><span class="muted grow" style="font-size:12px;text-align:right">${list.length} 个身份</span></div><div class="identity-layout"><div>${list.length ? list.map((i) => `<button class="identity-card ${i.id === state.selectedId ? "selected" : ""}" data-identity="${i.id}"><span class="site-icon">${i.site[0]}</span><div class="grow"><strong>${escape(i.name)}</strong><p>${escape(i.domain)} &nbsp; · &nbsp; ${i.server}</p></div>${badge(i.status)}</button>`).join("") : '<div class="panel empty">没有匹配的身份</div>'}</div><aside class="panel detail"><div class="flex between"><div class="site-icon">${escape(item.site[0])}</div>${badge(item.status)}</div><h2>${escape(item.name)}</h2><p class="muted" style="font-size:12px">${escape(item.domain)}</p><div style="margin:22px 0">${kv("所在服务器", item.server)}${kv("网站账号", item.status === "verified" ? item.account : "未确认")}${kv("保存范围", `${item.count} 项 cookie`)}${kv("最近验证", item.status === "verified" ? "今天 10:42" : "尚未验证成功")}</div>${item.status === "expired" ? '<div class="notice amber">网站要求重新登录。依赖此身份的任务需要等待登录恢复。</div>' : ""}<div class="stack">${button(item.status === "verified" ? "打开服务器浏览器" : "打开浏览器继续登录", "recover", true)}${button("重新验证", "verify-identity")}${button("更新 cookie", "update-identity")}${button("导出 cookie", "export-identity")}</div></aside></div>`,
  );
}
function render() {
  document.querySelector("#toast").style.display = "none";
  (
    ({ quick: renderQuick, send: renderSend, library: renderLibrary })[
      scheme
    ] || renderReview
  )();
}
function openDialog(title, content) {
  dialog.innerHTML = `<div class="dialog-top"><h2 id="dialog-title">${title}</h2><button data-action="close-dialog" aria-label="关闭">×</button></div><div class="dialog-body">${content}</div>`;
  if (!dialog.open) dialog.showModal();
}
function openImport(updating = false) {
  state.error = "";
  state.importContext = updating
    ? "update"
    : scheme === "library"
      ? "new"
      : "quick";
  openDialog(
    updating ? "更新 cookie" : "导入 cookie",
    `${scheme === "library" ? `<label for="import-server">目标服务器</label><select id="import-server" ${updating ? "disabled" : ""}>${updating ? `<option>${identity().server}</option>` : serverOptions()}</select><label for="import-name">身份名称</label><input id="import-name" value="${updating ? escape(identity().name) : "新的网站账号"}" ${updating ? "disabled" : ""}>` : `<p class="muted">目标：本机 · ${state.profile}</p>`}<div class="drop-zone">选择 JSON 文件<input type="file" id="dialog-file" accept=".json,application/json" aria-label="选择导入文件"></div><label for="json-input">或粘贴 JSON</label><textarea id="json-input" placeholder='[{"name":"…","value":"…","domain":"…","path":"/"}]' spellcheck="false"></textarea><div id="import-error" role="alert"></div><div class="footer">${button("取消", "close-dialog")}${button("预览导入", "preview-import", true)}</div>`,
  );
}
function parseImport(raw) {
  const obj = JSON.parse(raw);
  const cookies = Array.isArray(obj) ? obj : obj.cookies;
  if (!Array.isArray(cookies) || !cookies.length)
    throw new Error("未找到 cookie。请选择 JSON 数组或含 cookies 的对象。");
  if (
    cookies.some(
      (c) =>
        !c ||
        typeof c.name !== "string" ||
        typeof c.value !== "string" ||
        typeof c.domain !== "string" ||
        !c.domain ||
        typeof c.path !== "string",
    )
  )
    throw new Error("每项 cookie 需要 name、value、domain 和 path 字段。");
  const expired = cookies.filter(
    (c) => c.expires > 0 && c.expires < Date.now() / 1000,
  ).length;
  const unsupported = cookies.filter(
    (c) => c.partitionKey || c.partitioned,
  ).length;
  if (unsupported)
    throw new Error(
      `${unsupported} 项包含分区属性，当前导入格式不支持。未写入数据。`,
    );
  return {
    cookies: cookies.filter(
      (c) => !(c.expires > 0 && c.expires < Date.now() / 1000),
    ),
    expired,
    origins:
      !Array.isArray(obj) &&
      Array.isArray(obj.origins) &&
      obj.origins.length > 0,
  };
}
function previewImport() {
  try {
    const raw = dialog.querySelector("#json-input").value;
    state.importPreview = parseImport(raw);
    state.importServer = dialog.querySelector("#import-server")?.value;
    state.importName =
      dialog.querySelector("#import-name")?.value.trim() || "网站账号";
    const p = state.importPreview;
    if (!p.cookies.length)
      throw new Error("所有 cookie 均已过期，没有可导入的条目。");
    openDialog(
      "确认导入",
      `<p class="muted">${state.importContext === "quick" ? `本机 · ${state.profile}` : state.importContext === "update" ? `${identity().server} · ${escape(identity().name)}` : `${data.servers.find((s) => s.id === state.importServer).name} · ${escape(state.importName)}`}</p><div style="margin-top:20px">${[...new Set(p.cookies.map((c) => c.domain))].map((d) => kv(escape(d), `${p.cookies.filter((c) => c.domain === d).length} 项`)).join("")}${kv("跳过已过期", `${p.expired} 项`)}</div><div class="notice${state.importContext === "update" ? " amber" : ""}">${state.importContext === "update" ? "覆盖匹配的 cookie 可能替换服务器当前账号。其他网站保持不变。" : "合并匹配项，不清空其他网站数据。"}${p.origins ? "<br>文件中的站点存储不会导入，本次仅处理 cookie。" : ""}</div><div class="footer">${button("取消", "close-dialog")}${button(`导入 ${p.cookies.length} 项 cookie`, "apply-import", true)}</div>`,
    );
  } catch (error) {
    dialog.querySelector("#import-error").innerHTML =
      `<div class="notice error">${escape(error instanceof SyntaxError ? "JSON 格式不正确，请检查后重试。" : error.message)}</div>`;
  }
}
function applyImport() {
  const cookies = state.importPreview.cookies;
  if (state.importContext === "quick") state.imported = cookies.length;
  else if (state.importContext === "update") {
    identity().status = "unverified";
    identity().count = cookies.length;
  } else {
    const domain = cookies[0].domain.replace(/^\./, "");
    const item = {
      id: `import-${Date.now()}`,
      site: domain,
      name: state.importName,
      domain,
      server: data.servers.find((s) => s.id === state.importServer).name,
      account: "未确认",
      count: cookies.length,
      status: "unverified",
    };
    state.identities.push(item);
    state.selectedId = item.id;
    state.query = "";
    state.filter = "all";
  }
  dialog.close();
  render();
  toast("cookie 已导入，登录状态尚未验证");
}
function downloadCookies(cookies, format = "array") {
  const content = format === "state" ? { cookies, origins: [] } : cookies;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `prototype-cookies.${format === "state" ? "storage-state." : ""}json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("cookie 文件已导出");
}
function openRecovery() {
  const site = scheme === "library" ? identity().domain : "github.com";
  if (scheme === "library" && identity().status === "verified") {
    openDialog(
      "服务器浏览器",
      `<p class="muted">${identity().server} · ${escape(site)}</p><div class="viewer"><div><div class="site-icon" style="margin:0 auto 14px">${escape(identity().site[0])}</div><h3>${escape(identity().account)}</h3><p>账号设置 · 已登录</p></div></div><div class="footer">${button("关闭", "close-dialog")}</div>`,
    );
    return;
  }
  openDialog(
    "服务器浏览器",
    `<p class="muted">${scheme === "library" ? identity().server : server().name} · ${escape(site)}</p><div class="notice">自动操作已暂停。登录完成后会先验证网站账号，再恢复使用。</div><div class="viewer"><div><div class="site-icon" style="margin:0 auto 14px">${site[0].toUpperCase()}</div><h3>确认你的登录</h3><p style="margin-top:10px">请在已登录设备上批准此次请求。</p></div></div><p class="muted" style="font-size:12px">等待网站确认身份…</p><div class="footer">${button("稍后处理", "close-dialog")}${button("我已登录，重新验证", "finish-recovery", true)}</div>`,
  );
}
const verificationStatus = () =>
  data.verification[params.get("verify")] || data.verification.default;
async function verifyRecovery() {
  const btn = dialog.querySelector('[data-action="finish-recovery"]');
  btn.disabled = true;
  btn.textContent = "验证中…";
  await new Promise((r) => setTimeout(r, 500));
  const result = params.get("recover") === "fail" ? "expired" : "verified";
  if (scheme === "library") {
    identity().status = result;
    identity().account = result === "verified" ? "@alex-work" : "未确认";
  } else state.result = result;
  dialog.close();
  render();
  toast(
    result === "verified"
      ? "网站账号已确认，登录态已保存"
      : "尚未获得登录证据，请完成网站验证",
  );
}
async function handleAction(action) {
  if (action === "close-dialog") return dialog.close();
  if (action === "tab-export" || action === "tab-import") {
    state.tab = action.slice(4);
    render();
  }
  if (action === "export")
    downloadCookies(
      data.cookies.filter((c) => state.selected.has(c.domain)),
      document.querySelector("#format").value,
    );
  if (action === "paste" || action === "library-import") openImport();
  if (action === "preview-import") previewImport();
  if (action === "apply-import") applyImport();
  if (action === "next") {
    if (
      state.step === 2 &&
      state.mode === "copy" &&
      state.target === "new" &&
      !state.name.trim()
    )
      return toast("请输入身份名称");
    state.step++;
    render();
  }
  if (action === "back") {
    state.step--;
    render();
  }
  if (action === "transfer") {
    state.busy = true;
    render();
    await new Promise((r) => setTimeout(r, 650));
    state.busy = false;
    state.result = state.mode === "local" ? "connected" : verificationStatus();
    render();
  }
  if (action === "restart") {
    state.step = 1;
    state.result = null;
    render();
  }
  if (action === "recover") openRecovery();
  if (action === "finish-recovery") await verifyRecovery();
  if (action === "show-transferred")
    openDialog(
      "服务器身份",
      `${kv("名称", escape(targetName()))}${kv("服务器", server().name)}${kv("网站账号", "@alex-work")}${kv("网站范围", [...state.selected].join("、"))}<div class="notice">已保存独立登录态，可供后续服务器任务使用。</div><div class="footer">${button("关闭", "close-dialog")}</div>`,
    );
  if (action === "verify-identity") {
    identity().status = verificationStatus();
    identity().account =
      identity().status === "verified" ? "@alex-work" : "未确认";
    render();
    toast(
      identity().status === "verified"
        ? "网站登录已验证"
        : "尚未确认登录，请打开浏览器检查",
    );
  }
  if (action === "update-identity") openImport(true);
  if (action === "export-identity")
    downloadCookies(
      Array.from({ length: identity().count }, (_, i) => ({
        ...data.cookies[0],
        name: `prototype_cookie_${i + 1}`,
        domain: identity().domain,
      })),
    );
  if (action === "quick-verify")
    openDialog(
      "网站登录验证",
      `<div class="center">${badge(verificationStatus())}<h3 style="margin-top:20px">${verificationStatus() === "verified" ? "已确认账号 @alex-work" : "尚未获得网站登录证据"}</h3><p class="subhead">本机 · ${state.profile} · github.com</p></div><div class="footer">${button("关闭", "close-dialog")}</div>`,
    );
}
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action],[data-identity]");
  if (!target) return;
  if (target.dataset.identity) {
    state.selectedId = target.dataset.identity;
    render();
    return;
  }
  handleAction(target.dataset.action);
});
document.addEventListener("change", async (event) => {
  const el = event.target;
  if (el.dataset.domain) {
    el.checked
      ? state.selected.add(el.dataset.domain)
      : state.selected.delete(el.dataset.domain);
    render();
  }
  if (["profile", "source-profile"].includes(el.id)) {
    state.profile = el.value;
    state.imported = null;
    render();
  }
  if (["server", "target", "mode"].includes(el.id)) {
    state[el.id] = el.value;
    render();
  }
  if (el.id === "status-filter") {
    state.filter = el.value;
    render();
  }
  if (el.id === "dialog-file" || el.id === "quick-file") {
    const file = el.files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) {
      toast("请选择小于 1 MB 的 JSON 文件");
      return;
    }
    const raw = await file.text();
    if (el.id === "quick-file") openImport();
    dialog.querySelector("#json-input").value = raw;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "identity-name") state.name = event.target.value;
  if (event.target.id === "search") {
    const pos = event.target.selectionStart;
    state.query = event.target.value;
    render();
    const input = document.querySelector("#search");
    input.focus();
    input.setSelectionRange(pos, pos);
  }
});
render();
