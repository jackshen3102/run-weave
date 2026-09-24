// Integration probe: real Pi CLI in a tmux PTY, a loopback HTTP/WS fault service,
// and an observer extension using only public events. Never imports recovery implementation.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const caseId = option('--case', 'PCR-001');
const sharedProfile = args.includes('--shared-profile');
if(sharedProfile && caseId==='PCR-009')throw new Error('PCR-009 requires the isolated-profile contract.');
const ordinarySettings=path.join(os.homedir(),'.pi/agent/settings.json');
const hashFile=p=>fs.existsSync(p)?createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;
const ordinaryHash=hashFile(ordinarySettings);
const out = path.resolve(option('--output', fs.mkdtempSync(path.join(os.tmpdir(), 'pi-recovery-evidence-'))));
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-recovery-fixture-'));
const profile = path.join(work, sharedProfile ? 'agent' : 'agent-codex-recovery'); fs.mkdirSync(profile);
const existingFd=path.join(os.homedir(),'.pi/agent/bin/fd');
if(fs.existsSync(existingFd)){fs.mkdirSync(path.join(profile,'bin'));fs.symlinkSync(existingFd,path.join(profile,'bin/fd'));}
const cwd = path.join(work, 'workspace'); fs.mkdirSync(cwd);
const socket = path.join(work, 'tmux.sock');
const cli = option('--pi', path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'));
const piVersion = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim();
const validatedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies['@earendil-works/pi-coding-agent'];
if(caseId==='PCR-012' && (!sharedProfile || piVersion===validatedVersion))throw new Error('PCR-012 requires --shared-profile and --pi pointing to an unvalidated Pi version.');
const observerLog = path.join(out, 'observer.jsonl');
const serviceLog = path.join(out, 'service.jsonl');
const observer = path.join(work, 'observer.ts');
const settings = { retry: { enabled: sharedProfile }, defaultProvider: 'openai-codex', defaultModel: 'gpt-6-astra',
  lastChangelogVersion:piVersion, defaultThinkingLevel: 'off', defaultProjectTrust: 'always', hideThinkingBlock: true };
const writeSettings = () => fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
if(caseId==='PCR-009') settings.retry.enabled=true;
if(caseId==='PCR-010') settings.compaction={enabled:true,reserveTokens:2000,keepRecentTokens:5};
writeSettings();
const fakeToken = 'fake.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url') + '.FAKE_SECRET_MARKER';
fs.writeFileSync(path.join(profile, 'auth.json'), JSON.stringify({ 'openai-codex': { type: 'oauth', access: fakeToken, refresh: 'fake-refresh', expires: Date.now()+86400000, accountId: 'fixture-account' } }), { mode: 0o600 });
fs.writeFileSync(observer, `import fs from 'node:fs';
import { Type } from ${JSON.stringify(path.join(root, 'node_modules/typebox/build/index.mjs'))};
export default function(pi) {
 const log = x => fs.appendFileSync(${JSON.stringify(observerLog)}, JSON.stringify({at:Date.now(),...x})+'\\n');
 for(const name of ['session_start','agent_start','agent_end','agent_settled','session_compact','session_compact_failed','tool_execution_start','tool_execution_end','message_end'])
  pi.on(name,(event)=>log(event));
 pi.registerTool({name:'fixture_tick',label:'Fixture tick',description:'Increment an isolated fixture counter.',parameters:Type.Object({tag:Type.String()}),
  async execute(id,args){ fs.appendFileSync(${JSON.stringify(path.join(out, 'tools.jsonl'))},JSON.stringify({id,...args})+'\\n');return {content:[{type:'text',text:'tick saved '+args.tag}],details:{}};}});
}
`);

