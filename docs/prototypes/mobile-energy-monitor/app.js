/* Design-only local state. No Backend or process signals are used. */
const root = document.querySelector('#app');
const query = new URLSearchParams(location.search);
const data = await fetch('./mock-state.json').then(response => response.json());
const permissionKey = 'prototype.mobile-energy-monitor.remotePermission';
if (query.has('authorized')) localStorage.setItem(permissionKey, query.get('authorized') === '1' ? 'on' : 'off');
let authorized = localStorage.getItem(permissionKey) === 'on';
let screen = query.get('screen') || 'home';
let selectedApp = data.apps.find(item => item.id === query.get('app')) || data.apps[0];
let menuOpen = false;
let modal = null;
let message = '';
let alertsEnabled = true;
let monitorEnabled = query.get('state') !== 'disabled';
let alertSnoozed = false;
const sampleState = query.get('state') || 'ok';
const results = new Map();
const fresh = () => !['offline', 'stale', 'warming', 'error'].includes(sampleState) && monitorEnabled;
const canAct = () => authorized && fresh();
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const button = (action, text, className = '', attrs = '') => `<button data-action="${action}" class="${className}" ${attrs}>${text}</button>`;
const small = value => `<span class="caption">${value}</span>`;
const icon = app => `<span class="app-icon" style="background:${app.color}">${app.icon}</span>`;
function header(title, back = 'home', right = '') {
  return `<div class="statusbar"><span>9:41</span><span aria-hidden="true">▮▮▮　Wi-Fi　▰</span></div><header class="nav">${button(back,'‹ 返回')}<h1>${title}</h1>${right || '<span></span>'}</header>`;
}
function permissionNotice() {
  return authorized ? '' : `<div class="notice permission"><strong>远程结束权限未开启</strong><p>可查看排行。请在 ${data.host.name} 的 Runweave「提醒设置」中开启远程进程操作。</p></div>`;
}
function statusNotice() {
  const descriptions = {
    offline:['电脑已离线','显示最后一次采样，恢复连接后自动更新。当前不能结束进程。'],
    stale:['采样数据已过期','最近记录为 11:32，等待新采样。当前不能结束进程。'],
    warming:['正在准备采样','后台每分钟采样，首轮尚无有效的能耗排行。'],
    error:['采样失败','后台将重试。当前不能结束进程。']
  };
  if (!monitorEnabled) return `<div class="notice"><strong>后台监控已关闭</strong><p>重新开启后恢复采样和持续观察。</p>${button('settings','提醒设置','text-button')}</div>`;
  const description = descriptions[sampleState];
  return description ? `<div class="notice"><strong>${description[0]}</strong><p>${description[1]}</p></div>` : '';
}
function energy() {
  const ac = sampleState === 'ac';
  const blank = ['warming','error','unsupported'].includes(sampleState) || !monitorEnabled;
  const hostCard = `<div class="card padded"><div class="flex"><span class="host"><span class="dot">●</span> ${data.host.name}</span>${small(sampleState === 'offline' ? '离线 · 上次记录' : '当前电脑')}</div><div class="flex"><div><div class="battery-number">${blank ? '—' : data.host.battery+'<span style="font-size:23px">%</span>'}</div><div class="caption">${ac ? '已接电 · 正在充电' : '电池供电'}</div><div class="battery-track"><div class="battery-fill" style="width:${blank ? 0 : data.host.battery}%"></div></div></div><div style="text-align:right"><div class="power">${blank || ac ? '—' : data.host.powerW+'<span style="font-size:15px"> W</span>'}</div><div class="caption">${ac ? '接电时不估算放电' : '整机估算放电'}</div></div></div><div class="divider"></div><div class="flex caption"><span>后台每分钟采样</span><span>${fresh() ? '更新于 '+data.host.updated : '等待有效采样'}</span></div></div>`;
  const alert = fresh() && !ac && alertsEnabled && !alertSnoozed ? `<div class="notice"><div class="flex"><strong>node 持续高能耗影响</strong>${button('snooze','忽略 1 小时','text-button')}</div><p>近 5 分钟持续高占用</p>${button('alert-app','查看进程 →','text-button')}</div>` : '';
  const rows = data.apps.map(app => `<button class="list-row" data-action="app" data-id="${app.id}">${icon(app)}<span class="app-info"><span class="app-title">${app.name}</span><div class="app-meta">CPU ${app.cpu} · RSS ${app.memory}<br>${app.count} 个进程</div></span><span class="score">${app.impact.toFixed(1)}<div class="caption">能耗影响</div></span><span class="chevron">›</span></button>`).join('');
  return header('耗电监控','home',button('settings','设置'))+`<div class="content">${hostCard}${statusNotice()}${permissionNotice()}${alert}${message ? `<p class="toast">${escape(message)}</p>` : ''}<div class="flex section-label"><span>应用排行</span><span>按能耗影响排序</span></div><div class="card">${blank ? '<div class="empty">暂无有效采样</div>' : rows}</div><p class="footnote">能耗影响按 CPU 与唤醒次数估算，不是应用瓦数。CPU 的 100% 表示一个核心。RSS 合计可能重复计入共享页，内存占用不代表耗电量。</p></div>`;
}
function appDetail() {
  const app = selectedApp;
  const processRows = app.processes.map(process => {
    const result = results.get(process.id);
    const control = process.protected ? '<span class="pill">受保护</span>' : result === 'exited' ? '<span class="success">已结束</span>' : button('terminate',result === 'still_running' ? '强制结束…' : '结束进程','process-action',`data-id="${process.id}" ${canAct() ? '' : 'disabled'}`);
    return `<div class="process"><div class="flex"><div class="app-info"><div class="app-title">${escape(process.name)}</div><div class="app-meta">PID ${process.pid}<br>CPU ${process.cpu} · RSS ${process.memory}</div></div>${control}</div>${process.protected ? '<div class="caption" style="margin-top:7px">Runweave 控制进程</div>' : result === 'still_running' ? '<div class="caption danger" style="margin-top:7px">仍在运行 · 尚未强制结束</div>' : ''}</div>`;
  }).join('');
  return header(app.name,'energy')+`<div class="content"><div class="caption" style="margin-bottom:14px">${data.host.name} · 更新于 ${data.host.updated}</div><div class="card padded"><div class="flex">${icon(app)}<span class="app-info"><strong>${app.name}</strong><div class="caption">${app.count} 个进程</div></span><div class="score">${app.impact}<div class="caption">能耗影响</div></div></div><div class="divider"></div><div class="flex caption"><span>CPU ${app.cpu}</span><span>RSS 合计 ${app.memory}</span></div></div>${statusNotice()}${permissionNotice()}${message ? `<p class="toast" role="status">${escape(message)}</p>` : ''}<div class="section-label">占用较高的进程</div><div class="card">${processRows}</div><p class="footnote">只结束选中的进程，不会退出整个应用。RSS 合计可能重复计入共享页。</p></div>`;
}
function settings() {
  return header('提醒设置','energy')+`<div class="content"><p class="caption" style="margin-bottom:20px">${data.host.name} · 设置与电脑端同步</p><div class="card"><label class="setting"><div><strong>后台资源监控</strong><div class="caption">关闭手机页面后仍继续采样</div></div><input class="switch" type="checkbox" data-setting="monitor" aria-label="后台资源监控" ${monitorEnabled?'checked':''}></label><label class="setting"><div><strong>资源占用提醒</strong><div class="caption">对这台电脑的能耗与内存规则生效</div></div><input class="switch" type="checkbox" data-setting="alerts" aria-label="资源占用提醒" ${alertsEnabled?'checked':''}></label></div><p class="footnote">能耗影响 ≥ 100（仅电池供电），或 RSS 合计 ≥ 4 GiB；至少六次有效采样跨满五分钟。内存占用不代表耗电量。</p><div class="section-label">进程操作权限</div><div class="card padded"><div class="flex"><strong>远程结束进程</strong><span class="${authorized?'success':'muted'}">${authorized?'已授权':'未授权'}</span></div><p class="caption">${authorized?'已登录客户端可结束这台电脑的普通进程。电脑端可随时撤销；受保护进程不可操作。':'请在这台电脑的 Runweave「提醒设置」中开启。手机不能自行授予权限。'}</p>${button('refresh-permission','刷新权限','wide secondary')}</div>${message ? `<p class="toast" role="status">${escape(message)}</p>` : ''}</div>`;
}
function home() {
  return `<div class="statusbar"><span>9:41</span><span aria-hidden="true">▮▮▮　Wi-Fi　▰</span></div><header class="nav">${button('connections','● 我的 Mac','', 'style="white-space:nowrap"')}<h1>Runweave</h1>${button('menu','•••','','aria-label="首页菜单"')}</header>${menuOpen ? `<div class="card menu">${button('energy','耗电监控')}${button('scheduled','定时任务')}${button('dismiss-menu','取消')}</div>` : ''}<div class="content"><input class="search" placeholder="搜索项目和终端" aria-label="搜索项目和终端"><div class="section-label">需要关注</div><div class="card"><div class="project-row"><strong><span class="dot">●</span> browser-viewer</strong><div class="caption">Codex · 正在执行</div></div><div class="project-row"><strong>iOS 界面调整</strong><div class="caption">已完成 · 有新消息</div></div></div><div class="section-label">项目</div><div class="card"><div class="project-row"><strong>browser-viewer</strong><div class="caption">3 个终端　›</div></div><div class="project-row"><strong>suiji</strong><div class="caption">2 个终端　›</div></div></div></div>`;
}
function connections() {
  return header('连接管理','home')+`<div class="content"><div class="section-label">Backend</div><div class="card"><div class="padded"><div class="flex"><strong>我的 Mac</strong><span class="success">当前连接 ✓</span></div><p class="caption">${data.host.name} · 已登录</p><div class="caption">电池 ${data.host.battery}% · 电池供电</div></div><button class="list-row" data-action="energy" aria-label="耗电监控"><span class="app-info">耗电监控</span><span class="chevron">›</span></button></div></div>`;
}
function desktop() {
  return header('系统监控','desktop',button('desktop-settings','提醒设置'))+`<div class="content"><h2>${data.host.name}</h2><p class="caption">最近采样 ${data.host.updated}</p><div class="card padded"><div class="flex"><span>CPU　50%</span><span>内存　62%</span><span>电池　36%</span></div></div><div class="card padded"><div class="flex"><strong>高占用应用与进程</strong><span class="caption">能耗影响</span></div>${data.apps.map(app=>`<div class="setting"><span>${app.name}</span><span>${app.impact}</span></div>`).join('')}</div></div>`;
}
function renderDialog() {
  if (!modal) return '';
  if (modal.kind === 'desktop-settings') return `<div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-body"><h2 id="dialog-title">资源提醒设置</h2><p>${data.host.name} · 后台每分钟采样</p><div class="card"><div class="setting"><span>后台资源监控</span><span class="success">已开启</span></div><div class="setting"><span>资源占用提醒</span><span class="success">已开启</span></div><label class="setting"><span>允许远程结束进程</span><input class="switch" type="checkbox" data-setting="remote" aria-label="允许远程结束进程" ${modal.draft?'checked':''}></label></div><p>允许已登录客户端远程结束这台电脑的普通进程，包括再次确认后的强制结束。系统及 Runweave 控制进程仍受保护。</p><p>关闭后立即撤销远程操作权限，不影响查看资源排行。</p></div><div class="dialog-buttons">${button('cancel','取消')}${button('save-permission','保存')}</div></section></div>`;
  const process = modal.process;
  const force = modal.kind === 'force';
  return `<div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-body"><h2 id="dialog-title">${force?'强制结束这个进程？':'结束这个进程？'}</h2><div class="identity"><strong>${data.host.name}</strong><br>${escape(process.name)} · PID ${process.pid}<br>CPU ${process.cpu} · RSS ${process.memory}</div><p>${force?'普通结束后进程仍在运行。强制结束会立即停止进程，未保存内容可能丢失。':'未保存内容可能丢失。只结束这个进程，应用的其他进程可能继续运行。'}</p></div><div class="dialog-buttons">${button('cancel','取消')}${button('confirm',force?'强制结束':'结束进程','danger')}</div></section></div>`;
}
function render() {
  root.className = screen === 'desktop' ? 'desktop' : '';
  const views = {home, connections, energy, app:appDetail, settings, desktop};
  root.innerHTML = (views[screen] || home)()+renderDialog();
  if (modal) root.querySelector('[data-action="cancel"]')?.focus();
}
function navigate(next) { screen=next; menuOpen=false; message=''; modal=null; window.scrollTo(0,0); render(); }
root.addEventListener('click', event => {
  const target=event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action=target.dataset.action;
  if (['home','connections','energy','settings','desktop'].includes(action)) return navigate(action);
  if (action==='menu') {menuOpen=!menuOpen;render();}
  if (action==='dismiss-menu') {menuOpen=false;render();}
  if (action==='app' || action==='alert-app') {selectedApp=data.apps.find(item=>item.id===(target.dataset.id||'node'));navigate('app');}
  if (action==='snooze') {alertSnoozed=true;message='已忽略 node 的资源提醒 1 小时';render();}
  if (action==='refresh-permission') {authorized=localStorage.getItem(permissionKey)==='on';message=authorized?'权限已刷新，可远程结束普通进程':'电脑尚未开启远程操作权限';render();}
  if (action==='desktop-settings') {modal={kind:'desktop-settings',draft:authorized};render();}
  if (action==='cancel') {modal=null;render();}
  if (action==='save-permission') {authorized=modal.draft;localStorage.setItem(permissionKey,authorized?'on':'off');modal=null;message=authorized?'远程操作权限已开启':'远程操作权限已撤销';render();}
  if (action==='terminate' && canAct()) {const process=selectedApp.processes.find(item=>item.id===target.dataset.id);if(process.protected)return;modal={kind:results.get(process.id)==='still_running'?'force':'terminate',process};render();}
  if (action==='confirm' && modal?.process) {
    if(!canAct()){modal=null;message='当前无法结束进程，请检查权限与采样状态';render();return;}
    const process=modal.process;
    const stillRunning=process.ignoresTerm && modal.kind!=='force';
    results.set(process.id,stillRunning?'still_running':'exited');
    message=stillRunning?'进程仍在运行，强制结束需要再次确认。':'已结束选定进程。应用的其他进程可能仍在运行，排行将在下次采样更新。';
    modal=null;render();
  }
});
root.addEventListener('change',event=>{
  const setting=event.target.dataset.setting;
  if(setting==='remote')modal.draft=event.target.checked;
  if(setting==='monitor'){monitorEnabled=event.target.checked;message='后台监控设置已同步到这台电脑';render();}
  if(setting==='alerts'){alertsEnabled=event.target.checked;message='提醒设置已同步到这台电脑';render();}
});
window.addEventListener('storage',event=>{
  if(event.key!==permissionKey)return;
  authorized=event.newValue==='on';
  if(!authorized && modal?.process){modal=null;message='电脑已撤销远程操作权限';}
  render();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){modal=null;menuOpen=false;render();}});
if(query.get('dialog')==='terminate' || query.get('dialog')==='force')modal={kind:query.get('dialog'),process:selectedApp.processes[query.get('dialog')==='force'?1:0]};
if(query.get('dialog')==='permission'){screen='desktop';modal={kind:'desktop-settings',draft:authorized};}
render();
