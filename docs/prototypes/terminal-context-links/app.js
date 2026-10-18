const app = document.querySelector('#app');
const overlay = document.querySelector('#overlay');
const params = new URLSearchParams(location.search);
const paths = {
  terminal: '<path d="m4 6 6 6-6 6M13 18h7"/>',
  folder: '<path d="M3 6h6l2 3h10v11H3Z"/>',
  link: '<path d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  document: '<path d="M5 3h10l4 4v14H5ZM15 3v5h4M8 12h8M8 16h6"/>',
  chat: '<path d="M4 4h16v13H9l-5 4V4Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  send: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let data;
const state = {
  sessionId: params.get('state') === 'unlinked' ? 'research' : 'review',
  panel: 'handoff', panelOpen: true, expanded: false, menu: false,
  drafts: {}, highlight: null, notice: '', modal: null, selectedRecord: null,
  query: '', expectedVersion: null, recordPreview: null, conflict: false, conflictInjected: false,
};
const session = () => data.sessions.find(item => item.id === state.sessionId);
const record = () => data.records.find(item => item.id === session().recordId);
const actionButton = (action, text, style = '', attrs = '') => `<button type="button" class="button ${style}" data-action="${action}" ${attrs}>${text}</button>`;
const iconButton = (action, name, label) => `<button type="button" class="icon-button" aria-label="${label}" title="${label}" data-action="${action}">${icon(name)}</button>`;

function render() {
  const current = session();
  app.innerHTML = `
    <header class="topbar">
      <div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>
      <strong class="brand">Runweave</strong><span class="project-tab">browser-viewer <span class="dot"></span></span>
      <span class="connection"><span class="dot"></span>${esc(data.connection)} · 已连接</span>
    </header>
    <div class="workspace">
      <aside class="projects" aria-label="工作区">
        <div class="rail-heading">工作区 <span>＋</span></div>
        <div class="project-name">${icon('folder')} browser-viewer</div>
        <div class="worktree-label"><span>⌄</span> wt-1 <span class="branch">worktree</span></div>
        ${data.sessions.filter(item => item.worktree === 'wt-1').map(renderSession).join('')}
        <div class="worktree-label second"><span>⌄</span> wt-2 <span class="branch">worktree</span></div>
        ${data.sessions.filter(item => item.worktree === 'wt-2').map(renderSession).join('')}
        <div class="rail-bottom">${icon('folder')} 本地项目 <span>⋯</span></div>
      </aside>
      <section class="terminal" aria-label="终端会话">
        <div class="terminal-tabs"><span class="active-terminal">${icon('terminal')}${esc(current.name)}</span><span class="thread-id">${esc(current.thread)}</span>${iconButton('open-panel', 'document', '打开任务交接')}</div>
        <div class="terminal-scroll" id="terminal-log"><div class="cwd">~/Code/browser-hub/browser-viewer/.worktree/${esc(current.worktree)}</div>
          ${current.messages.map(renderMessage).join('')}
          <div class="terminal-ready"><span class="dot"></span>Codex 已空闲</div>
        </div>
        <form id="message-form" class="composer"><div class="compose-row"><span class="prompt">›</span><textarea id="message" aria-label="发送消息给当前 Agent" placeholder="发送消息给当前 Agent…" rows="2">${esc(state.drafts[current.id] ?? '')}</textarea><button type="submit" class="send-button" aria-label="发送消息">${icon('send')}</button></div><div class="composer-meta"><span>Codex <span class="separator">/</span> 当前会话</span><span>${esc(current.worktree)}</span></div></form>
      </section>
      <aside class="sidecar ${state.panelOpen ? '' : 'hidden'} ${state.expanded ? 'expanded' : ''}" aria-label="任务交接侧栏">
        <div class="sidecar-tabs"><span class="inactive-tab">Preview</span><span class="inactive-tab">Browser</span><button class="active-tool" data-action="home">任务交接</button><span class="grow"></span>${iconButton('expand','expand','展开侧栏')}${iconButton('close-panel','close','关闭侧栏')}</div>
        <div id="panel">${state.panel === 'record' && record() ? renderRecord() : renderHandoff()}</div>
      </aside>
    </div>`;
  if (state.highlight) requestAnimationFrame(() => document.getElementById(`message-${state.highlight}`)?.scrollIntoView({block:'center',behavior:'instant'}));
  renderModal();
}

function renderSession(item) {
  return `<button class="session ${item.id === state.sessionId ? 'selected' : ''}" data-session="${item.id}" aria-current="${item.id === state.sessionId ? 'true' : 'false'}"><span class="dot ${item.id === 'research' ? 'blue' : ''}"></span><span>${esc(item.name)}</span>${item.recordId ? icon('link') : ''}</button>`;
}
function renderMessage(message) {
  return `<article id="message-${esc(message.id)}" class="exchange ${message.role} ${state.highlight === message.id ? 'located' : ''}"><div class="message-meta"><span>${message.role === 'user' ? '› 你' : '● Codex'}</span><time>${esc(message.time)}</time></div><p>${esc(message.text)}</p>${message.items ? `<ul>${message.items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}${message.footnote ? `<p class="message-footnote">${esc(message.footnote)}</p>` : ''}${state.highlight === message.id ? '<span class="located-label">已定位到原始回复</span>' : ''}</article>`;
}
function renderHandoff() {
  const linked = record();
  const current = session();
  const lastUser = current.messages.filter(item => item.role === 'user').at(-1);
  return `<header class="panel-header"><div class="row between"><h1>任务交接</h1>${linked ? `${iconButton('menu','more','关联操作')}${state.menu ? '<div class="menu"><button data-action="unlink">解除当前会话关联</button></div>' : ''}` : actionButton('associate',`${icon('link')}关联随记`,'small')}</div><div class="panel-subtitle">${icon('chat')}当前会话 <span>·</span> ${esc(current.worktree)}</div></header>
    <div class="panel-body">
      ${state.notice ? `<div class="notice" role="status">${icon('info')}<span>${esc(state.notice)}</span></div>` : ''}
      ${linked ? `<div class="linked-record"><div class="row between"><span class="eyebrow">${icon('link')}关联随记</span><span class="record-status">${esc(linked.status)}</span></div><h2>${esc(linked.title)}</h2><button class="text-button" data-action="record">查看原文与跟进 ${icon('arrow')}</button></div>
        <section class="section"><div class="section-heading"><h3>原始要求</h3><button class="text-button" data-action="record">随记原文 ${icon('chevron')}</button></div><blockquote>${esc(linked.body)}</blockquote></section>
        <section class="section"><div class="section-heading"><h3>后续补充</h3><span class="small-muted">${esc(linked.supplementTime)}</span></div><blockquote class="supplement">${esc(linked.supplement)}</blockquote><div class="quote-source">你 · 随记跟进</div></section>` : `<div class="unlinked"><span class="unlinked-icon">${icon('chat')}</span><h2>当前会话</h2><p>还没有关联随记</p></div>`}
      <section class="section"><div class="section-heading"><h3>本轮最新输入</h3><button class="text-button" data-action="locate-latest">定位 ${icon('chevron')}</button></div><blockquote>${esc(lastUser?.text ?? '暂无输入')}</blockquote><div class="quote-source">你 · ${esc(lastUser?.time)}</div></section>
      ${linked?.result ? renderResult(linked) : renderCurrentReply()}
      ${linked ? `<section class="section sessions-section"><div class="section-heading"><h3>相关会话</h3><span class="small-muted">${data.sessions.filter(item=>item.recordId === linked.id).length}</span></div>${data.sessions.filter(item=>item.recordId === linked.id).map(item => `<button class="conversation-row" data-related-session="${item.id}">${icon('terminal')}<span class="grow"><span class="conversation-name">${esc(item.name)}</span><span class="small-muted">${esc(item.worktree)} · ${esc(item.thread)}</span></span><span class="small-muted">${item.id === current.id ? '当前' : icon('chevron')}</span></button>`).join('')}</section>` : ''}
    </div><footer class="panel-footer"><span class="small-muted">${linked ? '随记原文与会话记录' : '当前会话记录'}</span>${actionButton('locate-latest',`回到本轮对话 ${icon('arrow')}`,'small ghost')}</footer>`;
}
function renderResult(linked) {
  const result = linked.result;
  return `<section class="section result-section"><div class="section-heading"><h3>已有成果</h3><span class="report-label">Agent 报告</span></div><h2 class="result-title">${esc(result.title)}</h2><p class="result-body">${esc(result.body)}</p><div class="evidence-list">${result.evidence.map((item,index)=>`<button class="evidence-row" data-evidence="${index}"><span class="evidence-icon">${icon('document')}</span><span class="grow">${esc(item.label)}</span>${icon('chevron')}</button>`).join('')}</div><div class="pending-note"><span class="pending-dot"></span><span>${esc(result.limit)}</span></div><div class="result-bottom"><span class="small-muted">${esc(result.time)}</span><button class="text-button" data-action="origin">回到原会话 ${icon('arrow')}</button></div></section>`;
}
function renderCurrentReply() {
  const reply = session().messages.filter(item => item.role === 'assistant').at(-1);
  if (!reply) return '';
  return `<section class="section"><div class="section-heading"><h3>最近回复</h3><span class="report-label">Agent 报告</span></div><p class="result-body">${esc(reply.text)}</p>${reply.footnote ? `<p class="small-muted reply-note">${esc(reply.footnote)}</p>` : ''}</section>`;
}
function renderRecord() {
  const linked = record();
  return `<header class="panel-header"><div class="row"><button class="icon-button" aria-label="返回任务交接" data-action="home">${icon('back')}</button><h1>随记</h1><span class="grow"></span><span class="record-status">${esc(linked.status)}</span></div></header><div class="panel-body record-reader"><div class="eyebrow">待办 · ${esc(linked.date)}</div><h2>${esc(linked.title)}</h2><p>${esc(linked.body)}</p><div class="reader-divider"></div><div class="section-heading"><h3>跟进</h3><span class="small-muted">${linked.result ? 2 : 1} 条</span></div><article class="followup"><div class="row between"><strong>你</strong><span class="small-muted">${esc(linked.supplementTime)}</span></div><p>${esc(linked.supplement)}</p></article>${linked.result ? `<article class="followup"><div class="row between"><strong>Codex</strong><span class="small-muted">${esc(linked.result.time)}</span></div><p>${esc(linked.result.body)}</p><p class="small-muted">${esc(linked.result.limit)}</p><button class="text-button" data-action="origin">回到原会话 ${icon('arrow')}</button></article>` : ''}</div><footer class="panel-footer">${actionButton('home',`${icon('back')} 返回任务交接`,'small ghost')}</footer>`;
}

function renderModal() {
  if (!state.modal) { overlay.innerHTML = ''; return; }
  const isPicker = state.modal === 'associate';
  const selected = state.recordPreview;
  const evidence = !isPicker ? record()?.result?.evidence[state.modal.index] : null;
  overlay.innerHTML = `<div class="modal-backdrop"><section class="dialog" role="dialog" aria-modal="true" aria-label="${isPicker ? '关联随记' : '验证记录'}"><header class="dialog-header"><h2>${isPicker ? '关联随记' : esc(evidence.label)}</h2>${iconButton('close-modal','close','关闭对话框')}</header>${isPicker ? `<div class="dialog-body"><div class="search">${icon('search')}<input id="record-search" aria-label="搜索随记" placeholder="搜索随记内容…" value="${esc(state.query)}"></div><div id="picker-list">${renderPickerList()}</div><div id="record-selection">${renderSelection(selected)}</div></div><footer class="dialog-footer">${actionButton('close-modal','取消','ghost')}${actionButton('confirm-link','关联到当前会话','primary', !selected || state.conflict ? 'disabled' : '')}</footer>` : `<div class="dialog-body"><div class="row"><span class="evidence-platform">${esc(evidence.platform)}</span><span class="small-muted">${esc(evidence.kind)}</span></div><p class="evidence-description">${esc(evidence.detail)}</p><dl class="evidence-meta"><dt>来源</dt><dd>${esc(evidence.source)}</dd><dt>会话</dt><dd>${esc(data.sessions.find(item=>item.id === record().result.session).name)}</dd><dt>工作区</dt><dd>wt-1 · 本机</dd></dl></div><footer class="dialog-footer">${actionButton('close-modal','关闭','ghost')}${actionButton('origin','查看对应回复','primary')}</footer>`}</section></div>`;
}
function renderPickerList() {
  const items = data.records.filter(item => `${item.title}${item.body}`.toLowerCase().includes(state.query.toLowerCase()));
  return items.length ? items.map(item => `<button class="picker-item ${item.id === state.selectedRecord ? 'chosen' : ''}" data-record="${item.id}">${icon('document')}<span class="grow"><strong>${esc(item.title)}</strong><span class="small-muted">待办 · ${esc(item.status)}</span></span>${item.id === state.selectedRecord ? icon('check') : ''}</button>`).join('') : '<p class="empty-search">没有找到匹配的随记</p>';
}
function renderSelection(selected) {
  if (!selected) return '';
  return `<div class="selection-preview"><span class="eyebrow">原文</span><p>${esc(selected.body)}</p><span class="eyebrow">最新补充</span><p>${esc(selected.supplement)}</p></div>${state.conflict ? `<div class="notice conflict" role="alert"><span>这条随记有新的补充，请读取最新内容后再关联。</span>${actionButton('refresh-selection','读取最新内容','small')}</div>` : ''}`;
}
function openPicker() {
  state.modal = 'associate'; state.query = ''; state.selectedRecord = null; state.expectedVersion = null; state.recordPreview = null; state.conflict = false;
  renderModal(); document.querySelector('#record-search')?.focus();
}
function chooseSession(id, highlight = null) {
  const target = data.sessions.find(item => item.id === id);
  if (!target?.available) { state.notice = '原会话当前不可用，成果与原文仍可查看。'; state.modal = null; render(); return; }
  state.sessionId = id; state.highlight = highlight; state.panel = 'handoff'; state.notice = ''; state.menu = false; state.modal = null; render();
}
function showToast(message) {
  const node = document.querySelector('#toast'); node.textContent = message; node.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(()=>{node.hidden=true;},2800);
}
function handleAction(action) {
  if (action === 'associate') return openPicker();
  if (action === 'close-modal') { state.modal = null; renderModal(); return; }
  if (action === 'confirm-link') {
    const selected = data.records.find(item=>item.id === state.selectedRecord);
    if (!selected || state.conflict) return;
    if (params.get('state') === 'conflict' && !state.conflictInjected) {
      selected.requirementsVersion++; selected.supplement = data.conflictSupplement; state.conflictInjected = true;
    }
    if (selected.requirementsVersion !== state.expectedVersion) { state.conflict = true; renderModal(); return; }
    session().recordId = selected.id; state.modal = null; state.panel = 'handoff'; state.notice = ''; render(); showToast('已关联到当前会话'); return;
  }
  if (action === 'refresh-selection') {
    const selected = data.records.find(item=>item.id === state.selectedRecord);
    state.expectedVersion = selected.requirementsVersion; state.recordPreview = structuredClone(selected); state.conflict = false; renderModal(); return;
  }
  if (action === 'record') { state.panel = 'record'; state.notice = ''; render(); return; }
  if (action === 'home') { state.panel = 'handoff'; render(); return; }
  if (action === 'menu') { state.menu = !state.menu; render(); return; }
  if (action === 'unlink') { session().recordId = null; state.menu = false; render(); showToast('已解除当前会话关联'); return; }
  if (action === 'origin') {
    const linked = record(); if (!linked) return;
    chooseSession(linked.result?.session ?? linked.originSession, linked.result ? 'i3' : null); return;
  }
  if (action === 'locate-latest') { state.highlight = session().messages.filter(item=>item.role === 'user').at(-1)?.id; state.panelOpen = false; render(); return; }
  if (action === 'expand') { state.expanded = !state.expanded; render(); return; }
  if (action === 'close-panel') { state.panelOpen = false; render(); return; }
  if (action === 'open-panel') { state.panelOpen = true; render(); }
}
document.addEventListener('click', event => {
  const target = event.target.closest('button'); if (!target) return;
  if (target.dataset.session) return chooseSession(target.dataset.session);
  if (target.dataset.relatedSession) return chooseSession(target.dataset.relatedSession);
  if (target.dataset.record) { state.selectedRecord = target.dataset.record; state.recordPreview = structuredClone(data.records.find(item=>item.id === target.dataset.record)); state.expectedVersion = state.recordPreview.requirementsVersion; state.conflict=false; renderModal(); return; }
  if (target.dataset.evidence !== undefined) { state.modal = {index:Number(target.dataset.evidence)}; renderModal(); return; }
  if (target.dataset.action) handleAction(target.dataset.action);
});
document.addEventListener('input', event => {
  if (event.target.id === 'message') state.drafts[state.sessionId] = event.target.value;
  if (event.target.id === 'record-search') { state.query = event.target.value; document.querySelector('#picker-list').innerHTML = renderPickerList(); }
});
document.addEventListener('submit', event => {
  if (event.target.id !== 'message-form') return; event.preventDefault();
  const text = (state.drafts[state.sessionId] ?? '').trim(); if (!text) return;
  session().messages.push({id:`input-${Date.now()}`,role:'user',text,time:'刚刚'}); state.drafts[state.sessionId]=''; state.highlight=null; render();
});
document.addEventListener('keydown',event=>{if(event.key==='Escape' && state.modal){state.modal=null;renderModal();}});
fetch('./mock-state.json').then(response=>{if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.json();}).then(initial=>{
  data=initial;
  if(params.get('state')==='missing') data.sessions.find(item=>item.id==='implementation').available=false;
  if(params.get('state')==='conflict') data.sessions.find(item=>item.id==='review').recordId=null;
  render();
}).catch(error=>{app.textContent=`原型加载失败：${error.message}`;});
