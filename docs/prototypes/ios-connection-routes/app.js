const app = document.querySelector('#app');
const sheet = document.querySelector('#sheet');
const paths = {
  back: '<path d="m14 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  laptop: '<rect x="4" y="4" width="16" height="12" rx="1.5"/><path d="M2 19h20M9 19h6"/>',
  wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0m-11 4a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r=".6"/>',
  tunnel: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  more: '<circle cx="5" cy="12" r=".6"/><circle cx="12" cy="12" r=".6"/><circle cx="19" cy="12" r=".6"/>',
  up: '<path d="m6 14 6-6 6 6"/>',
  down: '<path d="m6 10 6 6 6-6"/>',
  grip: '<path d="M5 8h14M5 12h14M5 16h14"/>'
};
const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.wifi}</svg>`;
const escape = (value) => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let state;
let selecting = 0;
let editing = false;
let view = 'routes';
let checkingId = null;
let dragId = null;
let dragStartY = null;
let dragged = false;
const routeById = id => state.routes.find(route => route.id === id);

function routeStatus(route) {
  if (checkingId === route.id) return ['正在检测…', 'blue'];
  if (state.activeId === route.id) return [`当前使用 · ${route.latency} ms`, 'good'];
  if (route.result === 'unreachable') return ['无法连接', ''];
  if (route.result === 'identity') return ['电脑身份不匹配', 'bad'];
  if (route.result === 'available') return [`可用 · ${route.latency} ms`, 'good'];
  return ['尚未检测', ''];
}

function renderRoute(route, index) {
  const [label, color] = routeStatus(route);
  const fixed = state.mode === 'manual' && state.pinnedId === route.id;
  return `<article class="route ${state.activeId === route.id ? 'active' : ''}" data-route="${route.id}">
    ${editing ? `<span class="grip" aria-label="拖动排序 ${escape(route.name)}">${icon('grip')}</span>` : `<span class="route-icon">${icon(route.kind)}</span>`}
    <div class="route-info"><div class="route-name"><span class="priority">${index + 1}</span>${escape(route.name)}</div>
    <div class="route-url">${escape(route.url)}</div><div class="route-meta ${color}">${label}${fixed ? ' · 已固定' : ''}</div></div>
    ${editing ? `<div class="sort-buttons"><button data-action="up" data-id="${route.id}" aria-label="上移 ${escape(route.name)}" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button><button data-action="down" data-id="${route.id}" aria-label="下移 ${escape(route.name)}" ${index === state.routes.length-1 ? 'disabled' : ''}>${icon('down')}</button></div>` : state.mode === 'manual' ? `<button class="route-select" data-action="pin" data-id="${route.id}" aria-label="固定使用 ${escape(route.name)}" aria-pressed="${fixed}"><span class="radio ${fixed ? 'checked' : ''}">${fixed ? icon('check') : ''}</span></button>` : `<button class="route-select more" data-action="route-menu" data-id="${route.id}" aria-label="管理 ${escape(route.name)}">${icon('more')}</button>`}
  </article>`;
}

function render() {
  if (view === 'manager') {
    app.innerHTML = `<nav><span></span><span>连接管理</span><span></span></nav><div class="content"><h1>我的电脑</h1><div class="card"><button class="manager-row" data-action="open"><span class="device-icon">${icon('laptop')}</span><span class="route-info"><strong>${escape(state.device.name)}</strong><small>${state.activeId ? '已连接 · '+escape(routeById(state.activeId).name) : '未连接'} · ${state.routes.length} 条线路</small></span>${icon('right','chevron')}</button></div></div>`;
    return;
  }
  const active = routeById(state.activeId);
  const currentCheck = routeById(checkingId);
  const pinned = routeById(state.pinnedId);
  const title = currentCheck ? currentCheck.name : active ? active.name : state.mode === 'manual' && pinned ? pinned.name : '所有线路均不可用';
  const status = checkingId ? `正在连接 · ${state.routes.findIndex(r => r.id === checkingId)+1}/${state.routes.length}` : active ? '已连接' : state.mode === 'manual' ? '固定线路无法连接' : '未连接';
  app.innerHTML = `<nav><button data-action="back">${icon('back')}连接管理</button><span></span></nav><div class="content"><h1>连接线路</h1>
    <section class="card connection-card" aria-label="当前连接" aria-live="polite">
      <div class="device"><span class="device-icon">${icon('laptop')}</span><div><strong>${escape(state.device.name)}</strong><small>${escape(state.device.owner)}</small></div></div>
      <div class="live-line ${checkingId ? 'checking' : active ? '' : 'offline'}"><span class="dot"></span>${status}</div>
      <div class="current-line"><strong>${escape(title)}</strong><span class="latency">${active && !checkingId ? active.latency + ' ms' : ''}</span></div>
      <div class="route-url">${escape((currentCheck || active || pinned)?.url || '请检查电脑与网络连接')}</div>
      <button class="reconnect" data-action="retry" ${checkingId ? 'disabled' : ''}>${icon('refresh')}${checkingId ? '正在尝试连接…' : state.mode === 'manual' ? '重新连接' : '重新选择线路'}</button>
    </section>
    <div class="section-title"><h2>连接方式</h2></div>
    <div class="segmented" role="group" aria-label="连接方式"><button data-action="auto" class="${state.mode === 'auto' ? 'selected' : ''}" aria-pressed="${state.mode === 'auto'}">自动选择</button><button data-action="manual" class="${state.mode === 'manual' ? 'selected' : ''}" aria-pressed="${state.mode === 'manual'}">手动指定</button></div>
    <p class="footnote">${state.mode === 'auto' ? '按线路顺序连接，断开后自动尝试其他线路。' : '仅使用指定线路，无法连接时不会自动切换。'}</p>
    <div class="section-title"><h2>${state.mode === 'auto' ? '线路优先级' : '选择线路'}</h2><button data-action="edit-order">${editing ? '完成' : '编辑'}</button></div>
    <section class="card" aria-label="连接线路列表">${state.routes.map(renderRoute).join('')}<button class="add-route" data-action="add">${icon('plus')}添加线路</button></section>
    ${editing ? '<p class="footnote">排序在下次选择线路时生效。</p>' : state.mode === 'auto' && active ? '<p class="footnote">连接正常时保持当前线路，不自动切换。</p>' : ''}
    ${!checkingId && !active && state.mode === 'manual' ? '<p class="notice">可以选择其他线路，或切回自动选择。</p>' : ''}
  </div>`;
}

async function selectRoutes() {
  const generation = ++selecting;
  state.activeId = null;
  const candidates = state.mode === 'auto' ? [...state.routes] : [routeById(state.pinnedId)].filter(Boolean);
  for (const route of candidates) {
    checkingId = route.id;
    route.result = 'idle';
    render();
    await new Promise(resolve => setTimeout(resolve, 700));
    if (generation !== selecting) return;
    route.result = !route.reachable ? 'unreachable' : !route.verified ? 'identity' : 'connected';
    if (route.result === 'connected') {
      state.activeId = route.id;
      break;
    }
  }
  if (generation !== selecting) return;
  checkingId = null;
  render();
}

function showSheet(content) {
  sheet.innerHTML = `<div class="sheet-grip"></div>${content}`;
  if (!sheet.open) sheet.showModal();
}

function showRouteMenu(id) {
  const route = routeById(id);
  showSheet(`<div class="sheet-nav"><button data-action="dismiss">关闭</button><strong id="sheet-title">${escape(route.name)}</strong><span></span></div><p class="sheet-note">${escape(route.url)}</p><button class="sheet-button" data-action="pin" data-id="${id}">固定使用此线路</button><button class="route-action" data-action="edit-route" data-id="${id}">编辑线路</button>`);
}

function showForm(id) {
  const route = routeById(id);
  showSheet(`<form id="route-form" data-id="${id || ''}"><div class="sheet-nav"><button type="button" data-action="dismiss">取消</button><strong id="sheet-title">${route ? '编辑线路' : '添加线路'}</strong><button type="submit">保存</button></div><div class="fields"><label class="field"><span>线路名称</span><input name="name" required maxlength="30" placeholder="例如：家里 Wi-Fi" value="${escape(route?.name || '')}" /></label><label class="field"><span>连接地址</span><input name="url" type="url" required placeholder="https:// 或 http://" value="${escape(route?.url || '')}" autocapitalize="none" spellcheck="false" /></label></div><p class="sheet-note">添加通向这台 MacBook Pro 的地址。连接前会验证电脑身份。</p><p class="form-error" role="alert"></p>${route ? '<button type="button" class="danger-button" data-action="delete-route" data-id="'+id+'">删除线路</button>' : ''}</form>`);
}

function moveRoute(id, destination) {
  const old = state.routes.findIndex(r => r.id === id);
  if (old < 0 || destination < 0 || destination >= state.routes.length) return;
  state.routes.splice(destination, 0, state.routes.splice(old, 1)[0]);
  render();
}

function handleClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled || dragged) return;
  const { action, id } = button.dataset;
  if (action === 'back' || action === 'open') { view = action === 'back' ? 'manager' : 'routes'; render(); }
  if (action === 'edit-order') { editing = !editing; render(); }
  if (action === 'up' || action === 'down') moveRoute(id, state.routes.findIndex(r => r.id === id) + (action === 'up' ? -1 : 1));
  if (action === 'retry') selectRoutes();
  if (action === 'auto' && state.mode !== 'auto') { state.mode = 'auto'; state.pinnedId = null; selectRoutes(); }
  if (action === 'manual' && state.mode !== 'manual') {
    selecting++; checkingId = null; state.mode = 'manual'; state.pinnedId = state.activeId || state.routes[0]?.id || null; editing = false;
    if (!state.activeId) selectRoutes(); else render();
  }
  if (action === 'pin') { sheet.close(); state.mode = 'manual'; state.pinnedId = id; editing = false; selectRoutes(); }
  if (action === 'add' || action === 'edit-route') showForm(id);
  if (action === 'route-menu') showRouteMenu(id);
  if (action === 'dismiss') sheet.close();
  if (action === 'delete-route') {
    showSheet(`<div class="sheet-nav"><button data-action="dismiss">取消</button><strong id="sheet-title">删除线路？</strong><span></span></div><p class="sheet-note">删除“${escape(routeById(id).name)}”？${state.activeId === id ? '当前连接会断开。' : ''}电脑上的项目和终端会保留。</p><button class="danger-button" data-action="confirm-delete" data-id="${id}">删除线路</button>`);
  }
  if (action === 'confirm-delete') {
    sheet.close(); selecting++; checkingId = null;
    const wasActive = state.activeId === id;
    state.routes = state.routes.filter(r => r.id !== id);
    if (wasActive) state.activeId = null;
    if (state.pinnedId === id) state.pinnedId = null;
    if (state.mode === 'auto' && !state.activeId) selectRoutes(); else render();
  }
}

app.addEventListener('click', handleClick);
sheet.addEventListener('click', handleClick);
sheet.addEventListener('submit', event => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  let parsed;
  try {
    parsed = new URL(String(data.get('url')).trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
  } catch { form.querySelector('.form-error').textContent = '请输入完整的 HTTP 或 HTTPS 地址，不包含账号、查询参数或片段。'; return; }
  const name = String(data.get('name')).trim();
  const url = parsed.href.replace(/\/$/, '');
  if (!name) { form.querySelector('.form-error').textContent = '请填写线路名称。'; return; }
  if (state.routes.some(r => r.url === url && r.id !== form.dataset.id)) { form.querySelector('.form-error').textContent = '此地址已在当前电脑的线路中。'; return; }
  const route = routeById(form.dataset.id);
  if (route) {
    if (route.url !== url) { route.verified = true; route.result = 'idle'; if (state.activeId === route.id) state.activeId = null; }
    Object.assign(route, {name, url});
  } else state.routes.push({id: crypto.randomUUID(), name, url, kind: 'tunnel', reachable: true, verified: true, result: 'idle', latency: 42});
  selecting++; checkingId = null; sheet.close(); render();
});

app.addEventListener('pointerdown', event => {
  if (!event.target.closest('.grip')) return;
  event.preventDefault();
  dragId = event.target.closest('[data-route]').dataset.route;
  dragStartY = event.clientY;
});
app.addEventListener('pointermove', event => { if (dragStartY !== null && Math.abs(event.clientY - dragStartY) > 8) dragged = true; });
app.addEventListener('pointerup', event => {
  if (dragStartY === null) return;
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-route]');
  if (dragged && row) moveRoute(dragId, state.routes.findIndex(r => r.id === row.dataset.route));
  dragId = null; dragStartY = null;
  setTimeout(() => { dragged = false; }, 0);
});
app.addEventListener('pointercancel', () => { dragId = null; dragStartY = null; dragged = false; });

try {
  const response = await fetch('./mock-state.json');
  if (!response.ok) throw new Error('无法读取原型数据');
  state = await response.json();
  const scenario = state.scenarios[new URLSearchParams(location.search).get('scenario')];
  if (scenario) {
    for (const route of state.routes) {
      if (scenario.unreachable?.includes(route.id)) { route.reachable = false; route.result = 'unreachable'; }
      if (scenario.reachable?.includes(route.id)) { route.reachable = true; route.result = 'available'; }
      if (scenario.unverified?.includes(route.id)) { route.verified = false; route.result = 'identity'; }
    }
    if ('activeId' in scenario) state.activeId = scenario.activeId;
    if (scenario.mode) state.mode = scenario.mode;
    if (scenario.pinnedId) state.pinnedId = scenario.pinnedId;
    if (new URLSearchParams(location.search).get('scenario') === 'offline') state.activeId = null;
  }
  render();
} catch(error) { app.textContent = error.message; }
