const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const icons = {
  back:'<path d="m15 4-8 8 8 8"/>', chevron:'<path d="m9 6 6 6-6 6"/>',
  down:'<path d="m6 9 6 6 6-6"/>', refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  branch:'<circle cx="6" cy="4" r="2"/><circle cx="18" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M18 6v2a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4"/>',
  arrow:'<path d="M4 12h16m-5-5 5 5-5 5"/>', check:'<path d="m5 12 4 4L19 6"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  more:'<circle cx="4" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="20" cy="12" r="1"/>',
  circleMore:'<circle cx="12" cy="12" r="10"/><path d="M7 12h.1M12 12h.1M17 12h.1"/>',
  settings:'<circle cx="12" cy="12" r="4"/><path d="m9 2 6 0 1 4 4 1 2 5-3 3 1 4-5 3-3-2-4 1-3-5 1-3-3-3 2-5 4-1z"/>',
  wifi:'<path d="M2 8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M9 16a5 5 0 0 1 6 0M12 20h.1"/>',
  signal:'<path d="M3 20v-3M9 20v-7M15 20V9M21 20V4"/>',
  computer:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 11v6M12 7h.1"/>',
};
const icon = (name, cls='') => `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls}">${icons[name]}</svg>`;
const escape = (value) => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let data;
let route = {page:params.get('screen') === 'updates' ? 'updates' : params.get('screen') === 'terminal' ? 'terminal' : 'home', terminalId:params.get('terminal') || 'source', parent:'home'};
let menuOpen = false;
let query = '';
let refreshing = false;
let requestGeneration = 0;
const positions = new Map();
const snapshots = new Map();
const terminal = () => data.terminals.find(item => item.id === route.terminalId) || data.terminals[0];
const context = () => data.contexts.find(item => item.id === terminal().context);
const count = () => params.get('state') === 'empty' ? 0 : context().behind;
const snapshot = () => snapshots.get(route.terminalId) || {time:data.checkedAt,stale:params.get('state') === 'stale'};
const statusbar = () => `<div class="statusbar" aria-hidden="true"><span>9:41</span><span class="island"></span><span class="status-icons">${icon('signal')}${icon('wifi')}<span class="battery"><i></i></span></span></div>`;
const navbar = (title,back,right='') => `<nav class="nav" aria-label="页面导航"><button class="back" id="back" aria-label="返回${back}">${icon('back')}<span>${back}</span></button><div class="navtitle">${title}</div><div class="nav-right">${right}</div></nav>`;
function homeRows() {
  const items = data.terminals.filter(item => `${item.title} ${item.context}`.toLowerCase().includes(query.toLowerCase()));
  return items.length ? items.map(item => {
    const c = data.contexts.find(c => c.id === item.context);
    return `<article class="terminal-row"><button class="terminal-main" data-terminal="${item.id}" aria-label="打开终端：${item.title}"><span class="row-title"><strong>${escape(item.title)}</strong><span class="state ${item.status === '等待输入' ? 'waiting' : ''}"><i></i>${escape(item.status)}</span></span></button><div class="row-context"><span class="context-name">Runweave · ${c.id}</span><button class="branch-button ${c.behind ? '' : 'synced'}" data-updates="${item.id}" aria-label="查看${item.title}的主分支更新">main ${c.behind ? `↓${c.behind}` : '✓'}${icon('chevron')}</button></div><div class="preview-line">最近输入：${escape(item.userText)}</div><div class="preview-line">最近回复：${escape(item.agentText)}</div></article>`;
  }).join('') : '<div class="no-results">没有找到匹配的项目或终端</div>';
}
function home() {
  return `<div class="homebar"><span class="computer"><span class="online"></span>MacBook Pro ${icon('down')}</span><span class="homeactions">${icon('circleMore')}${icon('settings')}</span></div><div class="content" id="scroll"><h1 class="large-title">Runweave</h1><label class="search">${icon('search')}<input id="search" aria-label="搜索项目和终端" placeholder="Search projects and terminals" value="${escape(query)}"></label><h2 class="section-label">关注</h2><section class="group" id="terminal-list" aria-label="关注的终端">${homeRows()}</section><div class="projecthead"><div><span class="name">${icon('down')}Runweave</span><span class="path mono">~/Code/browser-hub/browser-viewer</span></div><span>3　＋</span></div><div class="group"><div class="project-row">源码变更视图<span class="count">等待输入</span></div><div class="project-row">终端焦点修复<span class="count">已完成</span></div></div></div>`;
}
function updates() {
  const c=context(), n=count(), snap=snapshot();
  const commits=data.commits.slice(0,Math.min(n,10));
  return `${navbar('主分支更新',route.parent === 'terminal' ? '终端' : 'Runweave',`<button class="navbutton" id="refresh" aria-label="${refreshing ? '正在刷新' : '刷新主分支更新'}" ${refreshing ? 'disabled' : ''}>${icon('refresh',refreshing ? 'spin' : '')}</button>`)}<div class="content" id="scroll"><div class="detail-top"><div class="source">${icon('computer')}MacBook Pro</div><div class="workspace-label">${icon('branch')}Runweave <span style="color:#636366;font-weight:400">/</span> ${escape(c.id)}</div><div class="branch-pair"><span class="ref mono">origin/main</span>${icon('arrow')}<span class="ref mono">${escape(c.branch)}</span></div></div><section class="summary" aria-label="更新状态"><div class="summary-main">${n ? `当前分支尚未包含<strong>${n}</strong>个提交` : '没有待同步提交'}</div><div class="summary-meta"><span>${n ? `展示最新 ${commits.length} 条` : '已包含主分支全部提交'}</span><span id="checked-time">${refreshing ? '正在检查…' : `${snap.stale ? '上次成功检查' : '检查于'} ${escape(snap.time)}`}</span></div></section>${snap.stale ? '<div class="notice" role="status">暂时无法更新主分支，以下为上次检查结果。</div>' : ''}${n ? `<section class="commit-section"><div class="list-label"><span>${escape(data.date)}</span><span>由新到旧</span></div><ol class="commit-list">${commits.map(commit => `<li class="commit"><span class="graph"></span><div><div class="subject">${escape(commit.title)}</div><div class="commit-meta"><span class="sha mono">${escape(commit.sha)}</span><span>·</span><span>${escape(commit.author)}</span><time>${escape(commit.time)}</time></div></div></li>`).join('')}</ol><div class="footer-note">${n > 10 ? `共 ${n} 条，展示最新 10 条` : `已展示全部 ${n} 条提交`}</div></section>` : `<section class="empty"><div class="empty-icon">${icon('check')}</div><h2>没有待同步提交</h2><p>当前分支已包含 origin/main 的全部提交</p></section>`}</div>`;
}
function terminalView() {
  return `${navbar(escape(terminal().title),'Runweave',`<button class="navbutton" id="open-menu" aria-label="终端操作" aria-expanded="${menuOpen}">${icon('more')}</button>`)}<div class="terminal-tabs"><span class="selected">终端</span><span>变更 <span style="font-size:10px">0</span></span><span>文件</span><span>快捷指令</span></div><div class="content" id="scroll"><div class="termoutput mono"><span class="mint">❯</span> git branch --show-current\n${escape(context().branch)}\n\n<span class="mint">❯</span> git status --short\n\n<span class="mint">❯</span> git rev-parse --short HEAD\n${escape(context().head)}\n\n<span class="mint">✦ Codex</span>\n\n~/Code/browser-hub/browser-viewer\n${escape(context().id)} · ${escape(context().branch)}\n\n<span class="mint">❯</span> ▏</div></div><div class="composer"><span>输入消息…</span><span>⌨</span></div>${menuOpen ? `<div class="menu-scrim" id="dismiss-menu"></div><section class="menu" aria-label="终端操作菜单"><div class="menu-label mono">~/Code/browser-hub/browser-viewer/.worktree/${escape(context().id)}</div><div class="menu-row static-row">Fork Thread ${icon('branch')}</div><div class="menu-row static-row">长任务监控 ${icon('info')}</div><button class="menu-row new" id="menu-updates">主分支更新 <span style="display:flex;align-items:center;gap:10px"><span style="color:#8e8e93;font-size:12px">${count() ? '↓'+count() : '✓'}</span>${icon('branch')}</span></button><div class="menu-row static-row">终端信息 ${icon('info')}</div><div class="menu-row static-row">终端历史</div><div class="menu-row static-row">分享终端快照</div></section>` : ''}`;
}
function positionKey() { return route.page === 'home' ? 'home' : `${route.page}:${route.terminalId}`; }
function rememberPosition() { const scroll=app.querySelector('#scroll'); if(scroll) positions.set(positionKey(),scroll.scrollTop); }
function render() {
  app.className=`device ${route.page === 'terminal' ? 'terminal-screen' : ''}`;
  app.innerHTML=`${statusbar()}${route.page === 'home' ? home() : route.page === 'updates' ? updates() : terminalView()}<div class="home-indicator" aria-hidden="true"></div>`;
  const scroll=app.querySelector('#scroll');
  if(scroll) scroll.scrollTop=positions.get(positionKey()) || 0;
}
function navigate(next,replace=false) {
  rememberPosition();
  requestGeneration++;
  refreshing=false;
  menuOpen=false;
  route={...next,depth:replace ? (route.depth || 0) : (route.depth || 0)+1};
  if(replace) history.replaceState(route,''); else history.pushState(route,'');
  render();
}
async function refresh() {
  if(refreshing)return;
  rememberPosition();
  const generation=++requestGeneration;
  refreshing=true;
  render();
  await new Promise(resolve => setTimeout(resolve,850));
  if(generation !== requestGeneration)return;
  rememberPosition();
  refreshing=false;
  const old=snapshot();
  snapshots.set(route.terminalId,params.get('refresh') === 'error' ? {...old,stale:true} : {time:new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}),stale:false});
  render();
}
app.addEventListener('click',event => {
  const updateButton=event.target.closest('[data-updates]');
  if(updateButton) { navigate({page:'updates',terminalId:updateButton.dataset.updates,parent:'home'});return; }
  const terminalButton=event.target.closest('[data-terminal]');
  if(terminalButton) { navigate({page:'terminal',terminalId:terminalButton.dataset.terminal,parent:'home'});return; }
  if(event.target.closest('#menu-updates')) { navigate({page:'updates',terminalId:route.terminalId,parent:'terminal'});return; }
  if(event.target.closest('#refresh')) { void refresh();return; }
  if(event.target.closest('#back')) { if(route.depth > 0) history.back(); else navigate({page:route.page === 'updates' ? route.parent : 'home',terminalId:route.terminalId,parent:'home'},true);return; }
  if(event.target.closest('#open-menu') || event.target.closest('#dismiss-menu')) {rememberPosition();menuOpen=!menuOpen;render();}
});
app.addEventListener('input',event => { if(event.target.id==='search') {query=event.target.value;app.querySelector('#terminal-list').innerHTML=homeRows();} });
app.addEventListener('keydown',event => {if(event.key==='Escape' && menuOpen){menuOpen=false;render();app.querySelector('#open-menu')?.focus();}});
window.addEventListener('popstate',event => { rememberPosition();requestGeneration++;refreshing=false;menuOpen=false;route=event.state || {page:'home',terminalId:'source',parent:'home'};render(); });
fetch('./mock-state.json').then(response => {if(!response.ok)throw new Error('无法读取原型数据');return response.json();}).then(state => {data=state;history.replaceState(route,'');render();}).catch(error => {app.textContent=error.message;});
