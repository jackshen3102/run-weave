/* Standalone prototype: fixture data only, no product or Codex API calls. */
const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const paths = {
  weave:'M4 5h5l6 14h5M4 12h5l6-7h5M4 19h5l6-7h5',
  terminal:'m5 7 4 5-4 5m8 0h6', monitor:'M4 8a9 9 0 0 1 16 0M7 11a5.5 5.5 0 0 1 10 0m-7 3a2 2 0 0 1 4 0m-2 3v3',
  grid:'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z',
  folder:'M3 6h7l2 3h9v11H3z', branch:'M6 3v12a4 4 0 0 0 4 4h8M6 7h6a5 5 0 0 0 5-4M4 3h4M16 3h3M18 17v4',
  file:'M6 3h8l4 4v14H6zm8 0v5h4M9 12h6m-6 4h6',
  check:'m5 12 4 4L19 6', pause:'M8 5v14M16 5v14', arrow:'M5 12h14m-5-5 5 5-5 5',
  clock:'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  chevron:'m9 5 7 7-7 7', spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  alert:'M12 8v5m0 3h.01M12 3l10 18H2z', plus:'M12 5v14M5 12h14'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.monitor}"/></svg>`;
const escape = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let data, state, details = false, draft = '', timer;
const choiceNames = {completed:'已完成', blocked:'受阻', continue:'可继续'};
function quota() {
  return `<div class="quota ${state.status === 'limit' ? 'limit' : ''}"><div class="row between"><span class="section-label">自动续接</span><strong>${state.count} <small>/ ${data.limit} 次</small></strong></div><div class="segments">${Array.from({length:data.limit},(_,i)=>`<span class="segment ${i < state.count ? 'used' : ''}"></span>`).join('')}</div><div class="quota-note">达到上限后停止自动续接</div></div>`;
}
function decision() {
  if (!state.choice) return `<div class="section-top"><span class="section-label">最新判断</span></div><div class="decision"><div class="decision-body">${state.status === 'reviewing' ? '正在读取本轮最终回复…' : '收到下一条最终回复后进行判断。'}</div></div>`;
  return `<div class="section-top"><span class="section-label">最新判断</span><span class="tiny">来自最终回复 · 14:32</span></div><div class="decision"><div class="decision-head"><span class="row">${icon(state.choice === 'completed' ? 'check' : state.choice === 'blocked' ? 'alert' : 'arrow')}${choiceNames[state.choice]}</span><span class="time">Codex</span></div><div class="decision-body">${escape(state.reason)}<div class="scores" aria-label="三个选项的模型评分">${['completed','blocked','continue'].map((key,i)=>`<div class="score ${key === state.choice ? 'selected' : ''}">${choiceNames[key]}<b>${state.scores[i].toFixed(2)}</b></div>`).join('')}</div><button class="details-link" data-action="details">${icon('chevron')}${details ? '收起判定详情' : '判定详情'}</button>${details ? `<div class="details">选项评分由 Codex 给出。<br>输入：当前目标、计划、用户补充、最近问答、本轮最终回复。<br>结论依据：${escape(state.remaining)}<br>当前目标：${escape(data.goal)}</div>` : ''}</div></div>`;
}
function monitor() {
  const off = state.status === 'off';
  let buttons;
  if (['limit','completed'].includes(state.status)) buttons = `<button class="button primary" data-action="start">${icon('plus')}重新开启一轮监控</button>`;
  else if (['paused','blocked'].includes(state.status)) buttons = `<button class="button primary" data-action="resume">${icon('monitor')}恢复监控</button>`;
  else buttons = `<button class="button" data-action="pause">${icon('pause')}暂停监控</button>`;
  const activity = state.status === 'limit' ? '达到 3 次上限，自动续接已停止' : state.status === 'completed' ? '任务已完成，监听结束' : state.status === 'blocked' ? '等待用户处理设备解锁' : state.status === 'paused' ? '已手动暂停监控' : state.status === 'reviewing' ? '收到最终回复，正在判断' : state.count ? `已向原终端发送第 ${state.count} 次继续指令` : '等待第一条最终回复';
  return `<aside class="monitor"><header class="monitor-head"><span class="row">${icon('monitor')}任务监控</span><span class="enabled-tag"><i class="dot"></i>${off ? '未开启' : ['watching','reviewing'].includes(state.status) ? '已开启' : '已停止'}</span></header><div class="monitor-body"><div class="monitor-title"><div class="monitor-mark">${icon('monitor')}</div><div><h2>长任务监控</h2><p>独立监听 Agent · Codex</p></div></div>${off ? `<div class="off-state"><div class="empty-icon">${icon('monitor')}</div><h3>让当前任务持续推进</h3><p>原 Agent 回复结束后判断任务状态，<br>需要继续时，自动续接原任务。</p></div><div class="divider"></div><div class="section-label">当前目标</div><p class="target-title">${escape(data.goal)}</p>${quota()}<div class="actions"><button class="button primary" data-action="start">${icon('monitor')}开启长任务监控</button></div>` : `<div class="status-box ${['limit','blocked'].includes(state.status) ? 'amber' : state.status === 'paused' ? 'gray' : ''}"><div class="status-top">${icon(state.status === 'completed' ? 'check' : ['limit','blocked'].includes(state.status) ? 'alert' : state.status === 'paused' ? 'pause' : 'monitor')}${state.title}</div><p class="status-sub">${state.subtitle}</p></div>${quota()}${decision()}<div class="divider"></div><div class="section-top"><span class="section-label">监控目标</span><button class="details-link" style="margin:0" data-action="goal">查看</button></div><p class="target-title">${escape(data.goal)}</p><div class="target-meta">${icon('terminal')}${data.terminal}<span>·</span>当前任务</div><div class="divider"></div><div class="section-label">最近活动</div><div class="history"><div class="event">${activity}<span>14:32</span></div><div class="event">已开启当前任务监控<span>14:26</span></div></div><div class="actions">${buttons}</div>`}</div></aside>`;
}
function terminal() {
  const running = ['watching','paused'].includes(state.status);
  const reply = `<div class="final-reply"><div class="reply-head">${icon('check')}最终回复</div><strong>${escape(state.reply)}</strong><p>监控状态、三分类判断和原终端续接已串联。</p><p class="remaining">${escape(state.remaining)}</p></div>`;
  const followup = state.count ? `<div class="continuation"><div class="continuation-title">${icon('monitor')}长任务监控<span style="margin-left:auto;color:#8aaa99">第 ${state.count} 次续接</span></div>${escape(data.followup)}</div>` : '';
  const transcript = ['limit','completed','blocked','reviewing'].includes(state.status) ? followup + '<div style="height:18px"></div>' + reply : reply + followup;
  return `<section class="workspace"><div class="breadcrumb">项目<span class="slash">/</span>${data.project}<span class="slash">/</span><strong>${data.terminal}</strong><span class="tag" style="margin-left:auto">Codex</span></div><div class="workhead"><div class="eyebrow">TERMINAL 03</div><h1>终端长任务监控</h1><div class="workmeta"><span class="row">${icon('folder')}browser-viewer</span><span class="row">${icon('branch')}${data.branch}</span></div></div><div class="tabs"><span class="tab active">${icon('terminal')}终端</span><span class="tab">${icon('file')}会话记录</span><span class="live"><i class="dot"></i>${running ? '执行中' : '本轮已结束'}</span></div><div class="terminal"><div class="prompt-label"><span style="color:#8bbca2">›</span>你<span class="time">14:26</span></div><div class="userprompt">${escape(data.goal)}<br>沿用当前方案，完成后报告结果。<br><span class="file">${icon('file')}${data.plan}</span></div><div class="agent-label"><span class="agent-icon">${icon('spark')}</span>Codex<span class="time">14:31</span></div><div class="terminal-output">已完成监控入口和状态展示，正在核对验收清单。<div class="command mono"><span style="color:#acc1b6">$ pnpm typecheck</span><br><span class="success">✓ TypeScript 检查通过</span><br>Done in 4.2s.</div></div>${transcript}<div class="execution">${running ? '<span class="pulse"></span>正在执行剩余验收…' : `${icon(state.status === 'completed' ? 'check' : 'clock')} ${state.status === 'limit' ? '自动续接已停止，等待你的下一步操作。' : state.status === 'blocked' ? '等待你解锁测试设备。' : state.status === 'reviewing' ? '本轮已结束。' : state.status === 'completed' ? '任务已完成。' : '等待输入。'}`}</div></div><div class="composer"><textarea aria-label="给原 Agent 的输入" placeholder="向原 Agent 发送消息…">${escape(draft)}</textarea><div class="composer-foot"><span>Codex <span style="color:#6a8a75;padding:0 7px">/</span> 当前会话</span><span class="row">${icon('plus')}<button data-action="send" aria-label="发送消息">${icon('arrow')}</button></span></div></div></section>`;
}
function render() {
  app.innerHTML = `<header class="topbar"><div class="row brand">${icon('weave')}Runweave</div><div class="row window-meta"><span class="dot green"></span>本机已连接<span style="padding:0 12px;color:#3e494d">|</span><span>Workspace</span><span class="avatar">JS</span></div></header><div class="shell"><aside class="sidebar"><div class="navlabel">工作空间</div><div class="navitem active">${icon('terminal')}终端<span class="count">3</span></div><div class="navitem">${icon('grid')}项目</div><div class="navitem">${icon('clock')}最近任务</div><div class="project"><div class="navlabel">RUNWEAVE</div><div class="subitem">终端 01</div><div class="subitem">终端 02</div><div class="subitem selected">${icon('terminal')}终端 03<span class="dot green" style="margin-left:auto"></span></div></div><div class="sidebar-foot"><div class="row"><span class="dot green"></span>所有更改已同步</div><small>本机 · wt-1</small></div></aside>${terminal()}${monitor()}</div>`;
}
function openStart() {
  const dialog = document.createElement('dialog');
  dialog.innerHTML = `<form method="dialog"><div class="eyebrow">${data.terminal} · 当前任务</div><h2>开启长任务监控</h2><p>由独立 Codex 监听 Agent 判断最终回复，<br>需要继续时，续接当前任务。</p><label for="goal">监控目标</label><textarea id="goal" required>${escape(data.goal)}</textarea><div class="setting"><span>监听消息</span><strong>仅最终回复</strong></div><div class="setting"><span>自动续接上限</span><strong>3 次</strong></div><div class="actions"><button class="button secondary" value="cancel">取消</button><button class="button primary" value="start">开启监控</button></div></form>`;
  document.body.append(dialog);dialog.showModal();
  dialog.addEventListener('close',()=>{if(dialog.returnValue === 'start') {data.goal = dialog.querySelector('textarea').value.trim();state = {...data.scenarios.watching,count:0,choice:null};details=false;render();schedule();}dialog.remove();});
}
function toast(text) {document.querySelector('.toast')?.remove();const el=document.createElement('div');el.className='toast';el.setAttribute('role','status');el.textContent=text;document.body.append(el);setTimeout(()=>el.remove(),2500);}
function receive(event) {
  if(event.phase !== 'final' || state.status !== 'watching') return;
  const scores=event.scores || [0.05,0.05,0.9];
  const keys=['completed','blocked','continue'];
  const choice=keys[scores.indexOf(Math.max(...scores))];
  if(choice !== 'continue')state={...data.scenarios[choice],count:state.count,scores};
  else if(state.count >= data.limit)state={...data.scenarios.limit};
  else state={...data.scenarios.watching,count:state.count+1,scores};
  render();schedule();
}
function schedule() {clearTimeout(timer);if(params.get('autoplay') === '1' && state.status === 'watching')timer=setTimeout(()=>{receive(data.events[0]);receive(data.events[1]);},5000);}
app.addEventListener('input',event=>{if(event.target.matches('.composer textarea'))draft=event.target.value;});
app.addEventListener('click',event=>{
  const action=event.target.closest('[data-action]')?.dataset.action;
  if(action==='start')openStart();
  if(action==='pause'){clearTimeout(timer);state={...state,status:'paused',title:'监控已暂停',subtitle:'原 Agent 继续执行，监控不再自动续接。'};render();}
  if(action==='resume'){if(state.count>=data.limit)return;state={...state,status:'watching',title:'正在监听最终回复',subtitle:'原 Agent 正在执行，等待本轮结束。'};render();schedule();}
  if(action==='details'){details=!details;render();}
  if(action==='goal'){details=true;render();}
  if(action==='send' && draft.trim()){toast('消息已发送给原 Agent');draft='';render();}
});
fetch('./mock-state.json').then(r=>{if(!r.ok)throw Error('Cannot load prototype state');return r.json();}).then(value=>{data=value;state={...(data.scenarios[params.get('scenario')]||data.scenarios.watching)};render();schedule();window.prototypeMonitor={receive,getState:()=>({...state})};}).catch(error=>{app.textContent=error.message;});
