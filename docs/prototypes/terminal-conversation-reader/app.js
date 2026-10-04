/* Standalone prototype; all conversation data comes from mock-state.json. */
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const paths = {
  book: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z"/><path d="M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2l1 4M4 12l1 4a8 8 0 0 0 13 2"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
  collapse: '<path d="M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  down: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  signal: '<path d="M4 19v-3M9 19v-6M14 19V9M19 19V5"/>',
  wifi: '<path d="M3 9a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0M9 15a4 4 0 0 1 6 0"/><circle cx="12" cy="19" r=".7"/>',
  battery: '<rect x="2" y="6" width="18" height="12" rx="3"/><path d="M22 10v4"/><path d="M5 9h11v6H5z" fill="currentColor" stroke="none"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
// Limited, escaped Markdown renderer for the fixture, not a production parser.
function renderMarkdown(value) {
  const lines = value.split('\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (line.startsWith('```')) {
      const code = [];
      index++;
      while (index < lines.length && !lines[index].startsWith('```')) code.push(lines[index++]);
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      index++;
    } else if (line.startsWith('## ')) {
      blocks.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`); index++;
    } else if (line.startsWith('- ')) {
      const items = [];
      while (index < lines.length && lines[index].startsWith('- ')) items.push(`<li>${inlineMarkdown(lines[index++].slice(2))}</li>`);
      blocks.push(`<ul>${items.join('')}</ul>`);
    } else if (line.startsWith('|')) {
      const rows = [];
      while (index < lines.length && lines[index].startsWith('|')) rows.push(lines[index++].split('|').slice(1, -1).map(cell => cell.trim()));
      const header = rows.shift();
      rows.shift();
      blocks.push(`<div class="table-wrap"><table><thead><tr>${header.map(cell=>`<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (line.startsWith('> ')) {
      blocks.push(`<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`); index++;
    } else {
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !/^(## |```|- |\||> )/.test(lines[index])) paragraph.push(lines[index++]);
      blocks.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
    }
  }
  return blocks.join('');
}
let data;
let turns = [];
let readAt;
let refreshing = false;
let refreshCount = 0;
let savedScroll = 0;
let expanded = params.has('expanded');
let opened = params.get('view') !== 'terminal';
let statusText = '';
function renderTurn(turn, index) {
  return `<section class="turn" data-turn-id="${escapeHtml(turn.id)}" aria-label="第 ${index + 1} 轮对话">
    <article class="question"><div class="message-label"><span class="user-mark">你</span><span>你 · 第 ${String(index + 1).padStart(2, '0')} 轮</span><time>${escapeHtml(turn.questionAt)}</time></div><p>${escapeHtml(turn.question)}</p></article>
    <article class="answer"><div class="message-label"><span class="answer-mark">✳</span><span>Codex</span><time>${escapeHtml(turn.answerAt)}</time></div><div class="markdown">${renderMarkdown(turn.answer)}</div></article>
  </section>`;
}
function renderDocument() {
  const content = turns.length ? turns.map(renderTurn).join('') : '<p class="markdown">暂无可读取的对话。</p>';
  document.querySelector('#document').innerHTML = `<header class="doc-header"><div class="doc-eyebrow"><span class="dot"></span> ${escapeHtml(data.project)} / ${escapeHtml(data.provider)}</div><h1>${escapeHtml(data.title)}</h1><div class="doc-meta"><span>今天 16:42</span><span id="turn-count">${turns.length} 轮对话</span><span>${escapeHtml(data.session)}</span></div></header>${content}`;
}
function renderShell() {
  app.classList.toggle('expanded', expanded);
  app.classList.toggle('reader-closed', !opened);
  app.innerHTML = `
    <header class="topbar"><span class="brand">⌘</span><span class="connection"><i class="dot"></i> Local Mac <span>⌄</span></span><span class="top-project">Runweave <span>×</span></span><span class="spacer"></span><span class="healthy"><i class="dot"></i> Backend 正常</span><span style="color:var(--muted)">•••</span></header>
    <div class="mobile-status"><span>9:41</span><span class="status-icons">${icon('signal')}${icon('wifi')}${icon('battery')}</span></div>
    <div class="workspace">
      <aside class="sidebar"><div class="rail-label">WORKTREES</div><div class="tree active"><strong>⌘ &nbsp; agent-team-2</strong><small>main · 1 terminal</small></div><div class="tree"><strong>⌘ &nbsp; main</strong><small>main</small></div><div class="tree"><strong>⌘ &nbsp; wt-1</strong><small>feat / terminal</small></div><span class="spacer"></span><div class="rail-foot">Runweave<br><br>本地工作区</div></aside>
      <section class="terminal" aria-label="终端"><div class="terminal-tabs"><span class="terminal-tab">会话阅读方案 &nbsp; ×</span><span>＋</span></div><header class="terminal-head"><span class="agent-star">✳</span><strong style="font-weight:500">Codex</strong><span class="status"><i class="dot"></i>等待输入</span><span class="spacer"></span><button class="read-entry" data-action="open">${icon('book')} 阅读会话</button></header><div class="terminal-body"><p class="tui-title">OpenAI Codex<br><span class="tui-path">~/Code/browser-hub/browser-viewer</span></p><p class="tui-prompt">› 直接读 thread 原始数据就行。<br>我们只关注提问和回答，不用额外存储。</p><div class="tui-response"><p><strong>● 可行。</strong>阅读页只展示原始记录里能够<br>读到的正文，数据仍由 Agent 自己保存。</p><p>保留你的提问，以及 Agent 对你可见的<br>阶段说明和回答。</p><p class="tui-code">提问 01 → 回答 01<br>提问 02 → 回答 02<br>提问 03 → 回答 03</p><p>关闭阅读页不会改动原始会话。下次打开时，<br>再读一次当前可用的记录。</p><p class="tui-path">调研完成 · 等待下一步指令</p></div></div><div class="composer"><div class="composer-copy">› &nbsp; 输入指令…</div><div class="composer-foot"><span>＋</span><span>Codex ⌄</span><span class="spacer"></span><span>语音</span><span class="send">↑</span></div></div><footer class="terminal-footer"><span>agent-team-2 / Codex</span><span class="spacer"></span><span>tmux</span></footer></section>
      <section class="reader" aria-label="会话阅读"><header class="reader-head"><button class="mobile-back" data-action="close" aria-label="返回终端">${icon('back')}终端</button><span class="reader-name">${icon('book')}会话阅读</span><span class="spacer"></span><span class="read-time">读取于 <span id="read-time">${escapeHtml(readAt)}</span></span><div class="reader-tools"><button class="refresh" id="refresh" data-action="refresh" aria-label="刷新会话">${icon('refresh')}<span class="refresh-label">刷新</span></button><button class="icon-button expand-button" data-action="expand" aria-label="${expanded ? '收起阅读' : '展开阅读'}">${icon(expanded ? 'collapse' : 'expand')}</button><button class="icon-button close-button" data-action="close" aria-label="关闭阅读">${icon('close')}</button></div></header><div class="reader-scroll" id="reader-scroll" tabindex="0" aria-label="对话正文"><div class="document" id="document"></div></div><footer class="reader-foot"><span id="read-status" role="status">${escapeHtml(statusText || `读取于 ${readAt}`)}</span><button data-action="latest">回到最新 ${icon('down')}</button></footer></section>
    </div><div class="home-indicator"></div>`;
  renderDocument();
  document.querySelector('#reader-scroll').scrollTop = savedScroll;
}
function setRefreshState(loading, message, error = false) {
  app.classList.toggle('loading', loading);
  const button = document.querySelector('#refresh');
  button.disabled = loading;
  button.setAttribute('aria-busy', String(loading));
  button.querySelector('.refresh-label').textContent = loading ? '读取中' : '刷新';
  const status = document.querySelector('#read-status');
  status.className = error ? 'error' : 'read-status';
  status.textContent = message;
}
async function refreshConversation() {
  if (refreshing) return;
  refreshing = true;
  setRefreshState(true, '正在重新读取…');
  try {
    // One delay per explicit action; no polling or background refresh.
    await new Promise(resolve => setTimeout(resolve, data.refreshDelayMs));
    const response = await fetch('./mock-state.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('读取失败');
    const fresh = await response.json();
    if (params.get('scenario') === 'refresh-error') throw new Error('暂时无法读取');
    const scroll = document.querySelector('#reader-scroll');
    savedScroll = scroll.scrollTop;
    const anchor = [...document.querySelectorAll('.turn')].find(turn => turn.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
    const anchorId = anchor?.dataset.turnId;
    const anchorTop = anchor?.getBoundingClientRect().top;
    const previousLength = turns.length;
    data = fresh;
    turns = params.get('scenario') === 'empty' ? [] : [...data.initialTurns, data.refreshedTurn];
    refreshCount++;
    readAt = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    renderDocument();
    document.querySelector('#read-time').textContent = readAt;
    scroll.scrollTop = savedScroll;
    const replacement = [...document.querySelectorAll('.turn')].find(turn => turn.dataset.turnId === anchorId);
    if (replacement && anchorTop !== undefined) scroll.scrollTop += replacement.getBoundingClientRect().top - anchorTop;
    savedScroll = scroll.scrollTop;
    statusText = turns.length > previousLength ? `已重新读取 · ${turns.length} 轮对话` : '已重新读取 · 内容无变化';
    setRefreshState(false, statusText);
  } catch {
    statusText = '暂时无法读取，请重试';
    setRefreshState(false, statusText, true);
  } finally {
    refreshing = false;
  }
}
app.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const scroll = document.querySelector('#reader-scroll');
  savedScroll = scroll?.scrollTop ?? savedScroll;
  switch (button.dataset.action) {
    case 'refresh': refreshConversation(); break;
    case 'expand': expanded = !expanded; renderShell(); break;
    case 'close': opened = false; expanded = false; renderShell(); break;
    case 'open':
      opened = true; savedScroll = 0;
      turns = params.get('scenario') === 'empty' ? [] : [...data.initialTurns, ...(refreshCount ? [data.refreshedTurn] : [])];
      renderShell(); break;
    case 'latest': scroll.scrollTo({ top: scroll.scrollHeight, behavior: 'smooth' }); break;
  }
});
fetch('./mock-state.json', { cache: 'no-store' })
  .then(response => { if (!response.ok) throw new Error('无法读取对话'); return response.json(); })
  .then(initial => {
    data = initial;
    readAt = data.initialReadAt;
    turns = params.get('scenario') === 'empty' ? [] : data.initialTurns;
    renderShell();
  })
  .catch(() => { app.textContent = '暂时无法读取对话，请刷新页面重试。'; });
