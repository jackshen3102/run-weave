const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const variant = params.get('variant') === 'focus' ? 'focus' : 'dock';
const state = {tab:'terminal', keyboard:params.has('keyboard'), tools:false, running:params.has('running'), offline:params.has('offline'), draft:'', sheet:null};
const paths = {back:'m14 5-7 7 7 7',more:'M5 12h.01M12 12h.01M19 12h.01',plus:'M12 5v14M5 12h14',mic:'M9 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3',send:'m6 12 6-6 6 6M12 6v13',keys:'M3 5h18v13H3zM6 9h.1M10 9h.1M14 9h.1M18 9h.1M7 14h10',folder:'M3 6h7l2 3h9v11H3z',close:'m6 6 12 12M18 6 6 18',stop:'M7 7h10v10H7z',image:'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M16 7h.01',down:'m6 9 6 6 6-6'};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.more}"/></svg>`;
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button = (action,label,name,extra='') => `<button class="icon ${extra}" data-action="${action}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
const toolsToggle = () => `<button class="icon tool-toggle" data-action="tools" aria-label="${state.tools?'收起快捷键':'展开快捷键'}" title="${state.tools?'收起快捷键':'展开快捷键'}" aria-expanded="${state.tools}" aria-controls="terminal-keys">${icon('keys')}</button>`;
let data;
function render(){
  app.className=`app ${variant} ${state.tools?'tools':''} ${state.keyboard?'editing':''}`;
  app.innerHTML=`<div class="statusbar"><span>9:41</span><span>▮▮▮  Wi-Fi ▰</span></div>
  <header class="topbar">${button('back','返回终端列表','back')}<div class="heading"><strong>${escape(data.agent)} <span class="dim" style="font-weight:400">/ ${escape(data.project)}</span></strong><small><i class="online"></i>${state.offline?'连接已断开':escape(data.machine)+' · 已连接'}</small></div>${variant==='focus'?button('files','文件与变更','folder'):''}${button('menu','更多操作','more')}</header>
  ${state.offline?'<div class="offline">连接已断开 · 草稿已保留 <button data-action="reconnect">重新连接</button></div>':''}
  <nav class="tabs" aria-label="终端视图">${[['terminal','终端'],['changes','变更'],['files','文件']].map(([id,label])=>`<button class="${state.tab===id?'active':''}" data-tab="${id}">${label}${id==='changes'?'<span class="badge">3</span>':''}</button>`).join('')}</nav>
  ${state.tab==='terminal'?`<section class="terminal" aria-label="终端输出">${data.output.map(line=>`<p class="${line.tone}">${escape(line.text)}</p>`).join('')}<div class="rule"></div><span class="dim">❯ </span><span class="cursor"></span><div class="running-status">${state.running?'◌ Working… · 12s':''}</div></section>`:filePanel(state.tab)}
  <section class="dock ${state.tab!=='terminal'?'hidden':''}"><div id="terminal-keys" class="keys" aria-label="终端按键">${['^C','Tab','Esc','↑','↓','↵'].map(key=>`<button data-key="${key}" ${state.offline?'disabled':''}>${key}</button>`).join('')}</div>
  <div class="composer">${variant==='dock'?button('attachments','添加图片','plus','attachment'):toolsToggle()}<textarea aria-label="命令草稿" placeholder="${state.keyboard?'输入命令或告诉 Agent 要做什么…':'输入命令…'}">${escape(state.draft)}</textarea><div class="composer-actions">${variant==='dock'?toolsToggle():button('attachments','添加图片','plus','media')}<span class="mode">${state.keyboard?'编辑草稿': '草稿'}</span>${button('keyboard','收起键盘','down','media '+(state.keyboard?'':'hidden'))}${button('voice','语音输入','mic','media')}<button class="send" data-action="send" aria-label="${state.running&&!state.draft?'停止':'发送'}" ${state.offline||(!state.running&&!state.draft)?'disabled':''}>${icon(state.running&&!state.draft?'stop':'send')}</button></div></div></section>
  <div class="keyboard ${state.keyboard?'visible':''}" aria-hidden="true">${['qwertyuiop','asdfghjkl','⇧zxcvbnm⌫'].map(row=>`<div class="keyrow">${[...row].map(k=>`<span>${k}</span>`).join('')}</div>`).join('')}<div class="keyrow"><span>123</span><span>◉</span><span class="space">空格</span><span>换行</span></div></div><div class="home"></div>`;
  if(state.sheet) showSheet(state.sheet);
  const output=app.querySelector('.terminal');if(output)output.scrollTop=output.scrollHeight;
}
function filePanel(tab){return `<section class="panel"><p class="dim" style="font-size:12px">${tab==='changes'?'3 个文件有变更':escape(data.cwd)}</p>${data.files.map(file=>`<div class="file">${icon('folder')}<div>${escape(file.name)}<small>${escape(file.path)}</small></div>${tab==='changes'?`<span class="count">${file.count}</span>`:''}</div>`).join('')}</section>`;}
function showSheet(type){
 const content={
 menu:`<h2>终端操作</h2><p>${escape(data.cwd)}</p>${[...(variant==='focus'?[['attachments','添加图片'],['voice','语音输入']]:[]),['history','终端历史'],['keyboard','收起键盘'],['reconnect','重新连接'],['diagnostics','诊断'],['delete','删除终端']].map(([a,t])=>`<button class="row ${a==='delete'?'destructive':''}" data-action="${a}">${t}</button>`).join('')}`,
 files:`<h2>工作区</h2><button class="row" data-action="changes">变更 <span class="badge">3</span></button>${filePanel('files')}`,
 attachments:`<h2>添加到草稿</h2><button class="row" data-action="pick-image">${icon('image')}选择图片</button>`,
 voice:`<h2>语音输入</h2><p>00:08　▂ ▄ ▆ ▃ █ ▄ ▆ ▂ ▅</p><button class="row" data-action="transcribe">完成并转写</button><button class="row" data-action="dismiss">取消</button>`,
 history:`<h2>终端历史</h2><p>检查终端输入区域的布局，先整理问题，不修改代码。</p>`,
 diagnostics:`<h2>连接状态</h2><p>MacBook Pro · 已连接</p>`,
 delete:`<h2>删除终端？</h2><p>删除后将结束该远端终端会话。</p><button class="row destructive" data-action="confirm-delete">删除</button>`,
 changes:`<h2>变更 <span class="badge">3</span></h2>${filePanel('changes')}`,
 back:`<h2>终端</h2><button class="row" data-action="dismiss">Codex / browser-viewer <span class="dim">当前会话</span></button>`
 };
 app.insertAdjacentHTML('beforeend',`<div class="sheet-backdrop"><section class="sheet"><div class="handle"></div><div class="sheet-head"><span></span>${button('dismiss','关闭','close')}</div>${content[type]||''}</section></div>`);
}
function toast(text){const old=app.querySelector('.toast');old?.remove();const node=document.createElement('div');node.className='toast';node.textContent=text;node.setAttribute('role','status');app.append(node);setTimeout(()=>node.remove(),1600);}
app.addEventListener('input',event=>{if(event.target.matches('textarea')){state.draft=event.target.value;const send=app.querySelector('[data-action="send"]');send.disabled=state.offline||(!state.running&&!state.draft.trim());send.innerHTML=icon(state.running&&!state.draft.trim()?'stop':'send');send.setAttribute('aria-label',state.running&&!state.draft.trim()?'停止':'发送');}});
app.addEventListener('focusin',event=>{if(event.target.matches('.composer textarea')){state.keyboard=true;app.classList.add('editing');app.querySelector('.keyboard').classList.add('visible');app.querySelector('.composer [data-action=keyboard]')?.classList.remove('hidden');const output=app.querySelector('.terminal');if(output)output.scrollTop=output.scrollHeight;}});
app.addEventListener('pointerdown',event=>{if(event.target.closest('[data-action=tools]'))event.preventDefault();});
app.addEventListener('click',event=>{
 const target=event.target.closest('button');if(!target)return;
 if(target.dataset.key){toast(`${target.dataset.key} 已发送`);return;}
 if(target.dataset.tab){state.tab=target.dataset.tab;state.keyboard=false;render();return;}
 const action=target.dataset.action;
 if(['menu','attachments','voice','files','history','diagnostics','delete','changes','back'].includes(action)){state.sheet=action;render();return;}
 if(action==='dismiss'){state.sheet=null;render();return;}
 if(action==='keyboard'){state.keyboard=false;state.sheet=null;render();return;}
 if(action==='tools'){
   const output=app.querySelector('.terminal');
   const atBottom=output && output.scrollHeight-output.scrollTop-output.clientHeight<2;
   state.tools=!state.tools;
   app.classList.toggle('tools',state.tools);
   target.setAttribute('aria-expanded',String(state.tools));
   target.setAttribute('aria-label',state.tools?'收起快捷键':'展开快捷键');
   target.title=state.tools?'收起快捷键':'展开快捷键';
   if(atBottom)output.scrollTop=output.scrollHeight;
   return;
 }
 if(action==='reconnect'){state.offline=false;state.sheet=null;render();toast('已连接');return;}
 if(action==='pick-image'||action==='transcribe'){state.draft+=(state.draft?'\n':'')+(action==='pick-image'?'[图片] terminal-layout.png':'请把输入区整理得更紧凑一些');state.sheet=null;render();return;}
 if(action==='send'){if(state.draft.trim()){data.output.push({tone:'',text:'› '+state.draft});state.draft='';state.running=true;}else{state.running=false;}render();return;}
 if(action==='confirm-delete'){state.sheet=null;render();toast('终端已移除');}
});
fetch('./mock-state.json').then(r=>r.json()).then(value=>{data=value;render();});