const readLines = p => { try { return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)); } catch { return []; } };
const log = value => fs.appendFileSync(serviceLog, JSON.stringify({ at: Date.now(), ...value }) + '\n');
let scenario = caseId; let upgrades = 0, posts = 0, calls = 0; let phaseCalls = 0;
let lastInput = []; let handshakeHang = false; const rawSockets = new Set();
const wss = new WebSocketServer({ noServer: true });
const textItem = (id, text) => ({type:'message',id,role:'assistant',content:[{type:'output_text',text,annotations:[]}]});
const toolItem = (tag) => ({type:'function_call',id:'fc_'+tag,call_id:'call_'+tag,name:'fixture_tick',arguments:JSON.stringify({tag})});
const events = (text='NEW_FINAL', tool, complete=true) => {
 const id='resp_'+calls; const message=textItem(id+'_msg',text);
 const output=[message,...(tool?[toolItem(tool)]:[])];
 return [{type:'response.created',response:{id,status:'in_progress'}},
  {type:'response.output_item.added',output_index:0,item:{...message,content:[]}},
  {type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
  {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:text},
  {type:'response.output_item.done',output_index:0,item:message},
  ...(tool?[{type:'response.output_item.done',output_index:1,item:toolItem(tool)}]:[]),
  ...(complete?[{type:'response.completed',response:{id,status:'completed',output,usage:{input_tokens:20,output_tokens:5,total_tokens:25}}}]:[])];
};
function reply(send, end, body) {
 calls++; phaseCalls++; lastInput=body.input ?? [];
 log({event:'model_request',call:calls,phaseCall:phaseCalls,input:lastInput,instructions:body.instructions,tools:body.tools,scenario});
 if (scenario==='PCR-004' && calls===1) { for(const e of events('OLD_PARTIAL','discarded',false))send(e);setTimeout(end,800);return; }
 if (scenario==='PCR-004' && calls===2) { for(const e of events('NEW_FINAL','committed'))send(e);return; }
 if (scenario==='PCR-005' && calls===1) { for(const e of events('TOOL_FIRST','once'))send(e);return; }
 if (scenario==='PCR-005' && calls===2) { for(const e of events('AFTER_TOOL_INTERRUPTED',undefined,false))send(e);setTimeout(end,100);return; }
 if (scenario==='cancel_stream') { for(const e of events('WAITING_STREAM',undefined,false))send(e);return; }
 if (scenario==='compact' && phaseCalls===1) { for(const e of events('SUMMARY_INTERRUPTED',undefined,false))send(e);setTimeout(end,100);return; }
 for(const e of events(scenario==='compact'?'SUMMARY_RECOVERED':'NEW_FINAL'))send(e);
}
const server = http.createServer(async (req,res) => {
 if(req.method!=='POST'){res.writeHead(404).end();return;}
 let raw='';for await(const chunk of req)raw+=chunk;
 posts++;log({event:'http_post',posts,scenario});
 if(scenario==='PCR-001'){res.writeHead(503).end(JSON.stringify({error:{code:'server_error',message:sharedProfile?'service unavailable':'fixture unavailable'}}));return;}
 if(scenario==='unknown'){req.socket.destroy();return;}
 if(scenario.startsWith('status_')) {
  const kind=scenario.slice(7);const [status,code]=({auth:[401,'unauthorized'],forbidden:[403,'forbidden'],quota:[429,'insufficient_quota'],invalid:[400,'invalid_request_error'],short:[429,'rate_limit_exceeded'],long:[429,'rate_limit_exceeded']})[kind];
  if(kind!=='short'||phaseCalls++===0){res.writeHead(status,{'retry-after':kind==='short'?'2':kind==='long'?'61':'0'}).end(JSON.stringify({error:{code,message:'FAKE_BODY_MARKER'}}));return;}
 }
 res.writeHead(200,{'content-type':'text/event-stream'});
 reply(e=>res.write('data: '+JSON.stringify(e)+'\n\n'),()=>res.destroy(),JSON.parse(raw));
 // A completed event is enough; close the HTTP stream after the synchronous response.
 if(!['cancel_stream','PCR-004','PCR-005','compact'].includes(scenario))res.end();
});
server.on('connection',s=>{rawSockets.add(s);s.on('close',()=>rawSockets.delete(s));});
server.on('upgrade',(req,s,head)=>{
 upgrades++;log({event:'ws_upgrade',upgrades,scenario});
 if(handshakeHang){s.on('end',()=>{log({event:'client_half_close'});s.end();});s.resume();return;}
 const reject = scenario==='PCR-001'||(scenario==='PCR-002'&&upgrades<=2)?404:
  (scenario==='PCR-003'||scenario.startsWith('status_')||scenario==='unknown')?426:undefined;
 if(reject){s.end('HTTP/1.1 '+reject+' Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');return;}
 wss.handleUpgrade(req,s,head,ws=>wss.emit('connection',ws));
});
wss.on('connection',ws=>ws.on('message',data=>reply(e=>ws.send(JSON.stringify(e)),()=>ws.terminate(),JSON.parse(data.toString()))));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
fs.writeFileSync(path.join(profile,'recovery.json'),JSON.stringify({baseUrl:`http://127.0.0.1:${port}`,...(sharedProfile?{profile:'shared'}:{})}));
if(caseId==='PCR-012')fs.writeFileSync(path.join(profile,'models.json'),JSON.stringify({providers:{'openai-codex':{baseUrl:`http://127.0.0.1:${port}`}}}));
const tmux = (...args) => execFileSync('tmux',['-S',socket,...args],{encoding:'utf8'});
const quote = s => "'"+s.replaceAll("'","'\\''")+"'";
let started=false;
function launch(dir=profile, print=false) {
 const argv=[process.execPath,cli,'--no-extensions','-e',path.join(root,'src/index.ts'),'-e',observer,'--no-skills','--no-prompt-templates','--no-themes','--append-system-prompt','PI_RECOVERY_SYSTEM_MARKER',...(print?['--print','fixture request']:[])];
 const command=`cd ${quote(cwd)} && PI_CODING_AGENT_DIR=${quote(dir)} ${argv.map(quote).join(' ')} 2>${quote(path.join(out,'stderr.log'))}`;
 tmux('new-session','-d','-x','150','-y','45','-s','probe',command);started=true;
}
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function until(predicate,timeout=30000) {
 const end=Date.now()+timeout;
 while(Date.now()<end){if(predicate())return;await pause(100);}
 throw new Error('Timed out waiting for fixture condition');
}
const observe=()=>readLines(observerLog);
const recovery=()=>readLines(path.join(profile,'recovery.jsonl'));
const terminals=()=>recovery().filter(e=>e.event==='terminal');
const capture=name=>{const text=tmux('capture-pane','-p','-S','-300','-t','probe');fs.writeFileSync(path.join(out,name+'.txt'),text);return text;};
async function prompt(text='fixture request') {tmux('send-keys','-t','probe','-l',text);tmux('send-keys','-t','probe','Enter');}
async function run(text='fixture request',timeout=30000) {
 const previous=observe().filter(e=>e.type==='agent_settled').length;
 await prompt(text);await until(()=>observe().filter(e=>e.type==='agent_settled').length>previous,timeout);await pause(200);
}
async function newSession(){const n=observe().filter(e=>e.type==='session_start').length;await prompt('/new');await until(()=>observe().filter(e=>e.type==='session_start').length>n);await pause(150);}
function assertNoExtra(){const n=terminals().length;assert(n>0);}
try {
 launch();await until(()=>observe().some(e=>e.type==='session_start'));capture('startup');
 if(caseId==='PCR-001') {
  await run();assert.equal(upgrades,6);assert.equal(posts,6);assert.equal(terminals().length,1);assert.equal(terminals()[0].kind,'error');
  const retry=recovery().filter(e=>e.event==='retry');assert.equal(retry.length,10);
  for(const e of retry){const base=200*2**(e.attempt-1);assert(e.delayMs>=Math.floor(base*.9)&&e.delayMs<base*1.1);}
  const n=upgrades+posts;await pause(1000);assert.equal(upgrades+posts,n);
  if(sharedProfile)assert.equal(recovery().filter(e=>e.event==='outer_retry_suppressed').length,1);
 } else if(caseId==='PCR-002') {
  await run();assert.equal(upgrades,3);assert.equal(posts,0);assert.equal(terminals().at(-1).kind,'success');
  await run('second request');assert.equal(upgrades,3);assert.equal(calls,2);assert.equal(recovery().filter(e=>e.event==='attempt').at(-1).attempt,1);
 } else if(caseId==='PCR-003') {
  await run();await run('second request');assert.equal(upgrades,1);assert.equal(posts,2);
  await newSession();await run('new session request');assert.equal(upgrades,2);assert.equal(posts,3);
 } else if(caseId==='PCR-004') {
  const n=observe().filter(e=>e.type==='agent_settled').length;await prompt();await until(()=>calls===1);await pause(300);
  assert(capture('partial').includes('OLD_PARTIAL'));await until(()=>observe().filter(e=>e.type==='agent_settled').length>n);await pause(200);
  const screen=capture('replaced');assert(!screen.includes('OLD_PARTIAL'));assert(!screen.includes('discarded'));assert(screen.includes('NEW_FINAL'));
  const tools=readLines(path.join(out,'tools.jsonl'));assert.deepEqual(tools.map(e=>e.tag),['committed']);
  const ended=observe().filter(e=>e.type==='message_end'&&e.message.role==='assistant');assert(!JSON.stringify(ended).includes('OLD_PARTIAL'));assert(!JSON.stringify(lastInput).includes('discarded'));
 } else if(caseId==='PCR-005') {
  await run();assert.deepEqual(readLines(path.join(out,'tools.jsonl')).map(e=>e.tag),['once']);
  assert(JSON.stringify(lastInput).includes('call_once'));assert(JSON.stringify(lastInput).includes('tick saved once'));assert.equal(calls,3);
 } else if(caseId==='PCR-006') {
  await new Promise(r=>server.close(r));const before=Date.now();await run('offline request',325000);
  const waits=recovery().filter(e=>e.event==='network_wait');assert.deepEqual(waits.slice(0,5).map(e=>e.delayMs),[5000,10000,20000,40000,60000]);
  assert(Date.now()-waits[0].at>=299900);assert(Date.now()-before<320000);assert.equal(terminals().at(-1).kind,'error');assert.equal(recovery().filter(e=>e.event==='retry').length,0);
  const ready=observe().filter(e=>e.type==='agent_settled').length;await prompt('retry after offline');await until(()=>recovery().filter(e=>e.event==='network_wait').length>waits.length);
  await new Promise(r=>server.listen(port,'127.0.0.1',r));await until(()=>observe().filter(e=>e.type==='agent_settled').length>ready,20000);assert.equal(terminals().at(-1).kind,'success');
 } else if(caseId==='PCR-007') {
  for(const phase of ['connect','stream','retry','network']) {
   await newSession();scenario=phase==='retry'?'PCR-001':phase==='stream'?'cancel_stream':'normal';handshakeHang=phase==='connect';
   if(phase==='network')await new Promise(r=>server.close(r));
   const n=terminals().length, attempts=recovery().filter(e=>e.event==='attempt').length, upgradesBefore=upgrades;
   await prompt('cancel '+phase);
   await until(()=>phase==='connect'?upgrades>upgradesBefore:phase==='stream'?recovery().filter(e=>e.event==='attempt').length>attempts:recovery().slice(-1)[0]?.event===(phase==='retry'?'retry':'network_wait'));
   if(phase==='stream')await pause(200);
   tmux('send-keys','-t','probe','Escape');await until(()=>terminals().length>n);assert.equal(terminals().at(-1).kind,'aborted');
   const total=upgrades+posts;await pause(1000);assert.equal(upgrades+posts,total);assert.equal(rawSockets.size,0);capture('cancel-'+phase);
   handshakeHang=false;for(const s of rawSockets)s.destroy();if(phase==='network')await new Promise(r=>server.listen(port,'127.0.0.1',r));
  }
 } else if(caseId==='PCR-008') {
  for(const kind of ['auth','forbidden','quota','invalid','short','long']){
   await newSession();scenario='status_'+kind;phaseCalls=0;const before=posts;
   await run(kind);assert.equal(posts-before,kind==='short'?2:1);assert.equal(terminals().at(-1).kind,kind==='short'?'success':'error');
   if(kind==='short'){const wait=recovery().filter(e=>e.event==='retry').at(-1);assert.equal(wait.delayMs,2000);const requests=readLines(serviceLog).filter(e=>e.event==='http_post'&&e.scenario==='status_short');assert(requests[1].at-requests[0].at>=1990);}
   if(kind==='auth')assert(capture('auth-error').includes('/login'));
  }
 } else if(caseId==='PCR-009') {
  settings.retry.enabled=true;writeSettings();const before=upgrades+posts;await run();assert.equal(upgrades+posts,before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).retry.enabled,true);
  // Misconfigured profiles fail before sending, independent of Pi's own outer retry setting.
  settings.retry.enabled=false;writeSettings();tmux('kill-session','-t','probe');started=false;
  const wrong=path.join(work,'ordinary');fs.mkdirSync(wrong);if(fs.existsSync(existingFd)){fs.mkdirSync(path.join(wrong,'bin'));fs.symlinkSync(existingFd,path.join(wrong,'bin/fd'));}for(const file of ['auth.json','settings.json','recovery.json'])fs.copyFileSync(path.join(profile,file),path.join(wrong,file));
  const settingsBefore=fs.readFileSync(path.join(wrong,'settings.json'),'utf8');const n=observe().filter(e=>e.type==='session_start').length;
  launch(wrong);await until(()=>observe().filter(e=>e.type==='session_start').length>n);await run();assert.equal(upgrades+posts,before);assert.equal(fs.readFileSync(path.join(wrong,'settings.json'),'utf8'),settingsBefore);
  tmux('kill-session','-t','probe');started=false;
  const printed=spawn(process.execPath,[cli,'--print','--no-extensions','-e',path.join(root,'src/index.ts'),'fixture request'],{cwd,env:{...process.env,PI_CODING_AGENT_DIR:profile},stdio:['ignore','pipe','pipe']});
  let printErrors='';printed.stderr.on('data',chunk=>{printErrors+=chunk.toString();});
  let printOutput='';for await(const chunk of printed.stdout)printOutput+=chunk;await new Promise(r=>printed.exitCode!==null?r():printed.on('exit',r));
  fs.writeFileSync(path.join(out,'print-mode.txt'),printOutput+printErrors);assert.equal(upgrades+posts,before);assert((printOutput+printErrors).includes('TUI'));
  assert.equal(hashFile(ordinarySettings),ordinaryHash);
  const catalog=execFileSync(process.execPath,[cli,'--no-extensions','--list-models','gpt-6-astra'],{cwd,env:{...process.env,PI_CODING_AGENT_DIR:path.dirname(ordinarySettings)},encoding:'utf8'});
  assert(catalog.includes('gpt-6-astra'));fs.writeFileSync(path.join(out,'ordinary-models.txt'),catalog);
  const historyRoot=path.join(path.dirname(ordinarySettings),'sessions');
  if(fs.existsSync(historyRoot)){const file=fs.readdirSync(historyRoot,{recursive:true}).find(p=>String(p).endsWith('.jsonl'));if(file){const fd=fs.openSync(path.join(historyRoot,String(file)),'r');const buf=Buffer.alloc(8192);const n=fs.readSync(fd,buf,0,buf.length,0);fs.closeSync(fd);assert(JSON.parse(buf.toString('utf8',0,n).split('\n')[0]).type==='session');}}
  fs.writeFileSync(path.join(out,'ordinary-config.json'),JSON.stringify({before:ordinaryHash,after:hashFile(ordinarySettings),catalogReadable:true,historyHeaderReadable:true}));
 } else if(caseId==='PCR-010') {
  await run('first fixture conversation');await run('second fixture conversation');scenario='compact';phaseCalls=0;
  const n=observe().filter(e=>e.type==='session_compact').length;await prompt('/compact');await until(()=>observe().filter(e=>e.type==='session_compact').length>n,30000);
  assert.equal(phaseCalls,2);assert.equal(terminals().at(-1).kind,'success');
  const startedAt=readLines(serviceLog).find(e=>e.event==='model_request'&&e.scenario==='compact').at;
  const compacted=observe().filter(e=>e.type==='session_compact').at(-1);
  assert(!observe().some(e=>e.type==='agent_settled'&&e.at>=startedAt&&e.at<compacted.at));
  assert(compacted.compactionEntry.summary.includes('SUMMARY_RECOVERED'));
  await run('continue after compact');assert.equal(terminals().at(-1).kind,'success');
 } else if(caseId==='PCR-011') {
  scenario='unknown';await run('FAKE_BODY_MARKER');assert.equal(posts,6);assert.equal(recovery().filter(e=>e.event==='network_wait').length,0);
  const diagnostic=fs.readFileSync(path.join(profile,'recovery.jsonl'),'utf8');assert(!diagnostic.includes('FAKE_BODY_MARKER'));assert(!diagnostic.includes('FAKE_SECRET_MARKER'));assert(!diagnostic.includes(fakeToken));
 } else if(caseId==='PCR-012') {
  assert(capture('native-version').includes("using Pi's native Codex provider"));
  await run();await newSession();await run('second native request');
  assert.equal(calls,2);assert.equal(terminals().length,0);
  assert.equal(recovery().filter(e=>e.event==='native_version').length,2);
  assert.equal(recovery().filter(e=>e.event==='attempt'||e.event==='guard_rejected').length,0);
  const ended=observe().filter(e=>e.type==='message_end'&&e.message.role==='assistant');
  assert.equal(ended.length,2);assert(ended.every(e=>e.message.stopReason==='stop'));
  assert.equal(hashFile(ordinarySettings),ordinaryHash);
 } else throw new Error('Unknown case '+caseId);
 for(const request of readLines(serviceLog).filter(e=>e.event==='model_request'&&e.scenario!=='compact')) {
  assert(request.instructions.includes('PI_RECOVERY_SYSTEM_MARKER'));
  assert(request.tools.some(tool=>tool.name==='fixture_tick'));
 }
 if(caseId!=='PCR-012')assertNoExtra();if(sharedProfile)assert.equal(JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8')).retry.enabled,true);if(started)capture('final');
 fs.writeFileSync(path.join(out,'verdict.json'),JSON.stringify({case:caseId,status:'passed',sharedProfile,upgrades,posts,calls,fixture:work,cli,piVersion},null,2));
 console.log(JSON.stringify({case:caseId,status:'passed',output:out,upgrades,posts,calls}));
} catch(error) {
 if(started)try{capture('failure');}catch{ /* The failed TUI may already have exited. */ }
 fs.writeFileSync(path.join(out,'verdict.json'),JSON.stringify({case:caseId,status:'failed',error:String(error),fixture:work},null,2));
 console.error(error);process.exitCode=1;
} finally {
 if(started)try{tmux('kill-server');}catch{ /* Only this probe's already-exited server is ignored. */ }
 for(const ws of wss.clients)ws.terminate();for(const s of rawSockets)s.destroy();wss.close();server.close();
 if(fs.existsSync(path.join(profile,'recovery.jsonl')))fs.copyFileSync(path.join(profile,'recovery.jsonl'),path.join(out,'recovery.jsonl'));
}
