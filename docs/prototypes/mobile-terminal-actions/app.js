const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  paperclip: '<path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m-4 10 6-6"/>',
  quick: '<path d="m12 2 9 5-9 5-9-5Zm-9 10 9 5 9-5M3 17l9 5 9-5"/>',
  background: '<rect x="3" y="4" width="18" height="14" rx="3"/><path d="M8 22h8m-4-4v4m-3-14 6 4-6 3z"/>',
  queue: '<path d="M4 5h16M4 11h11M4 17h7m6-3v8m-4-4h8"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M7 16h10"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11H3z"/>',
  review: '<path d="M9 3H5v18h14V3h-4M9 2h6v4H9zM8 11l2 2 5-5M8 17h7"/>',
  branch: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12m0-6c10 0 12-1 12-4"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/>',
  photo: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="2"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  signal: '<path d="M4 19v-4m5 4v-8m5 8V7m5 12V3"/>',
  battery: '<rect x="2" y="6" width="18" height="12" rx="3"/><path d="M23 10v4M5 9h12v6H5z"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
let data;
let state;
let toastTimer;

function keyboard() {
  return `<div class="keyboard" aria-hidden="true"><div class="suggestions"><span>检查</span><span>当前改动</span><span>交互</span></div>${['qwertyuiop','asdfghjkl','⇧zxcvbnm⌫'].map((row,index) => `<div class="keys ${index === 1 ? 'indent' : ''}">${[...row].map(letter => `<span class="key">${letter}</span>`).join('')}</div>`).join('')}<div class="keys"><span class="key wide">123</span><span class="key wide">◎</span><span class="key space">空格</span><span class="key wide">换行</span></div></div>`;
}

function menuItem(action, label, symbol, disabled = false, extra = '') {
  return `<button role="menuitem" class="menu-item menu-${action}" data-action="${action}" ${disabled ? 'disabled' : ''}>${icon(symbol)}<span>${label}</span>${extra}</button>`;
}

function menu() {
  if (!state.menu) return '';
  return `<button class="menu-dismiss" data-action="dismiss-menu" aria-label="关闭更多操作"></button><div class="action-menu" role="menu" aria-label="更多操作">
    ${menuItem('files', '文件', 'paperclip')}
    ${menuItem('quick', '快捷指令', 'quick')}
    ${menuItem('queue', '排队', 'queue', !data.queueSupported || (!state.draft.trim() && !state.attachment))}
    <div class="separator" role="separator"></div>
    ${menuItem('instant', '一键回复', 'bolt', false, state.instant ? '<span class="tail">已展开</span>' : '')}
  </div>`;
}

function commandRows() {
  const commands = data.commands.filter(item => `${item.title} ${item.body}`.includes(state.query));
  if (!commands.length) return '<div class="empty">没有匹配的快捷指令</div>';
  return commands.map(item => {
    const run = state.runs[item.id];
    const running = state.mode === 'background' && run;
    return `<article class="command-row"><div class="command-top"><div class="command-icon">${icon(item.icon)}</div><div class="command-copy"><strong>${escape(item.title)}</strong><p>${escape(item.body)}</p></div>
      ${running ? '' : `<button class="row-action" data-action="${state.mode === 'background' ? 'run' : 'insert'}" data-id="${item.id}" aria-label="${state.mode === 'background' ? '后台运行' : '填入'} ${escape(item.title)}">${state.mode === 'background' ? '运行' : '填入'}</button>`}
      </div>${running ? `<div class="run-status"><span class="dot"></span>排队中<button data-action="detail" data-id="${item.id}">查看运行</button></div>` : ''}</article>`;
  }).join('');
}

