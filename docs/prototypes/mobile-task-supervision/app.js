const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const paths = {
  back:'m14 6-6 6 6 6', close:'m6 6 12 12M18 6 6 18', chevron:'m9 6 6 6-6 6',
  eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  book:'M3 4h6a3 3 0 0 1 3 3v14a3 3 0 0 0-3-3H3ZM21 4h-6a3 3 0 0 0-3 3v14a3 3 0 0 1 3-3h6Z',
  desktop:'M3 4h18v13H3ZM8 21h8M12 17v4', more:'M5 12h.01M12 12h.01M19 12h.01',
  compose:'M13 5H4v15h15v-9M10 14l1-5 8-8 4 4-8 8-5 1',
  alert:'M12 3 2 21h20ZM12 9v5M12 17h.01', check:'m5 12 4 4L19 6',
  clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
  question:'M4 3h16v14H9l-5 4ZM9 8a3 3 0 0 1 6 0c0 2-3 2-3 4M12 14h.01',
  signal:'M3 18v-2M8 18v-5M13 18V9M18 18V5', wifi:'M3 8a14 14 0 0 1 18 0M6 11a9 9 0 0 1 12 0M9 14a4 4 0 0 1 6 0M12 17h.01',
  arrow:'M5 12h14m-6-6 6 6-6 6', refresh:'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6'
};
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24"><path d="${paths[name] || paths.eye}"/></svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lastEnabledState = null;
let data, stateKey, sheet, menu = false, busy = false, offline = params.has('offline'), draft = '', toast = '';
const current = () => data.states[stateKey];
const homebar = () => '<div class="homebar" aria-hidden="true"></div>';
function terminalView(){
  const state = current();
  const terminalNote = stateKey === 'blocked' ? '保存的 iPhone 当前处于锁定状态，真机交互验收尚未执行。请先解锁设备。' : stateKey === 'limit' ? '基本发送流程已完成。真机上的断网恢复反馈尚待验证。' : stateKey === 'completed' ? '计划内的手机端交互验收均已完成。' : '接下来核对手机端附件预览、取消上传与发送反馈。';
  return `<div class="statusbar"><span>14:35</span><div class="island"></div><div class="status-icons">${icon('signal')}${icon('wifi')}<span class="battery"><i></i></span></div></div>
  <header class="navbar"><span class="iconbutton">${icon('back')}</span><div class="navtitle"><strong>${data.terminal} <span style="font-weight:400;color:var(--muted)">/ ${data.project}</span></strong><small><i class="dot"></i>${data.computer} · ${offline ? '离线' : '已连接'}</small></div><span class="iconbutton">${icon('book')}</span><span class="iconbutton">${icon('desktop')}</span><button class="iconbutton" aria-label="终端操作" data-action="menu">${icon('more')}</button></header>
  <nav class="tabs" aria-label="终端视图"><span class="active">终端</span><span>变更 <span class="tabcount">4</span></span><span>文件</span><span>快捷指令</span></nav>
  ${state.enabled ? `<button class="monitor-strip ${state.tone==='warn'?'warn':''}" data-action="monitor" aria-label="查看长任务监控">${icon(state.tone==='warn'?'alert':'eye')}<strong>${offline ? '离线 · 上次状态' : state.strip}</strong><span class="strip-meta">${state.count}/3 次续接</span>${icon('chevron')}</button>`:''}
  <section class="terminal" aria-label="原终端内容"><div class="dim" style="font-size:10px;margin-bottom:20px">Codex · browser-viewer · wt-1</div><div class="prompt"><span>›</span><div>${data.goal}</div></div><h3>• 已完成附件上传与发送</h3><p>图片预览、文件名称与大小展示已接入。<br>取消上传时会清理当前附件草稿。</p><pre><span class="dim">$</span> pnpm --filter @runweave/frontend typecheck
<span class="success">✓ TypeScript 检查通过</span>

<span class="dim">Changed files</span>
  attachment-preview.tsx
  terminal-composer.tsx
  upload-service.ts</pre>${state.count?`<div class="continuation"><small>长任务监控 · 第 ${Math.min(state.count,3)} 次进展问询</small>${data.followup}</div>`:''}<h3>• ${stateKey==='blocked'?'真机验收等待设备解锁':stateKey==='completed'?'任务已完成':'验收进展'}</h3><p>${terminalNote}</p><div class="dim">${stateKey==='blocked'?'等待你的下一步操作。':stateKey==='limit'?'本轮已结束。':'›'}<span class="cursor"></span></div></section>
  <div class="float-tools"><span class="reply">${icon('question')} 回复辅助</span><button class="compose" aria-label="打开终端输入" data-action="compose" ${offline?'disabled':''}>${icon('compose')}</button></div>${homebar()}`;
}
function monitorBody(){
  const s=current();
  const latest = s.outcome;
  const actionLabel = stateKey==='blocked' ? '回到终端处理' : stateKey==='limit' ? '回到终端继续' : '回到终端';
  return `<div class="sheetbody">${offline?'<div class="offline-banner">电脑暂时离线，显示上次同步的状态。连接恢复后将更新；当前无法修改监控。</div>':''}
  <div class="setting"><div><strong>监听此终端</strong><p>切换会话后保持开启</p></div><button class="switch" role="switch" aria-label="终端任务监控" aria-checked="${s.enabled}" data-action="toggle" ${busy||offline||stateKey==='noagent'?'disabled':''}></button></div>
  ${!s.enabled ? `<div class="empty">${icon('eye')}<h2>${stateKey==='noagent'?'当前终端没有 Agent':'让任务持续推进'}</h2><p>${stateKey==='noagent'?'启动 Agent 后即可开启监控。':'最终回复到达后判断任务状态，<br>需要继续时，自动向原会话问询进展。'}</p></div>` : `<div class="statecard ${s.tone==='warn'?'warn':''}">${icon(stateKey==='completed'?'check':s.tone==='warn'?'alert':stateKey==='classifying'?'clock':'eye')}<div><strong>${busy?'正在同步…':s.title}</strong><p>${s.subtitle}</p></div></div>
  <section class="section"><div class="sectiontop"><h2>当前目标</h2></div><p class="goal">${stateKey==='waiting'?'收到最终回复后，从原会话自动读取。':data.goal}</p></section>
  <section class="section"><div class="sectiontop"><h2>本任务自动续接</h2><span><strong style="color:${stateKey==='limit'?'var(--amber)':'var(--ink)'}">${s.count}</strong> / 3 次</span></div><div class="quota ${stateKey==='limit'?'warn-quota':''}">${[1,2,3].map(n=>`<i class="${n<=s.count?'used':''}"></i>`).join('')}</div><p class="hint">新会话或新的用户输入开始新一轮。</p></section>
  <section class="section"><div class="sectiontop"><h2>${['error','classifying'].includes(stateKey)?'本轮判断':'最新判断'}</h2><span>${latest?'14:32':''}</span></div>${latest?`<p class="decision-title">${latest}</p><p class="decision-reason">${s.reason}</p><button class="textlink" data-action="decision">查看判断依据 ${icon('chevron')}</button>`:`<p class="decision-reason">${stateKey==='waiting'?'尚未收到最终回复。':stateKey==='classifying'?'正在读取最终回复并判断，当前轮尚无有效结果。':'本轮尚无有效判断，不代表任务已经完成。'}</p>`}</section>
  <section class="section"><div class="sectiontop"><h2>最近活动</h2><button class="textlink" style="padding:0;min-height:28px" data-action="history">全部 ${icon('chevron')}</button></div><ul class="history"><li>${latest ? s.delivery : '等待当前轮判断'}<time>14:32</time></li><li>已开启终端监控<time>14:26</time></li></ul></section>`}</div>
  <footer class="sheetfoot"><button class="primary" data-action="${s.enabled?'terminal':'toggle'}" ${offline||busy||stateKey==='noagent'?'disabled':''}>${s.enabled?icon('arrow'):icon('eye')}${busy?'正在同步…':s.enabled?actionLabel:'开启监控'}</button>${s.enabled?'<p class="footnote">返回终端不会关闭监控</p>':''}${homebar()}</footer>`;
}
function decisionBody(){
  const s=current();
  const scores=data.scores[stateKey] || data.scores.watching;
  return `<div class="sheetbody"><div class="sectiontop"><h2>三分类相对评分</h2><span>14:32 · Codex</span></div>${['任务已完成','需要你处理','任务可以继续'].map((label,i)=>`<div class="score ${label===s.outcome?'chosen':''}"><span>${label}</span><strong>${scores[i].toFixed(1)}</strong><span class="score-track"><i style="width:${scores[i]}%"></i></span></div>`).join('')}<p class="hint">评分表示选项的相对倾向，不代表正确率。</p><section class="section"><div class="sectiontop"><h2>判断理由</h2></div><p class="decision-reason">${s.reason}</p></section><section class="section"><div class="sectiontop"><h2>完整最终回复</h2></div><p class="replyblock">${escape(s.reply)}</p></section><section class="section"><div class="sectiontop"><h2>续接状态</h2></div><p class="decision-reason">${s.delivery}</p>${s.delivery==='原会话已接收'?`<p class="replyblock" style="margin-top:10px">${data.followup}</p>`:''}</section><section class="section"><div class="sectiontop"><h2>本次输入与来源</h2></div><button class="textlink" data-action="source">查看任务、范围修改与计划 ${icon('chevron')}</button></section><details class="section"><summary style="font-size:11px;color:var(--muted)">监听身份与判定信息</summary><div class="metadata">模型 <span>Codex · gpt-6</span></div><div class="metadata">耗时 <span>8.2 秒</span></div><div class="metadata">目标版本 <span>2</span></div><p class="hint" style="margin-top:8px;overflow-wrap:anywhere">终端 terminal-03 · 面板 panel-01<br>会话 thread-attachment-01<br>判断 decision-1432</p></details></div><footer class="sheetfoot"><button class="primary" data-action="monitor">返回监控</button>${homebar()}</footer>`;
}
function overlay(){
  if(menu) return `<button class="scrim" data-action="dismiss" aria-label="关闭菜单"></button><nav class="menu" aria-label="终端操作菜单"><button data-action="monitor"><span>长任务监控</span><small>${current().enabled?'已开启':'未开启'}</small></button><div style="border-top:1px solid var(--line)"></div><div style="padding:13px;color:var(--muted);font-size:12px">终端信息</div><div style="padding:13px;color:var(--muted);font-size:12px">终端历史</div></nav>`;
  if(!sheet)return '';
  const names={monitor:'长任务监控',decision:'判断依据',history:'监控活动',source:'输入与来源',composer:'终端输入'};
  let body;
  if(sheet==='monitor')body=monitorBody();
  if(sheet==='decision')body=decisionBody();
  if(sheet==='history')body=`<div class="sheetbody"><div class="sectiontop"><h2>今天</h2><span>功能开发</span></div><ul class="history"><li>${current().delivery||'等待最终回复'}<time>14:32</time></li><li>${current().outcome||'正在判断任务状态'}<time>14:32</time></li><li>已收到 Agent 最终回复<time>14:31</time></li><li>已开启终端监控<time>14:26</time></li></ul><p class="hint">监听此终端 · ${data.computer}</p></div><footer class="sheetfoot"><button class="primary" data-action="monitor">返回监控</button>${homebar()}</footer>`;
  if(sheet==='source')body=`<div class="sheetbody"><div class="sectiontop"><h2>原始任务</h2></div><p class="replyblock">${data.goal}</p><section class="section"><div class="sectiontop"><h2>用户范围修改</h2></div><p class="replyblock">沿用当前方案，完成后报告结果。</p></section><section class="section"><div class="sectiontop"><h2>相关计划</h2></div><p class="replyblock">docs/plans/terminal-attachments.md<br><br>支持图片和文件上传、预览、取消与发送；核对手机端交互反馈。</p></section><section class="section"><div class="sectiontop"><h2>相关对话</h2></div><p class="replyblock">Agent：上传和发送链路已接通。<br>用户：也需要验收手机端操作。</p></section></div><footer class="sheetfoot"><button class="primary" data-action="decision">返回判断依据</button>${homebar()}</footer>`;
  if(sheet==='composer')body=`<div class="sheetbody composer-sheet"><textarea aria-label="给原 Agent 的消息" placeholder="给原 Agent 发送消息…">${escape(draft)}</textarea><p class="hint" style="margin-top:12px">Codex · 当前会话</p></div><footer class="sheetfoot"><button class="primary" data-action="send" ${offline?'disabled':''}>发送 ${icon('arrow')}</button>${homebar()}</footer>`;
  return `<button class="scrim" data-action="dismiss" aria-label="关闭面板"></button><section class="sheet" role="dialog" aria-modal="true" aria-label="${names[sheet]}"><div class="grab" data-grab></div><header class="sheethead"><div><h1>${names[sheet]}</h1><small>${data.terminal} · ${data.computer}</small></div><button class="close" data-action="dismiss" aria-label="关闭面板">${icon('close')}</button></header>${body}</section>`;
}
function render(){ app.innerHTML=`<div style="display:contents" ${sheet||menu?'inert':''}>${terminalView()}</div>`+overlay()+(toast?`<div class="toast" role="status">${toast}</div>`:''); }
function showToast(message){toast=message;render();setTimeout(()=>{toast='';render();},2200);}
function dismiss(){sheet=null;menu=false;render();}
async function toggle(){
  if(busy||offline||stateKey==='noagent')return;
  busy=true;render();
  await new Promise(resolve=>setTimeout(resolve,350));
  if(current().enabled){lastEnabledState=stateKey;stateKey='off';}else{stateKey=lastEnabledState||'waiting';}busy=false;render();
}
app.addEventListener('click',event=>{
  const button=event.target.closest('[data-action]');if(!button||button.disabled)return;
  const action=button.dataset.action;
  if(action==='toggle'){void toggle();return;}
  if(action==='dismiss'||action==='terminal'){dismiss();return;}
  if(action==='menu'){menu=!menu;sheet=null;render();return;}
  if(['monitor','decision','history','source'].includes(action)){sheet=action;menu=false;render();return;}
  if(action==='compose'){sheet='composer';menu=false;render();return;}
  if(action==='send'){
    const input=app.querySelector('textarea');draft=input.value;
    if(!draft.trim()){input.focus();return;}
    draft='';stateKey='watching';data.states.watching.count=0;sheet=null;
    showToast('消息已发送');
  }
});
app.addEventListener('input',event=>{if(event.target.matches('textarea'))draft=event.target.value;});
document.addEventListener('keydown',event=>{if(event.key==='Escape')dismiss();});
let touchStart;
app.addEventListener('touchstart',event=>{if(event.target.closest('[data-grab]'))touchStart=event.touches[0].clientY;},{passive:true});
app.addEventListener('touchend',event=>{if(touchStart!==undefined&&event.changedTouches[0].clientY-touchStart>55)dismiss();touchStart=undefined;},{passive:true});
fetch('./mock-state.json').then(r=>{if(!r.ok)throw new Error('样例数据未加载');return r.json();}).then(value=>{data=value;stateKey=params.get('state')||'watching';if(!data.states[stateKey])stateKey='watching';sheet=params.get('sheet');if(!['monitor','decision','history','source'].includes(sheet))sheet=null;render();}).catch(error=>{app.textContent=error.message;});
