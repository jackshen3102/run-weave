const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const icons = {
  branch: '<path d="M6 3v11a4 4 0 0 0 4 4h3M6 7h8a4 4 0 0 0 4-4"/><circle cx="6" cy="3" r="2"/><circle cx="16" cy="18" r="2"/><circle cx="18" cy="3" r="2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  folder: '<path d="M3 6h7l2 2h9v12H3z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
};
const icon = (name, cls = '') => `<svg aria-hidden="true" class="${cls}" viewBox="0 0 24 24">${icons[name]}</svg>`;
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let data;
let selectedId = params.get('context') || 'wt-1';
let activeTab = params.get('view') === 'changes' ? 'changes' : 'updates';
let closed = false;
let expanded = false;
let refreshing = false;
let stale = params.get('state') === 'stale';
let requestGeneration = 0;

function currentContext() {
  return data.contexts.find((context) => context.id === selectedId) || data.contexts[1];
}

function behindCount() {
  return params.get('state') === 'empty' ? 0 : currentContext().behind;
}

function renderUpdates() {
  const context = currentContext();
  const count = behindCount();
  const list = data.commits.slice(0, Math.min(count, 10));
  return `<div class="summary">
    <div class="summary-title"><h1>${icon('branch')}主分支更新</h1><button class="refresh" id="refresh" ${refreshing ? 'disabled' : ''}>${icon('refresh', refreshing ? 'spin' : '')}${refreshing ? '检查中…' : '刷新'}</button></div>
    <div class="compare"><span class="branch mono">${icon('branch')}origin/main</span>${icon('arrow')}<span class="branch mono" title="${escape(context.branch)}">${escape(context.branch)}</span></div>
    <div class="countline"><span>${count ? `当前分支尚未包含 <b>${count}</b> 个提交` : '没有待同步提交'}</span><span class="checktime">${refreshing ? '正在检查主分支…' : `${stale ? '上次成功检查' : '检查于'} ${escape(data.checkedAt)}`}</span></div>
  </div>
  ${stale ? '<div class="notice" role="status">暂时无法更新主分支，以下为上次检查结果。</div>' : ''}
  ${count ? `<div class="day">${escape(data.date)}<span style="float:right">最新 ${list.length} 条</span></div><ol class="commits">${list.map((commit) => `<li class="commit"><div class="graph"></div><div><div class="subject">${escape(commit.title)}</div><div class="commit-meta"><span class="sha mono">${escape(commit.sha)}</span><span class="divider"></span><span>${escape(commit.author)}</span><time style="margin-left:auto">${escape(commit.time)}</time></div></div></li>`).join('')}</ol><div class="listfooter">${count > 10 ? `共 ${count} 条，展示最新 10 条` : `已展示全部 ${count} 条提交`}</div>` : `<div class="empty"><span class="empty-icon">${icon('check')}</span><strong>没有待同步提交</strong><p>当前分支已包含 origin/main 的全部提交</p></div>`}`;
}

function renderOtherTab() {
  if (activeTab === 'changes') return `<div class="summary"><h1>Review changes</h1></div><div class="empty"><span class="empty-icon">${icon('check')}</span><strong>没有未提交的文件变更</strong></div>`;
  if (activeTab === 'explorer') return `<div class="summary"><h1>Explorer</h1><div style="line-height:2.8;margin-top:18px;color:#94a3b8" class="mono">▸ backend<br>▸ frontend<br>▸ packages<br>▸ docs<br>　package.json</div></div>`;
  return '<div class="empty"><strong>未选择文件</strong></div>';
}

