const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const icons = {
  eye:'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  edit:'<path d="m15 4 5 5M4 20l4-1L20 7a2 2 0 0 0-4-4L4 15v5Z"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
  back:'<path d="m14 6-6 6 6 6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>',
  expand:'<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/>',
  terminal:'<path d="m4 5 6 7-6 7M13 19h7"/>', folder:'<path d="M3 6h6l2 3h10v11H3V6Z"/>',
  send:'<path d="m12 19 0-14M5 12l7-7 7 7"/>', chevron:'<path d="m9 6 6 6-6 6"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action,label,kind='') => `<button class="button ${kind}" data-action="${action}">${label}</button>`;
const list = text => `<ul class="check-list">${text.split('\n').filter(Boolean).map(t=>`<li>${escape(t)}</li>`).join('')}</ul>`;
let data, state, generation = 0, toastTimer;

function shell() {
  app.innerHTML = `
    <header class="topbar row between"><div class="row"><div class="traffic"><i></i><i></i><i></i></div><span class="brand">Runweave</span><span class="workspace-name">browser-viewer</span></div><span class="muted tiny">本机 · 已连接</span></header>
    <div class="workspace">
      <aside class="projects" aria-label="项目与终端"><div class="projects-label">工作区</div><div class="project">${icon('folder')} browser-viewer</div><div class="session selected"><span class="dot"></span>Codex 原生旁聊接入</div><div class="session">终端 2</div><div class="session">终端 3</div><div class="project muted" style="margin-top:18px">${icon('folder')} agent-team-2</div><div class="session">终端 1</div><div class="grow"></div><div class="project muted tiny">本地项目 · main</div></aside>
      <section class="terminal" aria-label="原终端"><div class="terminal-tabs row between"><span class="terminal-tab">${icon('terminal')} Codex 原生旁聊接入</span><span class="muted tiny">26dc452f</span></div>
        <button class="status-strip row" data-action="open"><span>${icon('eye')}</span><span class="grow truncate">Codex 原生旁聊接入</span><span id="strip-label">需要你处理</span><span class="tiny" id="strip-quota">1/3 次续接</span>${icon('chevron')}</button>
        <div class="terminal-scroll" id="terminal-log"><p class="cwd">~/Code/browser-hub/browser-viewer/.worktree/wt-1</p><div class="exchange user">› 那就实现这个计划</div><div class="exchange"><span class="role">● Codex</span><p>已实现按键兼容修复，完整计划尚未完成。</p><ul><li>Ctrl+/ 已在真实 Beta 终端验证。</li><li>旁聊创建、切换、关闭正常。</li><li>监督、恢复和输入隔离仍需可信身份信号。</li></ul><p class="muted">代码未提交，Stable 未更新。</p></div><div class="exchange user">› 现在进展如何了</div><div class="exchange"><span class="role">● Codex</span><p>完整旁聊接入尚未完成。快捷键修复已验证，剩余功能仍依赖可信会话身份信号。</p></div></div>
        <div class="terminal-entry"><form id="message-form"><span class="muted">›</span><input id="message" aria-label="发送给当前 Agent" placeholder="发送消息给当前 Agent…" autocomplete="off"><button class="icon-button" aria-label="发送消息">${icon('send')}</button></form><div class="model">Codex · 当前会话</div></div>
      </section>
      <aside class="sidecar" aria-label="终端工具面板"><div class="sidecar-tabs row"><div class="grow row"><span class="sidecar-tab">Preview</span><span class="sidecar-tab">Browser</span><span class="sidecar-tab active">长任务监控</span></div><button class="icon-button expand-button" data-action="expand" aria-label="展开侧栏">${icon('expand')}</button><button class="icon-button" data-action="close" aria-label="关闭侧栏">${icon('close')}</button></div><div id="panel"></div></aside>
    </div>`;
  renderPanel();
}
function header(title,subtitle,back=false) {
  return `<header class="panel-header"><div class="row">${back?`<button class="icon-button" data-action="back" aria-label="返回监控">${icon('back')}</button>`:''}<div class="grow"><h1>${title}</h1><p>${subtitle}</p></div></div></header>`;
}
const footer = content => `<footer class="panel-footer row between">${content}</footer>`;
function goalCard(goal) {
  return `<p class="goal-text">${escape(goal.goal)}</p>${goal.done?`<div class="section-title">完成条件</div>${list(goal.done)}`:''}${goal.boundaries?`<details style="margin-top:12px"><summary>范围与约束</summary>${list(goal.boundaries)}</details>`:''}`;
}
function sourceList() {
  return state.sources.map(s=>`<div class="source"><div class="meta-line"><span>${escape(s.role)}</span><span>${escape(s.time)}</span>${s.id==='u2'?'<span class="badge green">实施授权</span>':''}${s.id==='u3'?'<span class="badge">进度询问 · 未改变目标</span>':''}</div><p>${escape(s.text)}</p>${s.plan?`<div class="file-link">已承接的计划 · ${escape(s.plan)}</div>`:''}</div>`).join('');
}
function scores(decision) {
  if(decision.result==='等待新回复')return '';
  const labels=['任务已完成','需要你处理','任务可以继续'];
  return labels.map(label=>`<div class="score ${label===decision.result?'selected':''}"><span>${label}</span><span>${label===decision.result?'90.0':'5.0'}</span></div>`).join('')+'<p class="tiny muted">选项评分 · Codex 相对评分</p>';
}
function monitor() {
  const status = !state.enabled?'监听已关闭':state.classifying?'正在重新判断':state.uncertain?'目标待核对':state.history[0].result;
  document.querySelector('#strip-label').textContent=status;
  document.querySelector('#strip-quota').textContent=`${state.quota}/3 次续接`;
  const decision = state.history[0];
  return header('长任务监控','监听此终端的 Agent 事件 · 处理最终回复') + `<div class="panel-body">
    ${state.offline?'<div class="notice">电脑暂时离线，显示上次同步的状态。恢复连接后可修改目标。</div>':''}
    <div class="section row between"><span class="${state.uncertain?'amber':'sky'}">${icon('eye')} ${status}</span><span class="tiny muted">${state.enabled?'监听中':'已关闭'}</span></div>
    ${state.uncertain?`<div class="notice">${state.scopeChanged?'最近输入可能改变任务范围。':'当前目标未明确具体交付。'}核对目标后再恢复自动续接。</div>`:''}
    <section class="section"><div class="row between"><span class="section-title" style="margin:0">当前目标</span><div class="row"><span class="badge ${state.uncertain?'amber':'green'}">${state.uncertain?'待核对':state.manual?'手动修订':'根据对话整理'}</span><span class="tiny muted">v${state.version}</span></div></div>
      <div id="current-goal">${goalCard(state.current)}</div>
      <div class="goal-actions"><button class="button" data-action="edit" ${state.offline?'disabled':''}>${icon('edit')} 编辑</button><button class="button" data-action="generate" ${state.offline?'disabled':''}>${icon('refresh')} 重新生成</button></div>
      <div class="meta-line" style="margin-top:12px">${escape(state.updateNote)} · <button class="text-button" data-action="sources">查看依据</button></div>
    </section>
    ${state.notice?`<div class="notice success" role="status">${escape(state.notice)}</div>`:''}
    <section class="section quota inset"><div class="row between"><span>已使用续接额度</span><strong>${state.quota} / 3</strong></div><div class="bars">${[0,1,2].map(i=>`<span class="${i<state.quota?'used':''}"></span>`).join('')}</div><p class="tiny muted">新会话重置任务；同会话的新用户输入更新要求并重置本轮额度。</p></section>
    <section class="section"><div class="row between section-title"><span>${state.classifying?'上次判断 · 正在重新判断':state.uncertain?'上次判断 · 目标待核对':'最新判断'}</span><span>目标 v${decision.version}</span></div><p class="result-title">${escape(decision.result)}</p><p class="result-text">${escape(decision.reason)}</p>${state.classifying?'<p class="sky tiny" role="status" style="margin-top:9px">新目标的判断完成前，不发送自动续接。</p>':''}<details style="margin-top:12px"><summary>判定详情</summary><p class="muted tiny">${escape(decision.time)} · 目标 v${decision.version} · 未发送续接</p>${scores(decision)}<p class="tiny muted" style="margin-top:10px">当时目标：${escape(decision.goal)}</p></details></section>
    <details class="section"><summary>历史判断 · ${state.history.length} 条</summary>${state.history.map(d=>`<article class="history-item"><div class="row between tiny muted"><span>${escape(d.time)} · ${escape(d.result)}</span><span>目标 v${d.version}</span></div><p style="margin:8px 0">${escape(d.goal)}</p><details><summary>判断依据</summary><p class="muted">${escape(d.reason)}</p></details></article>`).join('')}</details>
    <details><summary>监听身份与活动</summary><p class="muted tiny">终端 26dc452f · Codex 原生旁聊接入</p><p class="muted tiny">最近输入：${escape(state.lastMessage)}</p></details>
    </div>` + footer(`<span class="tiny muted">终端监控 · 切换会话后保持开启</span><button role="switch" aria-label="终端任务监控" aria-checked="${state.enabled}" class="toggle ${state.enabled?'':'off'}" data-action="toggle" ${state.offline?'disabled':''}>${state.enabled?'已开启':'已关闭'}</button>`);
}
function editor() {
  return header('编辑目标',`修改当前任务 · 基于目标 v${state.version}`,true)+`<div class="panel-body"><div class="field"><label for="goal">任务目标</label><textarea id="goal" maxlength="1500" rows="4">${escape(state.draft.goal)}</textarea></div><div class="field"><label for="done">完成条件</label><textarea id="done" maxlength="3000" rows="4">${escape(state.draft.done)}</textarea><small>每行一项。</small></div><div class="field"><label for="boundaries">范围与约束</label><textarea id="boundaries" maxlength="3000" rows="5">${escape(state.draft.boundaries)}</textarea></div><p class="muted tiny">后续“继续”和进度询问会沿用修订后的目标。</p><p id="field-error" class="field-error" role="alert"></p></div>`+footer(`${button('back','取消','ghost')}${button('preview-edit','查看变更','primary')}`);
}
function review() {
  const changed = ['goal','done','boundaries'].filter(k=>state.current[k]!==state.draft[k]);
  const labels={goal:'任务目标',done:'完成条件',boundaries:'范围与约束'};
  return header('核对目标变更',state.draftFrom==='manual'?'手动修订 · 尚未生效':'根据最近对话与已承接计划整理 · 尚未生效',true)+`<div class="panel-body">
    ${state.conflict?'<div class="notice error" role="alert">生成期间收到新的用户消息，当前预览已过期。请重新生成后核对。</div>':''}
    <div class="meta-line"><span class="badge">v${state.version}</span>${changed.length?` → <span class="badge green">v${state.version+1}</span>`:''}<span>${changed.length?`调整 ${changed.length} 项`:'目标内容无变化'}</span></div>
    ${changed.length?changed.map(k=>`<section style="margin-top:20px"><h2>${labels[k]}</h2><div class="version-box old"><h3>当前</h3><p>${escape(state.current[k]||'未明确')}</p></div><div class="version-box proposed"><h3>更新后</h3><p>${escape(state.draft[k]||'未设置')}</p></div></section>`).join(''):'<div class="notice success" style="margin-top:18px">最近对话未改变当前任务，目标保持不变。</div>'}
    <details style="margin-top:22px"><summary>本次整理依据 · ${state.sources.length} 条消息</summary>${sourceList()}</details>
    <p class="muted tiny" style="margin-top:18px">采用后按新目标重新判断。历史记录保留当时的目标。</p>
    </div>`+footer(`${button('back','保留当前目标','ghost')}${state.conflict?button('generate','重新生成','primary'):`<button class="button primary" data-action="apply" ${!changed.length?'disabled':''}>采用并重新判断</button>`}`);
}
function renderPanel() {
  let html;
  if (state.view==='edit') html=editor();
  else if (state.view==='review') html=review();
  else if (state.view==='sources') html=header('目标依据',`当前目标 v${state.version} · 用户原文与承接关系`,true)+`<div class="panel-body">${sourceList()}${state.manual?`<div class="source"><div class="meta-line">你 · 手动修订</div><p>${escape(state.current.goal)}</p></div>`:''}<div class="inset"><p class="tiny muted">“现在进展如何了”只询问进度，未替代已授权的实施任务。</p></div></div>`+footer(button('back','返回监控','ghost'));
  else if (state.view==='generating') html=header('重新生成目标','结合原有目标、最近对话和必要来源',true)+`<div class="panel-body"><div class="loading"><span class="spinner"></span><p>正在整理当前任务…</p><p class="muted">核对授权、完成条件与范围变化</p></div></div>`+footer(button('back','取消','ghost'));
  else if (state.view==='error') html=header('重新生成目标','当前目标保持不变',true)+`<div class="panel-body"><div class="notice error" role="alert">无法读取已承接的计划，未生成新目标。请稍后重试，或直接编辑目标。</div>${goalCard(state.current)}</div>`+footer(`${button('edit','编辑目标')}${button('generate','重试','primary')}`);
  else html=monitor();
  document.querySelector('#panel').innerHTML=html;
}
function toast(text) {
  document.querySelector('.toast')?.remove(); clearTimeout(toastTimer);
  const el=document.createElement('div'); el.className='toast'; el.role='status'; el.textContent=text; document.body.append(el);
  toastTimer=setTimeout(()=>el.remove(),3500);
}
function back() { generation++; state.view='monitor'; state.conflict=false; renderPanel(); }
async function generate() {
  const ticket=++generation;
  state.view='generating'; state.conflict=false; renderPanel();
  await new Promise(r=>setTimeout(r,850));
  if(ticket!==generation)return;
  if(params.get('state')==='error' && !state.failedOnce) { state.failedOnce=true; state.view='error'; renderPanel(); return; }
  state.draft=structuredClone(state.pendingDiscussion?data.discussion:state.manual?state.current:data.resolved);
  state.draftFrom='generated'; state.conflict=params.get('state')==='conflict' && !state.conflictSeen;
  state.conflictSeen ||= state.conflict; state.view='review'; renderPanel();
}
function apply() {
  if(state.conflict)return;
  state.current=structuredClone(state.draft); state.version++; state.manual=state.draftFrom==='manual'; state.uncertain=false;
  state.discussion=state.current.goal===data.discussion.goal; state.scopeChanged=false;
  state.updateNote=state.manual?'刚刚手动修订':'已核对最近对话与承接计划';
  const version=state.version;
  state.classifying=true; state.view='monitor'; state.notice=`目标已更新为 v${version}，正在重新判断。`; renderPanel();
  setTimeout(()=>{
    if(version!==state.version)return;
    state.classifying=false;
    const keyboardOnly=/(仅|只).*快捷键/.test(state.current.goal);
    const known=state.current.goal===data.resolved.goal;
    state.history.unshift({time:'刚刚',version,goal:state.current.goal,
      result:state.discussion?'任务可以继续':keyboardOnly?'任务已完成':known?'需要你处理':'等待新回复',
      reason:state.discussion?'当前范围已改为讨论接入方案，原实现任务暂不推进。下一步为比较可行方案和维护成本。':keyboardOnly?'当前范围仅包含快捷键兼容修复和验证，已有回复报告该交付完成。监督、恢复和输入隔离不再作为本轮未完成事项。':known?'旁聊接入尚未完成：快捷键已验证，监督、恢复和输入隔离仍依赖可信会话身份信号。':'目标已更新，现有回复不足以判断新交付。等待原会话的下一条有效回复。'});
    state.notice=`已按目标 v${version} 重新判断。`;
    if(state.view==='monitor')renderPanel();
  },1100);
}
app.addEventListener('click',e=>{
  const action=e.target.closest('[data-action]')?.dataset.action;
  if(!action)return;
  if(action==='close') { document.querySelector('.sidecar').classList.add('hidden'); return; }
  if(action==='open') { document.querySelector('.sidecar').classList.remove('hidden'); return; }
  if(action==='expand') { document.querySelector('.sidecar').classList.toggle('expanded'); return; }
  if(action==='back') { back(); return; }
  if(action==='edit') { state.draft=structuredClone(state.current); state.draftSourceCount=state.sources.length; state.view='edit'; renderPanel(); document.querySelector('#goal').focus(); return; }
  if(action==='generate') { void generate(); return; }
  if(action==='preview-edit') {
    for(const key of ['goal','done','boundaries'])state.draft[key]=document.querySelector(`#${key}`).value.trim();
    if(!state.draft.goal || !state.draft.done) { document.querySelector('#field-error').textContent='请填写任务目标和完成条件。'; return; }
    state.draftFrom='manual'; state.conflict=state.draftSourceCount!==state.sources.length; state.view='review'; renderPanel(); return;
  }
  if(action==='apply') { apply(); return; }
  if(action==='sources') { state.view='sources'; renderPanel(); return; }
  if(action==='toggle') { state.enabled=!state.enabled; renderPanel(); }
});
app.addEventListener('submit',e=>{
  if(e.target.id!=='message-form')return; e.preventDefault();
  const input=document.querySelector('#message'),text=input.value.trim(); if(!text)return; input.value='';
  const item=document.createElement('div'); item.className='exchange user'; item.textContent='› '+text; document.querySelector('#terminal-log').append(item); item.scrollIntoView({block:'nearest'});
  state.lastMessage=text; state.quota=0; state.sources.push({id:`u${Date.now()}`,role:'你',time:'刚刚',text});
  if(/^(继续[。！!]?|现在进展如何了[？?]?|进展如何[？?]?)$/.test(text)) { state.notice='最近输入未改变任务范围，当前目标保持不变。'; toast('目标保持不变'); }
  else if(/只讨论|先别实现/.test(text)) { state.pendingDiscussion=true; state.uncertain=true; state.scopeChanged=true; void generate(); return; }
  else { state.uncertain=true; state.scopeChanged=true; state.notice='收到新要求，请结合对话核对当前目标。'; }
  if(['review','generating'].includes(state.view)) { generation++; state.view='review'; state.draft ||= structuredClone(state.current); state.conflict=true; }
  if(state.view!=='edit')renderPanel();
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape' && state.view!=='monitor')back(); });
fetch('./mock-state.json').then(r=>{if(!r.ok)throw new Error('无法读取原型数据'); return r.json();}).then(initial=>{
  data=initial; const aligned=params.get('state')!=='legacy';
  state={view:'monitor',current:structuredClone(aligned?data.resolved:data.legacy),version:aligned?4:3,quota:1,uncertain:!aligned,enabled:true,manual:false,classifying:false,offline:params.get('state')==='offline',history:structuredClone(data.decisions),sources:structuredClone(data.sources),lastMessage:'现在进展如何了',updateNote:aligned?'进度询问未改变任务范围':'来自最近一条用户消息'};
  if(aligned)state.history.unshift({time:'20:48',version:4,goal:data.resolved.goal,result:'需要你处理',reason:'快捷键修复已验证；监督、恢复和输入隔离仍缺少可信身份信号，完整任务尚未完成。'});
  shell();
}).catch(error=>{app.textContent=`原型加载失败：${error.message}。请通过 README 中的本地 HTTP 地址打开。`;});
