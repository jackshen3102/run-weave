const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const desktop = params.get('surface') === 'desktop';
const storageKey = `runweave-prototype-message-sidechat-v2:${params.get('scope') || 'review'}`;
const clientKey = 'runweave-prototype-sidechat-client';
const clientID = params.get('client') || sessionStorage.getItem(clientKey) || crypto.randomUUID();
sessionStorage.setItem(clientKey, clientID);
const draftStorageKey = `${storageKey}:drafts:${clientID}`;
const paths = {
  back: '<path d="m14 5-7 7 7 7"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H9l-5 3v-6a8 8 0 1 1 17-5Z"/><path d="M8 9h8M8 13h5"/>',
  edit: '<path d="M13 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M10 14l1-4L20 1l3 3-9 9-4 1Z"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  book: '<path d="M12 5c-3-3-7-3-10-2v15c4-1 7 0 10 2 3-2 6-3 10-2V3c-3-1-7-1-10 2Zm0 0v15"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 22h8M12 17v5"/>',
  wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r=".7"/>',
  signal: '<path d="M3 20v-4M8 20v-8M13 20V8M18 20V4" stroke-width="3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  arrow: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  branch: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="20" r="2"/><path d="M6 6v12M6 14c8 0 12-2 12-6"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.chat}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action, label, name, cls = 'icon-button') => `<button class="${cls}" data-action="${action}" aria-label="${label}">${icon(name)}</button>`;
let data;
let chat = null;
let replyTimer;
let toastTimer;
let savedDrafts = [];
try { savedDrafts = JSON.parse(localStorage.getItem(draftStorageKey) || '[]'); } catch { /* Empty local draft fixture. */ }
const state = {
  view: 'main', activeTab: 'codex', mainComposer: false, mainDraft: '', mainCursor: [0, 0],
  drafts: new Map(savedDrafts), menu: false, confirm: false, context: false, mainRunning: true,
  mainMessages: [], seen: new Map(), scroll: new Map(), error: '', toast: '', pendingDraft: null,
  offline: params.has('offline'), supported: params.get('supported') !== '0',
};
function draft() {
  if (!chat) return {text: '', cursor: [0, 0], revision: 0};
  if (!state.drafts.has(chat.id)) state.drafts.set(chat.id, {text: '', cursor: [0, 0], revision: 0});
  return state.drafts.get(chat.id);
}
function readChat() {
  try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { return null; }
}
function saveChat() {
  localStorage.setItem(storageKey, JSON.stringify(chat));
  scheduleReply();
}
function createChat() {
  chat = {id: crypto.randomUUID(), status: 'active', version: 1, source: data.source, turns: []};
  state.seen.set(chat.id, 0);
  state.error = '';
  saveChat();
}
function pendingTurn() { return chat?.turns.find(turn => ['running', 'unknown'].includes(turn.status)); }
function hasUnread() {
  return chat?.status === 'active' && chat.turns.filter(turn => turn.status === 'completed').length > (state.seen.get(chat.id) || 0);
}
function remember() {
  const input = app.querySelector('textarea');
  if (input) {
    const selected = [input.selectionStart, input.selectionEnd];
    if (state.view === 'side') draft().cursor = selected;
    else state.mainCursor = selected;
  }
  const scroller = app.querySelector('.messages, .terminal-output');
  if (scroller) state.scroll.set(`${state.activeTab}:${state.view}:${chat?.id || ''}`, scroller.scrollTop);
  localStorage.setItem(draftStorageKey, JSON.stringify([...state.drafts]));
}
function statusBar() {
  return `<div class="status" aria-hidden="true"><span>9:41</span><span class="status-icons">${icon('signal')}${icon('wifi')}<i class="battery"></i></span></div>`;
}
function sideEntry(cls = 'side-trigger') {
  if (!state.supported) return '';
  const label = chat?.status === 'active' ? '返回旁聊' : '旁聊';
  return `<button class="${cls}" data-action="open-side" ${state.offline ? 'disabled' : ''} aria-label="${label}${hasUnread() ? '，有新回复' : ''}">${icon('chat')}<span>${label}</span>${hasUnread() ? '<i class="unread" aria-hidden="true"></i>' : ''}</button>`;
}
function mobileHeader() {
  if (state.view === 'side') return `<header class="nav side-nav"><button class="return-main" data-action="return">${icon('back')}主对话</button><div class="nav-title"><h1>旁聊</h1><p>${escape(data.terminal.project)}</p></div>${button('menu', '旁聊操作', 'more')}</header>`;
  return `<header class="nav"><span class="icon-button nav-back" aria-hidden="true">${icon('back')}</span><div class="nav-title"><h1>Codex <span>/ ${escape(data.terminal.project)}</span></h1><p><span class="dot"></span>${escape(data.terminal.computer)} · ${state.offline ? '离线' : '已连接'}</p></div><div class="nav-actions" aria-hidden="true"><span class="icon-button">${icon('book')}</span><span class="icon-button">${icon('monitor')}</span><span class="icon-button">${icon('more')}</span></div></header><nav class="mobile-tabs"><span class="selected">终端</span><span>变更 <small>2</small></span><span>文件</span><span>快捷指令</span></nav>`;
}
function terminalContent() {
  if (state.activeTab === 'server') return '<div class="server-output"><p>~/Code/browser-viewer</p><p><span class="mint">❯</span> pnpm dev</p><p>VITE ready in 342 ms</p><p>Local: http://localhost:3000/</p><span class="cursor">▌</span></div>';
  return `<div class="terminal-brand"><strong>OpenAI Codex</strong><br><span>model: ${escape(data.terminal.model)}<br>directory: ~/Code/browser-viewer</span></div><div class="terminal-query">${escape(data.terminal.task)}</div>${data.mainOutput.map(line => {
    if (line.type === 'tool') return `<div class="tool-line">${icon('check')}${escape(line.text)}</div>`;
    if (line.type === 'progress') return `<div class="terminal-progress">${state.mainRunning ? '<i class="spinner"></i>' : icon('stop')}<span>${state.mainRunning ? escape(line.text) : '已停止执行'}</span></div>`;
    return `<div class="terminal-answer">${escape(line.text)}</div>`;
  }).join('')}${state.mainMessages.map(text => `<div class="terminal-query">${escape(text)}</div>`).join('')}`;
}
function mainComposer() {
  if (!state.mainComposer) return '';
  return `<section class="main-composer" aria-label="主对话输入"><div class="composer-label"><span>主对话 · Codex</span>${button('hide-main-composer', '收起输入', 'down')}</div><div class="main-input-card"><textarea aria-label="主对话草稿" placeholder="输入命令或告诉 Agent 要做什么…">${escape(state.mainDraft)}</textarea><div class="composer-tools"><span class="model">${escape(data.terminal.model)}</span>${sideEntry('input-side')}<button class="send" data-action="send-main" aria-label="发送到主对话" ${state.offline || !state.mainDraft.trim() ? 'disabled' : ''}>${icon('arrow')}</button></div></div></section>`;
}
function mainView() {
  return `<section class="main-view"><div class="terminal-stage"><div class="terminal-output" aria-label="主终端内容" data-terminal-id="${data.terminal.id}">${terminalContent()}</div>${state.activeTab === 'codex' && !state.mainComposer ? `<div class="floating"><span class="reply-assist" aria-hidden="true">${icon('chat')}回复辅助</span>${state.mainRunning ? `<button class="stop-terminal" data-action="stop-main" aria-label="停止主任务" ${state.offline ? 'disabled' : ''}>${icon('stop')}</button>` : ''}<div class="entry-row">${sideEntry()}<button class="edit" data-action="compose-main" aria-label="打开终端输入" ${state.offline ? 'disabled' : ''}>${icon('edit')}${state.mainDraft ? '<i class="draft-dot"></i>' : ''}</button></div></div>` : ''}</div>${mainComposer()}</section>`;
}
function contextStrip() {
  return `<div class="chat-context"><button data-action="context" aria-label="查看旁聊上下文">${icon('branch')}<span>主对话 · ${escape(chat.source.label)}</span>${icon('down')}</button><span class="main-status"><i class="dot"></i>主任务${state.mainRunning ? '运行中' : '已停止'}</span></div>`;
}
function messages() {
  if (!chat.turns.length) return `<div class="empty-chat"><span class="empty-icon">${icon('chat')}</span><h2>聊聊当前任务</h2><p>有什么想进一步了解的？</p></div>`;
  return `<div class="message-list">${chat.turns.map(turn => `<article class="turn" data-turn-id="${turn.id}"><div class="user-message">${escape(turn.question)}</div><div class="assistant-row"><div class="assistant-avatar">${icon('chat')}</div><div class="assistant-content">${turn.status === 'completed' ? `<div class="final-answer">${turn.paragraphs.map(p => `<p>${escape(p)}</p>`).join('')}</div><button class="copy-answer" data-action="copy-answer" data-turn-id="${turn.id}" aria-label="复制回答">${icon('copy')}</button>` : turn.status === 'running' ? '<div class="reply-status" role="status"><i class="spinner"></i>正在回答…</div>' : turn.status === 'stopped' ? '<div class="reply-status">回答已停止</div>' : turn.status === 'unknown' ? '<div class="reply-status unknown">发送结果待确认</div><button class="text-action" data-action="check-send">检查发送结果</button>' : '<div class="reply-status failed">这次回复未完成，请重新提问。</div>'}</div></div></article>`).join('')}</div>`;
}
function sideComposer() {
  if (chat.status === 'ended') return `${draft().text ? '<div class="retained-draft" role="alert">未发送文字已保留。<button class="text-action" data-action="copy-draft">复制草稿</button></div>' : ''}<div class="ended-chat"><span>旁聊已结束</span><button data-action="new-chat">新旁聊 ${icon('plus')}</button></div>`;
  const current = pendingTurn();
  const stop = current?.status === 'running';
  return `<section class="chat-composer" aria-label="旁聊消息输入">${state.error ? `<div class="send-error" role="alert">${escape(state.error)}</div>` : ''}<div class="chat-input-card"><textarea aria-label="旁聊草稿" placeholder="问点什么…" ${state.offline ? 'disabled' : ''}>${escape(draft().text)}</textarea><div class="composer-tools"><span class="model">${escape(data.terminal.model)}</span><button class="send ${stop ? 'stop-reply' : ''}" data-action="${stop ? 'stop-side' : 'send-side'}" aria-label="${stop ? '停止旁聊回答' : '发送到旁聊'}" ${state.offline || (!stop && (Boolean(current) || !draft().text.trim())) ? 'disabled' : ''}>${icon(stop ? 'stop' : 'arrow')}</button></div></div></section>`;
}
function sideView() {
  return `<section class="chat-view" data-chat-id="${chat.id}">${desktop ? `<header class="desktop-chat-header"><button class="return-main" data-action="return">${icon('back')}返回主对话</button><span class="chat-title">旁聊</span>${button('menu', '旁聊操作', 'more')}</header>` : ''}${contextStrip()}<div class="messages" aria-label="旁聊消息">${messages()}</div>${sideComposer()}</section>`;
}
function overlays() {
  return `${state.menu ? `<button class="menu-backdrop" data-action="dismiss-menu" aria-label="关闭菜单"></button><div class="popover" role="menu"><button class="destructive" role="menuitem" data-action="ask-end" ${chat?.status !== 'active' || state.offline ? 'disabled' : ''}>${icon('close')}结束旁聊</button></div>` : ''}${state.confirm ? `<div class="modal-backdrop"><section class="modal" role="alertdialog" aria-modal="true" aria-labelledby="end-title"><h2 id="end-title">结束旁聊？</h2><p>${pendingTurn() ? '当前回答会停止。' : ''}结束后无法继续这段旁聊，未发送草稿将清除。</p><button class="destructive" data-action="end">结束旁聊</button><button data-action="cancel-end">取消</button></section></div>` : ''}${state.context ? `<div class="modal-backdrop"><section class="modal context-modal" role="dialog" aria-modal="true" aria-labelledby="context-title"><header><h2 id="context-title">旁聊上下文</h2>${button('close-context', '关闭上下文', 'close')}</header><div class="context-origin">${icon('branch')}主对话 · ${escape(chat.source.label)}</div><p class="context-summary">${escape(chat.source.summary)}</p><div class="context-excerpt"><span>你</span><p>${escape(chat.source.question)}</p><span>Codex</span><p>${escape(chat.source.answer)}</p></div><button data-action="close-context">完成</button></section></div>` : ''}${state.toast ? `<div class="toast" role="status">${escape(state.toast)}</div>` : ''}`;
}
function desktopShell(content) {
  const isSide = state.view === 'side';
  return `<header class="desktop-chrome"><span class="traffic" aria-hidden="true"><i></i><i></i><i></i></span><span class="brand">Runweave</span><span class="host">${icon('monitor')} ${escape(data.terminal.computer)} <i class="dot"></i></span></header><div class="desktop-body"><aside class="project-rail"><div class="rail-title">项目 <span>＋</span></div><div class="project active">⌄ <span>browser-viewer</span><i class="dot"></i></div><div class="worktree">${icon('branch')} main</div><div class="project">› <span>runweave-docs</span></div><div class="rail-footer">${icon('monitor')} 本机 <span>⋯</span></div></aside><section class="desktop-workspace"><header class="workspace-header"><span>browser-viewer <small>/ main</small></span><span class="workspace-tools">${icon('book')}${icon('more')}</span></header><nav class="session-tabs" aria-label="终端 Tab"><button class="session-tab ${state.activeTab === 'codex' ? 'active' : ''}" data-tab="codex" data-terminal-id="${data.terminal.id}">${isSide ? icon('chat') : '<i class="dot"></i>'}<span>${isSide ? '旁聊 · Codex' : 'Codex'}</span>${hasUnread() && !isSide ? '<i class="unread"></i>' : ''}</button><button class="session-tab ${state.activeTab === 'server' ? 'active' : ''}" data-tab="server"><span>开发服务</span></button><span class="new-tab" aria-hidden="true">＋</span></nav><div class="desktop-stage"><section class="desktop-center">${content}</section><aside class="browser-pane"><div class="browser-tabs"><span class="selected">Browser</span><span>文件</span><span>变更 <small>2</small></span></div><div class="browser-address">${icon('back')}<span>localhost:3000</span>${icon('more')}</div><div class="browser-content"><span class="browser-logo">R</span><h2>Runweave</h2><p>Workspace is ready.</p><div class="preview-card"><i class="dot"></i> browser-viewer <small>main</small></div></div></aside></div></section></div>`;
}
function render({focus = false, bottom = false} = {}) {
  const side = state.view === 'side' && state.activeTab === 'codex';
  if (side && chat) state.seen.set(chat.id, chat.turns.filter(t => t.status === 'completed').length);
  app.className = desktop ? 'desktop-app' : 'phone';
  app.classList.toggle('side', side);
  document.body.classList.toggle('desktop-preview', desktop);
  const content = side ? sideView() : mainView();
  app.innerHTML = `${desktop ? desktopShell(content) : `${statusBar()}${mobileHeader()}${content}<div class="home-bar" aria-hidden="true"></div>`}${state.offline ? '<div class="offline-banner" role="status">电脑离线，暂时无法发送</div>' : ''}${overlays()}`;
  const output = app.querySelector('.messages, .terminal-output');
  if (output) output.scrollTop = bottom ? output.scrollHeight : state.scroll.get(`${state.activeTab}:${state.view}:${chat?.id || ''}`) || 0;
  if (focus) {
    const input = app.querySelector('textarea');
    if (input && !input.disabled) {
      input.focus({preventScroll: true});
      input.setSelectionRange(...(side ? draft().cursor : state.mainCursor));
    }
  }
  if (state.confirm) app.querySelector('[data-action="cancel-end"]').focus();
  if (state.context) app.querySelector('[data-action="close-context"]').focus();
}
function updateSend() {
  const input = app.querySelector('textarea');
  if (!input) return;
  const send = app.querySelector('[data-action="send-side"], [data-action="send-main"]');
  if (send) send.disabled = state.offline || !input.value.trim() || (state.view === 'side' && Boolean(pendingTurn()));
}
function openSide() {
  if (state.offline || !state.supported) return;
  chat = readChat();
  if (!chat || chat.status === 'ended') createChat();
  state.view = 'side'; state.activeTab = 'codex'; state.menu = false; state.mainComposer = false;
  render({focus: true, bottom: true});
}
function scheduleReply() {
  clearTimeout(replyTimer);
  const turn = chat?.turns.find(t => t.status === 'running');
  if (!turn) return;
  const chatID = chat.id;
  replyTimer = setTimeout(() => {
    const fresh = readChat();
    const current = fresh?.turns.find(t => t.id === turn.id);
    if (fresh?.id !== chatID || fresh.status !== 'active' || current?.status !== 'running') return;
    current.status = current.replyMode === 'fail' ? 'failed' : 'completed';
    if (current.status === 'completed') current.paragraphs = data.answers.find(a => new RegExp(a.match, 'i').test(current.question)).paragraphs;
    fresh.version++;
    remember();
    const editing = document.activeElement?.tagName === 'TEXTAREA';
    chat = fresh; saveChat(); render({focus: editing, bottom: state.view === 'side'});
  }, Math.max(0, turn.dueAt - Date.now()));
}
function sendSide() {
  if (state.offline || chat?.status !== 'active' || pendingTurn()) return;
  const fresh = readChat();
  if (fresh?.id !== chat.id || fresh.status !== 'active' || fresh.turns.some(t => ['running', 'unknown'].includes(t.status))) {
    state.error = '旁聊状态已变化，请核对后发送。'; render({focus: true}); return;
  }
  chat = fresh;
  const text = draft().text.trim();
  if (!text) return;
  if (params.get('send') === 'reject') {
    state.error = '发送失败，草稿已保留。'; render({focus: true}); return;
  }
  const unknown = params.get('send') === 'unknown';
  chat.turns.push({id: crypto.randomUUID(), question: text, status: unknown ? 'unknown' : 'running', paragraphs: null, dueAt: Date.now() + data.replyDelayMs, replyMode: params.get('reply') || 'complete'});
  chat.version++;
  state.error = '';
  if (unknown) state.pendingDraft = {chatID: chat.id, revision: draft().revision};
  else { draft().text = ''; draft().cursor = [0, 0]; draft().revision++; }
  saveChat(); remember(); render({focus: true, bottom: true});
}
function stopSide() {
  if (state.offline) return;
  const fresh = readChat();
  if (fresh?.id !== chat?.id) return;
  chat = fresh;
  const turn = chat?.turns.find(t => t.status === 'running');
  if (!turn) return;
  turn.status = 'stopped'; chat.version++; saveChat(); render({focus: true, bottom: true});
}
function toast(message) {
  state.toast = message; clearTimeout(toastTimer); render();
  toastTimer = setTimeout(() => { state.toast = ''; remember(); render({focus: document.activeElement?.tagName === 'TEXTAREA'}); }, 1700);
}
app.addEventListener('input', event => {
  if (event.target.tagName !== 'TEXTAREA') return;
  if (state.view === 'side') { draft().text = event.target.value; draft().revision++; }
  else state.mainDraft = event.target.value;
  localStorage.setItem(draftStorageKey, JSON.stringify([...state.drafts]));
  updateSend();
});
app.addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target || target.disabled) return;
  remember();
  if (target.dataset.tab) {
    state.activeTab = target.dataset.tab;
    state.mainComposer = false; render(); return;
  }
  switch (target.dataset.action) {
    case 'open-side': openSide(); break;
    case 'return': state.view = 'main'; state.mainComposer = false; state.menu = false; render(); break;
    case 'compose-main': state.mainComposer = true; render({focus: true}); break;
    case 'hide-main-composer': state.mainComposer = false; render(); break;
    case 'send-main':
      if (!state.mainDraft.trim() || state.offline) break;
      state.mainMessages.push(state.mainDraft.trim()); state.mainDraft = ''; state.mainCursor = [0, 0]; state.mainComposer = false; render({bottom: true}); break;
    case 'stop-main': state.mainRunning = false; render(); break;
    case 'send-side': sendSide(); break;
    case 'stop-side': stopSide(); break;
    case 'check-send': {
      const turn = pendingTurn();
      if (!turn || state.offline) break;
      turn.status = 'running'; turn.dueAt = Date.now() + data.replyDelayMs; chat.version++;
      if (state.pendingDraft?.chatID === chat.id && state.pendingDraft.revision === draft().revision) {
        draft().text = ''; draft().cursor = [0, 0]; draft().revision++;
      }
      state.pendingDraft = null; saveChat(); localStorage.setItem(draftStorageKey, JSON.stringify([...state.drafts])); render({focus: true}); break;
    }
    case 'menu': state.menu = !state.menu; render(); break;
    case 'dismiss-menu': state.menu = false; render(); break;
    case 'ask-end': state.menu = false; state.confirm = true; render(); break;
    case 'cancel-end': state.confirm = false; render(); break;
    case 'end':
      if (readChat()?.id !== chat.id) { state.confirm = false; render(); break; }
      chat = readChat();
      chat.status = 'ended'; chat.turns.forEach(t => { if (['running', 'unknown'].includes(t.status)) t.status = 'stopped'; });
      chat.version++; state.drafts.delete(chat.id); state.confirm = false; state.view = 'main'; state.mainComposer = false;
      saveChat(); localStorage.setItem(draftStorageKey, JSON.stringify([...state.drafts])); toast('旁聊已结束'); break;
    case 'new-chat': openSide(); break;
    case 'context': state.context = true; render(); break;
    case 'close-context': state.context = false; render({focus: true}); break;
    case 'copy-answer': {
      const turn = chat.turns.find(t => t.id === target.dataset.turnId);
      try { await navigator.clipboard.writeText(turn.paragraphs.join('\n\n')); toast('已复制回答'); }
      catch { toast('请选中文字复制'); }
      break;
    }
    case 'copy-draft':
      try { await navigator.clipboard.writeText(draft().text); toast('已复制草稿'); }
      catch { toast('请选中文字复制'); }
      break;
  }
});
app.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    remember(); state.menu = false; state.context = false; state.confirm = false; state.mainComposer = false; render();
  }
  if (event.key === 'Tab' && (state.confirm || state.context)) {
    const buttons = [...app.querySelectorAll('.modal button')];
    const index = buttons.indexOf(document.activeElement);
    event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  }
});
window.addEventListener('storage', event => {
  if (event.key !== storageKey || !data) return;
  remember();
  const editing = document.activeElement?.tagName === 'TEXTAREA';
  const fresh = readChat();
  if (state.view === 'side' && chat && fresh?.id !== chat.id) {
    chat.status = 'ended';
    chat.turns.forEach(turn => { if (['running', 'unknown'].includes(turn.status)) turn.status = 'stopped'; });
  } else chat = fresh;
  if (chat && !state.seen.has(chat.id)) state.seen.set(chat.id, 0);
  scheduleReply(); render({focus: editing});
});
fetch('./mock-state.json').then(response => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}).then(initial => {
  data = initial;
  state.mainDraft = data.mainDraft;
  state.mainCursor = [data.mainDraft.length, data.mainDraft.length];
  chat = readChat();
  if (chat) state.seen.set(chat.id, chat.turns.filter(t => t.status === 'completed').length);
  const view = params.get('view');
  if (['side', 'conversation', 'returned'].includes(view)) {
    if (!chat || chat.status === 'ended') createChat();
    if (view !== 'side' && !chat.turns.length) {
      chat.turns.push({id: crypto.randomUUID(), question: data.sampleQuestion, status: 'completed', paragraphs: data.answers[0].paragraphs});
      chat.version++; saveChat();
    }
    state.view = view === 'returned' ? 'main' : 'side';
    if (view === 'returned') state.seen.set(chat.id, 0);
  }
  scheduleReply(); render({bottom: true});
}).catch(error => { app.textContent = `原型加载失败：${error.message}`; });