function render() {
  const context = currentContext();
  const count = behindCount();
  app.className = `app ${expanded ? 'expanded' : ''}`;
  app.innerHTML = `<header class="titlebar"><span class="lights"><i></i><i></i><i></i></span><strong>Runweave</strong><span class="crumb">Runweave / ${escape(context.id)}</span><span class="connection"><span class="dot"></span>MacBook Pro</span></header>
  <div class="projectbar"><span class="projecticon">${icon('folder')}</span><strong>Runweave</strong>${icon('chevron')}<span class="path mono">~/Code/browser-hub/browser-viewer</span><span class="right">本机 ${icon('chevron')}</span></div>
  <div class="workspace"><aside class="rail"><div class="railheading">WORKSPACES<span>⌄</span></div>${data.contexts.map((item) => `<div class="context ${item.id === context.id ? 'active' : ''}"><div class="context-title" data-context="${item.id}" role="button" tabindex="0" aria-label="切换到 ${item.name}" aria-pressed="${item.id === context.id}">${icon('branch')}<span>${item.name}</span></div><div class="context-sub"><span>${item.sessions} 个终端</span><button class="branch-link ${item.behind ? '' : 'synced'}" data-open-context="${item.id}" aria-label="查看 ${item.name} 的主分支更新">main ${item.behind ? `↓${item.behind}` : '✓'}</button></div></div>`).join('')}</aside>
  <section class="terminal"><header class="terminalbar"><span class="dot"></span><strong>Codex</strong><span class="tag">${escape(context.id)}</span><button id="open-preview" aria-label="打开 Preview">${icon('folder')}</button></header>
    <div class="terminal-content mono"><p><span class="prompt">❯</span> <span class="cmd">git branch --show-current</span><br>${escape(context.branch)}</p><p><span class="prompt">❯</span> <span class="cmd">git status --short</span><br><span class="output"> </span></p><p><span class="prompt">❯</span> <span class="cmd">git rev-parse --short HEAD</span><br>${escape(context.head)}</p><div class="agent-title"><span class="agent-square">✦</span> Codex</div><p class="output">~/Code/browser-hub/browser-viewer<br>${escape(context.id)} · ${escape(context.branch)}</p><p><span class="prompt">❯</span> <span style="display:inline-block;width:7px;height:14px;background:#94a3b8;vertical-align:middle"></span></p></div>
    <div class="terminal-bottom"><span>输入消息…</span><div class="bottomrow"><span><span class="key">＋</span>　Codex　⌄</span><span>↵</span></div></div>
  </section>
  <aside class="sidecar ${closed ? 'closed' : ''}" aria-label="Preview"><header class="tools"><span class="tool active">Preview</span><span class="tool secondary">Automation</span><span class="tool secondary">Browser 1</span><span class="tool secondary">任务监控</span><span class="spacer"></span><button class="iconbtn" id="expand" aria-label="${expanded ? '还原 Preview' : '展开 Preview'}">${icon('expand')}</button><button class="iconbtn" id="close" aria-label="关闭 Preview">${icon('close')}</button></header>
  <nav class="subtabs" role="tablist" aria-label="Preview 视图">${[['changes','Changes'],['explorer','Explorer'],['file','Files'],['updates','主分支更新']].map(([id,label]) => `<button role="tab" class="tab" data-tab="${id}" aria-selected="${activeTab === id}" aria-controls="preview-panel">${label}${id === 'updates' && count ? `<span class="tab-count">${count}</span>` : ''}</button>`).join('')}</nav>
  <section class="panel" id="preview-panel" role="tabpanel" aria-label="${activeTab === 'updates' ? '主分支更新' : activeTab}">${activeTab === 'updates' ? renderUpdates() : renderOtherTab()}</section></aside></div>
  <footer class="statusbar"><span class="mono">${icon('branch')} ${escape(context.branch)}</span><span class="mono">${escape(context.head)}</span><span class="end">MacBook Pro　<span style="color:#34d399">●</span> 已连接</span></footer>`;
}

async function refresh() {
  if (refreshing) return;
  const generation = ++requestGeneration;
  refreshing = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 850));
  if (generation !== requestGeneration) return;
  refreshing = false;
  stale = params.get('refresh') === 'error';
  if (!stale) data.checkedAt = new Date().toLocaleTimeString('zh-CN', {hour:'2-digit', minute:'2-digit'});
  render();
}

app.addEventListener('click', (event) => {
  const contextLink = event.target.closest('[data-open-context]');
  const contextRow = event.target.closest('[data-context]');
  if (contextLink || contextRow) {
    selectedId = (contextLink || contextRow).dataset[contextLink ? 'openContext' : 'context'];
    requestGeneration++;
    refreshing = false;
    stale = params.get('state') === 'stale';
    if (contextLink) { activeTab = 'updates'; closed = false; }
    render();
    return;
  }
  const tab = event.target.closest('[data-tab]');
  if (tab) { activeTab = tab.dataset.tab; render(); app.querySelector(`[data-tab="${activeTab}"]`).focus(); return; }
  if (event.target.closest('#refresh')) { void refresh(); return; }
  if (event.target.closest('#close')) { closed = true; expanded = false; }
  else if (event.target.closest('#expand')) expanded = !expanded;
  else if (event.target.closest('#open-preview')) closed = false;
  else return;
  render();
});
app.addEventListener('keydown', (event) => {
  if (event.target.closest('[data-context]') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.target.click(); }
  if (event.target.matches('[role="tab"]') && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
    event.preventDefault();
    const tabs = [...app.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(event.target);
    tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length].click();
  }
});
fetch('./mock-state.json').then((response) => { if (!response.ok) throw new Error('无法读取原型数据'); return response.json(); }).then((state) => { data = state; render(); }).catch((error) => { app.textContent = error.message; });
