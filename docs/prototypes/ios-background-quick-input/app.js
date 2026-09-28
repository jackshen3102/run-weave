const root = document.querySelector("#prototype");
const params = new URLSearchParams(location.search);
const gallery = params.get("gallery") === "1";
const initialState = params.get("state") || "ready";

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const statusBar = `<div class="status-bar" aria-hidden="true"><span>9:41</span><div class="status-symbols">▂▄▆█ ◕ <span class="battery"><i></i></span></div></div>`;

function replyRow(item, state) {
  const active = item.canRunInBackground && state === "running";
  return `<div class="row" data-search-text="${escapeHtml(`${item.title} ${item.data}`.toLowerCase())}">
    <div class="row-inner">
      <button class="row-main" data-next="inserted" data-insert="${escapeHtml(item.data)}" aria-label="填入 ${escapeHtml(item.title)}">
        <strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.data)}</span>
      </button>
      <button class="row-menu" data-menu="true" aria-label="管理 ${escapeHtml(item.title)}">···</button>
    </div>
    ${item.canRunInBackground ? `<div class="run-line ${active ? "running" : ""}">
      ${active ? `<span>◉ ${escapeHtml(item.title)} · 后台运行中</span><button data-next="detail-running">查看运行 ›</button>`
        : `<button data-next="running">后台运行 ↗</button>`}
    </div>` : ""}
    <div class="menu" hidden><button>查看全文 / 编辑</button><button class="danger">删除</button></div>
    <div class="separator"></div>
  </div>`;
}

function replyLibrary(data, state) {
  return `<section class="sheet">
    <div class="grabber"></div>
    <div class="nav"><button class="nav-left" data-next="terminal">返回</button><div class="nav-title">快捷回复</div><button class="nav-right">排序</button><button class="nav-right" aria-label="新增">＋</button></div>
    <div class="search-wrap"><input class="search" type="search" placeholder="搜索标题或正文" aria-label="搜索标题或正文" /></div>
    <div class="list">${data.items.map((item) => replyRow(item, state)).join("")}</div>
  </section>`;
}

function runDetail(data, running) {
  const summary = running
    ? "正在核对工作区和 GitHub 状态。离开页面后任务会继续运行。"
    : escapeHtml(data.run.summary);
  return `<div class="detail-nav"><button data-next="${running ? "running" : "ready"}">‹ 返回</button><strong>运行详情</strong><i></i></div>
    <div class="detail">
      <div class="detail-title"><span>今天 14:29</span><em>${running ? "运行中" : "已完成"}</em></div>
      <div class="detail-body">
        <p>${escapeHtml(data.project)} / ${escapeHtml(data.worktree)} · 后台运行</p>
        <p class="summary">${running ? "创建 github pr · 正在执行" : escapeHtml(data.run.result)}</p>
        <p>${summary}</p>
        ${running ? "" : '<a href="https://github.com/jackshen3102/run-weave/pull/634" target="_blank" rel="noopener">查看 PR #634 ↗</a>'}
      </div>
      <div class="detail-header">本次运行</div>
      <button class="detail-option">本次配置快照 <span>›</span></button>
      <button class="detail-option" data-output="true">${running ? "查看运行进度" : "查看输出"} <span>›</span></button>
      <div class="log" hidden>${running
        ? "› 已确认 GitHub 账号与仓库访问\n› 正在核对工作区和目标分支"
        : "✓ 本地提交与推送完成\n✓ GitHub quality 检查通过\n✓ PR #634 已合并"}</div>
      ${running ? '<button class="detail-option" style="margin-top:20px;color:#e4a5a5">停止本次运行 <span>›</span></button>'
        : '<button class="detail-option" style="margin-top:20px">打开对话并继续追问 <span>›</span></button>'}
    </div>`;
}

function terminal(data, insertedText = "") {
  return `<div class="detail-nav"><button data-next="ready">‹ 返回</button><strong>browser-viewer / wt-1</strong><i></i></div>
    <div class="terminal"><code>Codex · browser-viewer<br /><br />Ready for your next instruction</code>
      <div class="composer">${insertedText ? escapeHtml(insertedText) : "输入命令…"}</div>
    </div>`;
}

function phone(data, state, insertedText = "") {
  const content = state === "result" || state === "detail-running"
    ? runDetail(data, state === "detail-running")
    : state === "inserted" || state === "terminal"
      ? terminal(data, insertedText)
      : replyLibrary(data, state);
  return `<div class="phone" data-state="${state}">${statusBar}${content}<div class="home" aria-hidden="true"></div></div>`;
}

function render(data) {
  if (gallery) {
    root.className = "gallery";
    root.innerHTML = [["点击前", "ready"], ["运行中", "running"], ["运行结果", "result"]]
      .map(([label, state]) => `<section class="gallery-panel"><div class="gallery-label" data-prototype-helper="true">${label}</div>${phone(data, state)}</section>`).join("");
  } else {
    root.className = "stage";
    root.innerHTML = phone(data, initialState);
  }

  root.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.menu) {
      const menu = button.closest(".row").querySelector(".menu");
      menu.hidden = !menu.hidden;
      return;
    }
    if (button.dataset.output) {
      const log = button.nextElementSibling;
      log.hidden = !log.hidden;
      return;
    }
    const next = button.dataset.next;
    if (!next) return;
    button.closest(".phone").outerHTML = phone(data, next, button.dataset.insert || "");
    if (!gallery) history.replaceState({}, "", `?state=${next}`);
  });

  root.addEventListener("input", (event) => {
    if (!event.target.matches(".search")) return;
    const query = event.target.value.trim().toLowerCase();
    event.target.closest(".sheet").querySelectorAll(".row").forEach((row) => {
      row.hidden = !row.dataset.searchText.includes(query);
    });
  });
}

fetch("mock-state.json")
  .then((response) => response.json())
  .then(render)
  .catch(() => { root.textContent = "原型数据未加载"; });