function sheet() {
  if (!state.sheet) return '';
  let title = '快捷指令';
  let body = '';
  if (state.sheet === 'library') {
    body = `<div class="segmented" role="group" aria-label="快捷指令执行方式"><button data-action="mode-insert" class="${state.mode === 'insert' ? 'selected' : ''}" aria-pressed="${state.mode === 'insert'}">填入输入框</button><button data-action="mode-background" class="${state.mode === 'background' ? 'selected' : ''}" aria-pressed="${state.mode === 'background'}">后台运行</button></div>
      <label class="search">${icon('search')}<input id="search" aria-label="搜索快捷指令" placeholder="搜索标题或正文" value="${escape(state.query)}"></label>
      ${state.mode === 'background' ? `<div class="project">${icon('folder')}<div>运行到 <strong>${escape(data.project)} / ${escape(data.worktree)}</strong><br>${escape(data.device)}</div></div>` : ''}
      <div class="section-label">已保存的快捷指令</div><div class="command-list" id="command-list">${commandRows()}</div>
      ${state.mode === 'background' ? '<p class="sheet-note">任务在电脑上运行，离开此页面后仍会继续。</p>' : ''}`;
  } else if (state.sheet === 'files') {
    title = '添加文件';
    body = `<button class="file-choice" data-action="photos">${icon('photo')}照片图库</button><button class="file-choice" data-action="file-picker">${icon('folder')}选取文件</button>`;
  } else if (state.sheet === 'detail') {
    const item = data.commands.find(item => item.id === state.selectedId);
    title = '后台运行';
    body = `<div class="detail"><span class="dot"></span>排队中<h2>${escape(item.title)}</h2><p>${escape(data.project)} / ${escape(data.worktree)}</p><p>${escape(item.body)}</p></div>`;
  }
  return `<button class="sheet-backdrop" data-action="close-sheet" aria-label="关闭面板"></button><section class="sheet" role="dialog" aria-modal="true" aria-label="${title}"><div class="handle"></div><header class="sheet-head"><button data-action="${state.sheet === 'detail' ? 'back-library' : 'close-sheet'}">返回</button><h1>${title}</h1><span></span></header>${body}</section>`;
}

function render() {
  app.innerHTML = `<section class="phone" aria-label="手机终端">
    <div class="statusbar"><span>9:41</span><div class="status-icons">${icon('signal')}${icon('battery')}</div></div>
    <header class="nav"><span class="icon-button">${icon('back')}</span><div class="title"><strong>Codex</strong><small><span class="dot"></span>${escape(data.project)} / ${escape(data.worktree)}</small></div><span class="icon-button">${icon('more')}</span></header>
    <div class="tabs"><span>Chat</span><span>Changes</span><span>Files</span></div>
    <div class="terminal"><p class="dim">╭─ OpenAI Codex ─────────────────╮<br>│ model: GPT-6-Sol&nbsp; /&nbsp; high &nbsp; &nbsp; │<br>╰───────────────────────────────╯</p><p><span class="green">›</span> ${escape(data.draft)}</p><p class="dim">• Reading workspace changes<br>• Reviewing terminal input</p><p>正在检查输入框与快捷指令的交互。<br>完成后给出需要调整的内容。</p><p class="prompt">${escape(state.terminalFeedback || 'Working…')}</p></div><div class="veil"></div>
    <section class="dock" aria-label="终端输入框">
      ${state.instant ? '<div class="pinned"><button data-action="instant-send" data-text="可以">可以</button><button data-action="instant-send" data-text="继续">继续</button></div>' : ''}
      ${state.shortcuts ? '<div id="terminal-shortcuts" class="shortcut-strip"><button data-action="key" data-text="Esc">Esc</button><button data-action="key" data-text="Tab">Tab</button><button data-action="key" data-text="Ctrl+C">Ctrl+C</button><button data-action="key" data-text="↑">↑</button><button data-action="key" data-text="↓">↓</button></div>' : ''}
      <div class="pinned">${data.commands.slice(0,3).map(item => `<button data-action="insert" data-id="${item.id}">${escape(item.title)}</button>`).join('')}</div>
      <div class="composer">${state.attachment ? `<div class="attachment">${escape(state.attachment)}<button data-action="remove-file" aria-label="移除附件">×</button></div>` : ''}<textarea id="draft" aria-label="命令草稿" placeholder="输入命令或告诉 Agent 要做什么…">${escape(state.draft)}</textarea><div class="toolbar"><button class="icon-button plus ${state.menu ? 'active' : ''}" data-action="menu" aria-label="更多操作" aria-expanded="${state.menu}">${icon('plus')}</button><div class="model"><span>✦</span> ${escape(data.model)}</div><button class="icon-button shortcut-toggle" data-action="keyboard" aria-label="终端快捷键" aria-expanded="${state.shortcuts}" aria-controls="terminal-shortcuts">${icon('keyboard')}</button><button class="icon-button send" data-action="send" aria-label="发送" ${!state.draft.trim() && !state.attachment ? 'disabled' : ''}>${icon('arrow')}</button></div></div>
    </section>${keyboard()}${menu()}${sheet()}${state.toast ? `<div class="toast" role="status">${escape(state.toast)}</div>` : ''}<div class="home"></div>
  </section>`;
}

