const initial = await fetch('./mock-state.json').then(response => response.json());
const params = new URLSearchParams(location.search);
const state = structuredClone(initial);
state.open = params.get('panel') === 'open';
state.menu = false;
state.view = 'list';
state.hostId = null;
state.portId = null;
state.deletePending = false;
const scenario = params.get('scenario');
if (scenario === 'empty') state.hosts = [];
if (scenario === 'conflict') state.hosts[0].forwards[0].error = '本机端口 3001 已被占用。请释放该端口，或修改服务端口。';
if (scenario === 'ssh-error') { state.hosts[0].status = 'failed'; state.hosts[0].error = 'SSH 身份验证失败，请检查主机配置与密钥。'; }
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hostById = id => state.hosts.find(host => host.id === id);
const host = () => hostById(state.hostId);
const switchButton = (label, enabled, action, id, extra = '') => `<button role="switch" aria-label="${escape(label)}" aria-checked="${enabled}" class="switch ${enabled ? 'on' : ''}" data-action="${action}" data-host="${id}" ${extra}><span></span></button>`;
const status = (text, kind = '') => `<span class="status ${kind}">${text}</span>`;
function renderShell() {
  document.querySelector('#app').innerHTML = `
    <div class="windowbar"><i class="traffic"></i><i class="traffic"></i><i class="traffic"></i><span class="windowtitle">Runweave</span></div>
    <header class="toolbar"><button class="icon" aria-label="首页">⌂</button><button class="connection" data-action="connection">${escape(state.activeConnection)} ⌃⌄</button><div class="project">run-weave</div><div class="project secondary">web-console</div><div class="actions"><button class="icon" aria-label="随记">▤</button><button class="icon" aria-label="定时任务">◷</button><button class="icon" aria-label="更多操作" aria-expanded="${state.menu}" data-action="menu">···</button></div></header>
    <div class="tabs"><div class="tab active">run-weave(codex)　×</div><div class="tab">run-weave　×</div></div>
    <div class="workspace"><section class="terminal"><div class="path">~/projects/run-weave　 main</div><br><span class="faint">╭─────────────────────────────────────╮</span><br>│　Codex　　　　　　　　　　　　　　　│<br><span class="faint">╰─────────────────────────────────────╯</span><br><br><span class="faint">工作目录</span><br>~/projects/run-weave<br><br><span class="faint">当前会话</span><br>等待输入<div class="prompt">› 输入消息</div></section><section class="preview"><div class="preview-tabs">Preview　Automation　<strong>Browser 1</strong></div><div class="address">⌘　 about:blank</div><div class="empty-preview">Browser 1</div></section></div>
    ${state.menu ? `<div class="menu" role="menu"><button role="menuitem">◉　Codex 额度</button><button role="menuitem">▣　Preview</button><button role="menuitem">↗　Open Prototypes</button><hr><button role="menuitem" data-action="open">⇄　端口与隧道 <span class="badge">本机</span></button><button role="menuitem">▤　日志上报</button><button role="menuitem">◷　状态查询</button></div>` : ''}`;
}
function hostCard(item) {
  const connected = item.status === 'connected';
  const busy = item.status === 'connecting';
  const live = item.forwards.filter(port => port.enabled && !port.error).length;
  return `<article class="host"><div class="host-head"><div class="host-symbol">&gt;_</div><div class="host-name"><h2>${escape(item.name)}</h2><small>${escape(item.target)}</small></div><button class="icon" aria-label="设置 ${escape(item.name)}" data-action="host-edit" data-host="${item.id}">⚙</button><button class="icon" aria-label="${item.expanded ? '收起' : '展开'} ${escape(item.name)}" data-action="expand" data-host="${item.id}">${item.expanded ? '⌃' : '⌄'}</button></div>
  <div class="host-controls">${status(connected ? 'SSH 已连接' : busy ? '正在连接…' : item.status === 'failed' ? '连接失败' : '未连接', connected ? '' : busy ? 'busy' : item.status === 'failed' ? 'error' : 'off')}<button class="btn quiet" data-action="connect" data-host="${item.id}" ${busy ? 'disabled' : ''}>${connected ? '断开' : '连接'}</button></div>
  ${item.error ? `<div class="host-content"><div class="notice">${escape(item.error)}</div></div>` : ''}
  ${item.expanded ? `<div class="host-content"><div class="row between section-title"><span>端口转发</span><button class="link" data-action="port-add" data-host="${item.id}">＋ 添加端口</button></div>${item.forwards.length ? item.forwards.map(port => `<div class="port"><div class="row between"><h3>${escape(port.name)}</h3>${switchButton(`${port.name} 转发`, port.enabled, 'port-toggle', item.id, `data-port="${port.id}"`)}</div><div class="row between"><div class="port-route"><div><span class="address-label">本机</span>127.0.0.1:${port.port}</div><span class="arrow">→</span><div><span class="address-label">${escape(item.name)}</span>127.0.0.1:${port.port}</div></div><button class="link" aria-label="编辑 ${escape(port.name)}" data-action="port-edit" data-host="${item.id}" data-port="${port.id}">编辑</button></div>${status(port.error ? '转发失败' : !port.enabled ? '已停用' : connected ? '转发中' : '等待 SSH 连接', port.error ? 'error' : connected && port.enabled ? '' : 'off')}${port.error ? `<div class="notice">${escape(port.error)} <button class="link" data-action="retry-port" data-host="${item.id}" data-port="${port.id}">重试</button></div>` : ''}</div>`).join('') : '<p class="hint">暂无端口转发</p>'}
  <div class="browser-box"><div class="row between"><h3>远端访问本机 Browser</h3>${switchButton(`${item.name} 浏览器通道`, item.browser, 'browser-toggle', item.id)}</div><div class="browser-info">${escape(item.name)} 上的 Agent → 本机 <b>${escape(item.profile)}</b></div><div class="row between" style="margin-top:8px">${status(!item.browser ? '已关闭' : connected ? '浏览器通道可用' : '等待 SSH 连接', connected && item.browser ? '' : 'off')}<button class="link" data-action="browser-edit" data-host="${item.id}">设置</button></div></div></div>` : `<div class="host-summary">${item.forwards.length} 项端口转发 · 浏览器通道${item.browser ? '已开启' : '已关闭'}${connected ? ` · ${live} 项转发运行中` : ''}</div>`}</article>`;
}
function editView() {
  const item = host();
  if (state.view === 'host') return `<form id="host-form" class="form"><label>名称<input name="name" value="${escape(item?.name)}" placeholder="例如 devbox" required maxlength="60"></label><label>SSH 主机<input name="target" value="${escape(item?.target)}" placeholder="SSH 别名或 user@hostname" required pattern="[^\\s]+"></label><p class="hint">使用本机 SSH 配置和密钥。</p><label class="check"><input type="checkbox" name="autoStart" ${item?.autoStart ? 'checked' : ''}>启动 Runweave 时自动连接</label><div class="form-actions"><button type="button" class="btn quiet" data-action="back">取消</button><button class="btn primary">保存</button></div></form>${item ? `<div class="delete-bar">${state.deletePending ? `<p class="hint">移除后会停止此主机的端口转发和浏览器通道。</p><div class="row" style="margin-top:12px"><button class="btn danger" data-action="host-delete">确认移除</button><button class="btn" data-action="cancel-delete">取消</button></div>` : '<button class="link danger" data-action="confirm-delete">移除 SSH 主机</button>'}</div>` : ''}`;
  if (state.view === 'port') {
    const port = item.forwards.find(port => port.id === state.portId);
    return `<form id="port-form" class="form"><label>名称<input name="name" value="${escape(port?.name)}" placeholder="例如 Web 开发服务" required maxlength="60"></label><label>端口<input name="port" type="number" min="1" max="65535" value="${port?.port ?? ''}" placeholder="3001" required></label><p class="hint">本机和远端使用相同端口，仅监听本机 127.0.0.1。</p><div id="form-error" role="alert"></div><label class="check"><input type="checkbox" name="enabled" ${port?.enabled !== false ? 'checked' : ''}>启用此转发</label><div class="form-actions"><button type="button" class="btn quiet" data-action="back">取消</button><button class="btn primary">保存</button></div></form>${port ? '<div class="delete-bar"><button class="link danger" data-action="port-delete">删除端口转发</button></div>' : ''}`;
  }
  return `<form id="browser-form" class="form"><label>远端 Runweave 后端端口<input name="backendPort" type="number" min="1" max="65535" value="${item.backendPort}" required></label><p class="hint">通过 SSH 访问 ${escape(item.name)} 的 127.0.0.1:${item.backendPort}。</p><label>允许访问的 Browser<select name="profile">${['Browser 1','Browser 2','Browser 3'].map(profile => `<option ${profile === item.profile ? 'selected' : ''}>${profile}</option>`).join('')}</select></label><p class="hint">使用此 Browser 的 Cookie 和代理配置。</p><label class="check"><input type="checkbox" name="enabled" ${item.browser ? 'checked' : ''}>允许远端 Agent 访问</label><div class="form-actions"><button type="button" class="btn quiet" data-action="back">取消</button><button class="btn primary">保存</button></div></form>`;
}
function render() {
  renderShell();
  const title = state.view === 'list' ? '端口与隧道' : state.view === 'host' ? (host() ? 'SSH 主机设置' : '添加 SSH 主机') : state.view === 'port' ? (state.portId ? '编辑端口转发' : '添加端口转发') : '浏览器通道设置';
  const activeCount = state.hosts.filter(item => item.status === 'connected').length;
  document.querySelector('#overlay').innerHTML = state.open ? `<div class="scrim" data-action="close"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="端口与隧道"><header class="drawer-head"><div class="eyebrow">本机配置${state.view !== 'list' && host() ? ` / ${escape(host().name)}` : ''}</div><div class="row between"><div class="row">${state.view !== 'list' ? '<button class="icon" aria-label="返回" data-action="back">‹</button>' : ''}<h1>${title}</h1></div><button class="icon" aria-label="关闭面板" data-action="close">×</button></div></header><div class="drawer-body">${state.view === 'list' ? `<div class="intro row between"><div><h2>SSH 主机</h2><p>${state.hosts.length} 台主机 · ${activeCount} 台已连接</p></div><button class="btn" data-action="host-add">＋ 添加主机</button></div>${state.hosts.map(hostCard).join('') || '<div class="empty">暂无 SSH 主机</div>'}` : editView()}</div><footer class="drawer-foot"><span class="dot"></span>关闭面板后，已连接的通道继续运行</footer></aside>` : '';
}
let toastTimer;
function toast(message, action = false) {
  clearTimeout(toastTimer);
  document.querySelector('#notifications').innerHTML = `<div class="toast" role="status">${escape(message)}${action ? '<button data-action="open">查看</button>' : ''}</div>`;
  toastTimer = setTimeout(() => { document.querySelector('#notifications').innerHTML = ''; }, 5000);
}
function back() { state.view = 'list'; state.hostId = null; state.portId = null; state.deletePending = false; }
function openEditor(view, id = null, portId = null) { state.view = view; state.hostId = id; state.portId = portId; state.deletePending = false; }
document.addEventListener('click', event => {
  const control = event.target.closest('[data-action]');
  if (!control) return;
  const item = hostById(control.dataset.host);
  const port = item?.forwards.find(port => port.id === control.dataset.port);
  switch (control.dataset.action) {
    case 'menu': state.menu = !state.menu; break;
    case 'open': state.open = true; state.menu = false; back(); break;
    case 'close': state.open = false; back(); break;
    case 'back': back(); break;
    case 'connection': state.activeConnection = state.activeConnection === 'devbox' ? '内置本地后端' : 'devbox'; break;
    case 'expand': item.expanded = !item.expanded; break;
    case 'host-add': openEditor('host'); break;
    case 'host-edit': openEditor('host', item.id); break;
    case 'port-add': openEditor('port', item.id); break;
    case 'port-edit': openEditor('port', item.id, port.id); break;
    case 'browser-edit': openEditor('browser', item.id); break;
    case 'confirm-delete': state.deletePending = true; break;
    case 'cancel-delete': state.deletePending = false; break;
    case 'host-delete': state.hosts = state.hosts.filter(item => item.id !== state.hostId); back(); toast('SSH 主机已移除'); break;
    case 'port-delete': host().forwards = host().forwards.filter(port => port.id !== state.portId); back(); toast('端口转发已删除'); break;
    case 'port-toggle': port.enabled = !port.enabled; if (!port.enabled) delete port.error; break;
    case 'browser-toggle': item.browser = !item.browser; break;
    case 'retry-port': delete port.error; toast('端口转发已恢复'); break;
    case 'connect':
      if (item.status === 'connected') { item.status = 'disconnected'; toast(`${item.name} 已断开，端口转发和浏览器通道已停止`); }
      else { item.status = 'connecting'; delete item.error; setTimeout(() => { if (!state.hosts.includes(item)) return; item.status = 'connected'; render(); toast(`${item.name} 已连接`); }, 650); }
      break;
  }
  render();
  if (control.dataset.action === 'open') document.querySelector('[aria-label="关闭面板"]').focus();
  if (control.dataset.action === 'close') document.querySelector('[aria-label="更多操作"]').focus();
});
document.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  if (form.id === 'host-form') {
    const values = { name: data.get('name').trim(), target: data.get('target').trim(), autoStart: data.has('autoStart') };
    if (!values.name || !values.target) return;
    if (host()) { const changed = host().target !== values.target; Object.assign(host(), values); if (changed) host().status = 'disconnected'; }
    else state.hosts.push({ ...values, id: crypto.randomUUID(), status:'disconnected', expanded:true, backendPort:5001, profile:'Browser 1', browser:false, forwards:[] });
  } else if (form.id === 'port-form') {
    const value = { name:data.get('name').trim(), port:Number(data.get('port')), enabled:data.has('enabled') };
    if (host().forwards.some(port => port.port === value.port && port.id !== state.portId)) { document.querySelector('#form-error').innerHTML = '<div class="notice">此主机已配置该端口，请编辑已有转发。</div>'; return; }
    const old = host().forwards.find(port => port.id === state.portId);
    const elsewhere = state.hosts.some(item => item !== host() && item.status === 'connected' && item.forwards.some(port => port.enabled && port.port === value.port));
    if (elsewhere && value.enabled && host().status === 'connected') value.error = `本机端口 ${value.port} 已被占用。请释放该端口，或修改服务端口。`;
    if (old) { delete old.error; Object.assign(old,value); } else host().forwards.push({ ...value, id:crypto.randomUUID() });
  } else if (form.id === 'browser-form') Object.assign(host(), { backendPort:Number(data.get('backendPort')), profile:data.get('profile'), browser:data.has('enabled') });
  back(); render(); toast('配置已保存');
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { state.menu = false; if (state.open && state.view !== 'list') back(); else state.open = false; render(); document.querySelector('[aria-label="更多操作"]').focus(); }
  if (event.key === 'Tab' && state.open) {
    const focusable = [...document.querySelector('.drawer').querySelectorAll('button:not(:disabled),input,select')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
render();
if (scenario === 'drop') setTimeout(() => { const item = state.hosts[0]; item.status = 'failed'; item.error = 'SSH 连接中断，正在重连…'; render(); toast(`${item.name} 连接中断，端口转发和浏览器通道暂不可用`, true); }, 8000);