function notify(message) {
  state.toast = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = ''; render(); }, 2800);
}

function openLibrary() {
  state.menu = false;
  state.query = '';
  state.mode = 'insert';
  state.sheet = 'library';
}

app.addEventListener('input', event => {
  if (event.target.id === 'draft') {
    state.draft = event.target.value;
    const send = app.querySelector('[data-action="send"]');
    send.disabled = !state.draft.trim() && !state.attachment;
  }
  if (event.target.id === 'search') {
    state.query = event.target.value;
    document.querySelector('#command-list').innerHTML = commandRows();
  }
});

app.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const item = data.commands.find(command => command.id === button.dataset.id);
  switch (action) {
    case 'menu': state.menu = !state.menu; break;
    case 'dismiss-menu': state.menu = false; break;
    case 'quick': openLibrary(); break;
    case 'mode-insert': state.mode = 'insert'; break;
    case 'mode-background': state.mode = 'background'; break;
    case 'close-sheet': state.sheet = null; break;
    case 'back-library': state.sheet = 'library'; break;
    case 'insert':
      state.draft += (state.draft ? '\n' : '') + item.body;
      state.sheet = null; state.menu = false; break;
    case 'run':
      state.runs[item.id] = 'queued'; break;
    case 'detail': state.selectedId = item.id; state.sheet = 'detail'; break;
    case 'queue':
    case 'send':
      state.terminalFeedback = action === 'queue' ? '已加入 Agent 队列' : '已发送';
      notify(state.terminalFeedback); state.draft = ''; state.attachment = null; state.menu = false; break;
    case 'files': state.sheet = 'files'; state.menu = false; break;
    case 'photos':
    case 'file-picker':
      state.attachment = data.files.find(file => file.source === (action === 'photos' ? 'photos' : 'files')).name;
      state.sheet = null; break;
    case 'remove-file': state.attachment = null; break;
    case 'instant': state.instant = !state.instant; state.menu = false; break;
    case 'keyboard': state.shortcuts = !state.shortcuts; state.menu = false; break;
    case 'instant-send': notify(`已发送“${button.dataset.text}”`); break;
    case 'key': notify(`已发送 ${button.dataset.text}`); break;
  }
  render();
  if (action === 'insert') {
    const draft = document.querySelector('#draft');
    draft.focus({ preventScroll:true });
    draft.setSelectionRange(draft.value.length, draft.value.length);
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    state.sheet = null; state.menu = false; render();
  }
});

async function start() {
  if (params.has('gallery')) {
    app.innerHTML = `<div class="gallery" data-prototype-helper="true">${[['menu','01 / 加号菜单 · 快捷键独立'],['quick','02 / 快捷指令 · 填入'],['background','03 / 快捷指令 · 后台运行']].map(([view,label]) => `<figure><figcaption>${label}</figcaption><iframe src="./?state=${view}" title="${label}"></iframe></figure>`).join('')}</div>`;
    return;
  }
  const response = await fetch('./mock-state.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  data = await response.json();
  const initial = params.get('state') || 'menu';
  if (params.get('queue') === 'unsupported') data.queueSupported = false;
  state = {
    menu: initial === 'menu', sheet: ['quick','background'].includes(initial) ? 'library' : null,
    mode: initial === 'background' ? 'background' : 'insert',
    draft: params.has('empty') ? '' : data.draft,
    query: '', runs: {}, attachment: null, instant: false, shortcuts: false, toast: '',
  };
  if (params.has('emptyCommands')) data.commands = [];
  render();
}
start().catch(error => { app.textContent = `原型加载失败：${error.message}`; });
