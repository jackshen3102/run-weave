/** Integration verification against disposable PostgreSQL, real HTTP/MCP and Python/Node CLIs. */
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import pg from "pg";
import { WorkRecordService } from "../src/work-records/service";
import { registerSource, stopSource } from "../src/work-records/sources";
import { createApp } from "../src/http/app";
import type { Config } from "../src/config";
import { LocalFileStore } from "../src/storage/local-files";
import { registerCredential } from "../src/mcp/credentials";
import { RecordService } from "../src/records/service";
import { BrowserHistoryWriter } from "../../browser-history/src/writer";
type BrowserVisitObservation = Parameters<BrowserHistoryWriter["append"]>[0][number];

const exec = promisify(execFile), require = createRequire(import.meta.url);
const root = await mkdtemp(join(tmpdir(), "daily-record-integration-"));
const repoRoot = resolve(import.meta.dirname, "../../..");
const runner = join(repoRoot, "plugins/toolkit/skills/daily-record/scripts/job.py");
const port = Number(process.argv[2]);
assert(port > 0 && port < 65536, "Pass an isolated PostgreSQL 18 port");
const settings = { host: "127.0.0.1", port, user: userInfo().username };
const admin = new pg.Pool({ ...settings, database: "postgres" });
const database = "daily_record_" + randomUUID().replaceAll("-", "");
let pool: pg.Pool | undefined;
let server: ReturnType<ReturnType<typeof createApp>["listen"]> | undefined;
let proxy: ReturnType<typeof createServer> | undefined;
const day = new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0,10);
const dateOffset = (n: number) => new Date(Date.parse(day) + n * 86400000).toISOString().slice(0,10);
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const context = (ownerId: string) => ({ ownerId, actor: "agent" as const, key: randomUUID(), requestId: randomUUID() });
let dropResponse = false;
let dropAllImports = false;
let conflictOnce = false;
const replayBodies: string[] = [];
try {
  assert.equal(Math.floor(Number((await admin.query("SHOW server_version_num")).rows[0].server_version_num) / 10000), 18);
  await admin.query(`CREATE DATABASE ${database}`);
  pool = new pg.Pool({ ...settings, database });
  await pool.query("CREATE TABLE suiji_migrations(name text)");
  for (const name of (await readdir(new URL("../migrations/", import.meta.url))).filter(n => n.endsWith(".cjs")).sort()) {
    const statements: string[] = [];
    require(new URL(`../migrations/${name}`, import.meta.url).pathname).up({ sql: (s: string) => statements.push(s) });
    await pool.query(statements.join("\n"));
    await pool.query("INSERT INTO suiji_migrations VALUES($1)", [name]);
  }
  const ownerId = randomUUID();
  await pool.query("INSERT INTO owners(id,username,password_hash) VALUES($1,'verify','unused')", [ownerId]);
  const serverId = (await pool.query("SELECT server_id FROM server_identity")).rows[0].server_id;
  const token = randomBytes(32).toString("base64url");
  await registerCredential(pool, { version: 1, id: randomUUID(), ownerId, serverId, name: "verification", tokenSha256: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  const records = new WorkRecordService(pool);
  const store = new LocalFileStore(join(root,"objects"));
  await store.initialize();
  const config = { NODE_ENV: "development", SUIJI_STORAGE_DIR: store.root, SUIJI_AI_PROVIDER: "disabled", SUIJI_MCP_ENABLED: true, SUIJI_APP_VERSION: "verify", SUIJI_WEB_ORIGINS: "", SUIJI_CODEX_BIN: "codex", SUIJI_AI_TIMEOUT_SECONDS: 10 } as Config;
  server = createApp(pool, store, config).listen(0, "127.0.0.1");
  await new Promise<void>(r => server!.once("listening", r));
  const address = server.address();
  assert(address && typeof address !== "string");
  const upstream = `http://127.0.0.1:${address.port}`;
  proxy = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(part);
    const body = Buffer.concat(parts);
    const rpc = JSON.parse(body.toString());
    if (conflictOnce && rpc.params?.name === "import_work_facts") {
      conflictOnce = false;
      await records.create(context(ownerId), { workDate:day, title:"并发编辑",statement:"另一个客户端的修改",status:"discussed",project:null });
    }
    const result = await fetch(upstream + request.url, { method: "POST", headers: Object.fromEntries(Object.entries(request.headers).filter(([k]) => !["host", "connection", "content-length"].includes(k)).map(([k,v]) => [k,String(v)])), body });
    const data = await result.text();
    if ((dropResponse || dropAllImports) && rpc.params?.name === "import_work_facts") {
      replayBodies.push(JSON.stringify(rpc.params.arguments));
      dropResponse = false;
      response.destroy();
      return;
    }
    response.writeHead(result.status, { "Content-Type": "application/json" });
    response.end(data);
  }).listen(0, "127.0.0.1");
  await new Promise<void>(r => proxy!.once("listening",r));
  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress !== "string");
  const endpoint = `http://127.0.0.1:${proxyAddress.port}`;
  await save(join(root,"suiji.json"), { endpoint, serverId, ownerId, tokenEnv: "DAILY_RECORD_VERIFY_TOKEN" });
  await writeFile(join(root,"token.env"), `DAILY_RECORD_VERIFY_TOKEN=${token}\n`, { mode: 0o600 });
  async function fixture(name: string, start = day, maxDaysPerRun = 7) {
    const dir = join(root,name); await mkdir(join(dir,"home/.codex/sessions"), { recursive: true, mode: 0o700 });
    const c = { schemaVersion:1, producerId:name, sourceNamespace:"daily-"+name, startDate:start, timeZone:"Asia/Shanghai", stateDir:join(dir,"state"), collectorArgv:[process.execPath,join(repoRoot,"packages/daily-record/dist/cli.cjs")], sources:{ localAgent:{ providers:["codex"],home:join(dir,"home") },feishu:{ enabled:false,channels:"messages" } },projectAliases:{},suiji:{ configPath:join(root,"suiji.json"),tokenFile:join(root,"token.env"),autoPublish:true },maxDaysPerRun };
    await save(join(dir,"job.json"),c);
    for (let d = Date.parse(start); d <= Date.parse(day); d+=86400000) {
      const date = new Date(d).toISOString().slice(0,10);
      const rows = [{type:"session_meta",payload:{id:name+date,cwd:dir}},
        {type:"response_item",timestamp:date+"T12:00:00+08:00",payload:{type:"message",role:"user",id:"message-1",content:[{type:"input_text",text:"Discussed the work on "+date}]}}];
      await writeFile(join(dir,"home/.codex/sessions",date+".jsonl"), rows.map(r=>JSON.stringify(r)).join("\n")+"\n", { mode:0o600 });
    }
    await registerSource(pool!,ownerId,{ sourceScope:`agent:${name}:codex`,producerId:name,sourceNamespace:c.sourceNamespace,name,effectiveFrom:start,effectiveTo:null });
    return { dir,c, config:join(dir,"job.json"), env:{...process.env} };
  }
  async function run(f: Awaited<ReturnType<typeof fixture>>, command: string, args: string[] = [], expected = true) {
    try {
      const result = await exec("python3",[runner,command,"--config",f.config,...args], { cwd:repoRoot, maxBuffer:4*1024*1024, env:f.env });
      assert(expected, "Expected rejection"); return JSON.parse(result.stdout);
    } catch(error) {
      if (expected) throw error;
      return JSON.parse((error as { stderr:string }).stderr);
    }
  }
  const prepare = (f: Awaited<ReturnType<typeof fixture>>, runId="run") => run(f,"prepare",["--run-id",runId,"--thread-id","report-thread","--owner-pid",String(process.pid)]);
  const own = (b: {batch:string;runId:string;generation:number}) => ["--batch",b.batch,"--run-id",b.runId,"--generation",String(b.generation)];
  async function factFile(f: Awaited<ReturnType<typeof fixture>>, b: Awaited<ReturnType<typeof prepare>>, suffix="") {
    const facts = await load(b.template), evidence = await load(join(b.batch,"evidence.json"));
    for (const m of evidence) await run(f,"read",[...own(b),"--id",m.id]);
    for (const d of facts.days) d.items = evidence.filter((m:{day:string})=>m.day===d.date).map((m:{id:string;project:null})=>({ title:"工作讨论",statement:"讨论每日记录"+suffix,status:"discussed",project:m.project,sourceIds:[m.id] }));
    const file = join(b.batch,"facts"+suffix+".json");await save(file,facts); return file;
  }
  if (!process.argv.includes("--screen-only")) {
  const f = await fixture("mac");
  const probeBin=join(f.dir,"probe-bin"), probeLog=join(f.dir,"unexpected-lark-call");
  await mkdir(probeBin,{mode:0o700});
  await writeFile(join(probeBin,"lark-cli"),"#!/usr/bin/env python3\nfrom pathlib import Path\nPath("+JSON.stringify(probeLog)+").write_text('called')\nraise SystemExit(99)\n",{mode:0o700});
  f.env.PATH=probeBin+":"+process.env.PATH;
  let b = await prepare(f);
  await assert.rejects(readFile(probeLog));
  const evidence = await load(join(b.batch,"evidence.json"));
  assert.equal(evidence.length,1);
  assert.equal((await load(join(b.batch,"batch.json"))).receipts[day].length,1);
  console.log("PASS source-selection (no Feishu dependency; one enabled provider)");
  const wrongOwner = await run(f,"prepare",["--run-id","other","--thread-id","other-thread","--owner-pid",String(process.pid)],false);
  assert.match(wrongOwner.error,/BUSY/);
  const stale = await run(f,"read",[...own(b).slice(0,-1),"999","--id",evidence[0].id],false);
  assert.match(stale.error,/OWNER_CHANGED/);
  console.log("PASS active-owner and generation fencing");
  let facts = await factFile(f,b);
  await run(f,"validate",[...own(b),"--facts",facts]);
  dropResponse = true;
  await run(f,"publish",own(b));
  const first = await records.list(ownerId,{from:day,to:day});
  const id = first.items[0]!.id;
  assert.equal(first.items.length,1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_import_runs")).rows[0].n,1);
  console.log("PASS committed-response-loss recovery (same import; real HTTP/MCP)");
  const interruptedState=await load(join(f.c.stateDir,"state.json"));
  interruptedState.active=(await load(join(b.batch,"batch.json"))).id;
  interruptedState.days={};interruptedState.identities={};await save(join(f.c.stateDir,"state.json"),interruptedState);
  assert.equal((await prepare(f)).complete,true);
  assert(Object.keys((await load(join(f.c.stateDir,"state.json"))).identities).length>0);
  console.log("PASS durable batch journal repairs interrupted local bookkeeping");
  // Reopen a successfully covered date to exercise an explicit correction replay.
  const state = await load(join(f.c.stateDir,"state.json"));state.days[day].complete=false;await save(join(f.c.stateDir,"state.json"),state);
  b=await prepare(f); facts=await factFile(f,b,"改写");
  await run(f,"validate",[...own(b),"--facts",facts]);await run(f,"publish",own(b));
  assert.equal((await records.list(ownerId,{from:day,to:day})).items[0]!.id,id);
  assert.equal((await records.list(ownerId,{from:day,to:day})).items.length,1);
  console.log("PASS stable identity across rewording");
  const catchup=await fixture("catchup",dateOffset(-2),2);
  let cb=await prepare(catchup);assert.equal((await load(cb.template)).days.length,2);
  let cf=await factFile(catchup,cb);await run(catchup,"validate",[...own(cb),"--facts",cf]);
  const partial=await run(catchup,"publish",own(cb));assert.deepEqual(partial.remainingDays,[day]);
  cb=await prepare(catchup);cf=await factFile(catchup,cb);await run(catchup,"validate",[...own(cb),"--facts",cf]);await run(catchup,"publish",own(cb));
  console.log("PASS three-day catch-up with two-day run budget");
  await registerSource(pool,ownerId,{sourceScope:"agent:offline:codex",producerId:"offline",sourceNamespace:"daily-offline",name:"离线devbox",effectiveFrom:day,effectiveTo:null});
  const missing=await records.sources(ownerId,{from:day,to:day});assert(missing.days[0]!.missingScopes.includes("agent:offline:codex"));
  assert.equal((await records.list(ownerId,{from:day,to:day})).days[0]!.coverage,"partial");
  const empty=await records.list(ownerId,{from:dateOffset(1),to:dateOffset(1)});assert.equal(empty.days[0]!.coverage,"partial");
  console.log("PASS absent producer and empty-day coverage");
  await assert.rejects(registerSource(pool,ownerId,{sourceScope:"agent:offline:codex",producerId:"another",sourceNamespace:"other",name:"冲突",effectiveFrom:day,effectiveTo:null}));
  await assert.rejects(stopSource(pool,ownerId,{sourceScope:"agent:offline:codex",effectiveTo:dateOffset(-1)}));
  assert.equal((await records.list(ownerId,{from:dateOffset(-10),to:dateOffset(-10)})).days[0]!.coverage,"unknown");
  console.log("PASS registration intervals and conservative historical coverage");

  const feishu=await fixture("feishu");
  const bin=join(feishu.dir,"bin");await mkdir(bin,{mode:0o700});
  const log=join(feishu.dir,"lark-calls.jsonl"), mode=join(feishu.dir,"mode");
  await writeFile(mode,"complete",{mode:0o600});
  const fake = `#!/usr/bin/env python3
import sys,json,pathlib
args=sys.argv[1:]
root=pathlib.Path(__file__).parent.parent
with (root/'lark-calls.jsonl').open('a') as f:f.write(json.dumps(args)+'\\n')
if args[:2]==['auth','status']:
 print(json.dumps({'identity':'user','verified':True,'identities':{'user':{'verified':True,'tokenStatus':'valid','openId':'ou_fixture','userName':'fixture'}}}));sys.exit(0)
if args[:2]==['im','+messages-search']:
 page=int(args[args.index('--page-token')+1]) if '--page-token' in args else 1
 if (root/'mode').read_text()=='partial' and page==2:sys.exit(1)
 day=args[args.index('--start')+1][:10]
 message={'message_id':'own'+str(page),'chat_id':'chat','thread_id':'thread','sender':{'id':'ou_fixture'},'create_time':day+'T12:00:00+08:00','content':'Discussed chat item '+str(page)}
 data={'messages':[message],'has_more':page<3,'page_token':str(page+1)}
 print(json.dumps({'ok':True,'identity':'user','data':data}));sys.exit(0)
if args[:2]==['im','+threads-messages-list']:
 day='${day}'
 reply={'message_id':'reply','chat_id':'chat','thread_id':'thread','sender':{'id':'ou_other'},'create_time':day+'T12:01:00+08:00','content':'A reply, not a verified outcome'}
 print(json.dumps({'ok':True,'identity':'user','data':{'messages':[reply],'has_more':False}}));sys.exit(0)
sys.exit(99)
`;
  await writeFile(join(bin,"lark-cli"),fake,{mode:0o700});
  feishu.env.PATH=bin+":"+process.env.PATH;
  Object.assign(feishu.c.sources.feishu,{enabled:true,accountScope:"fixture-account"});await save(feishu.config,feishu.c);
  await registerSource(pool,ownerId,{sourceScope:"feishu:fixture-account:messages",producerId:"feishu",sourceNamespace:feishu.c.sourceNamespace,name:"飞书fixture",effectiveFrom:day,effectiveTo:null});
  const fb=await prepare(feishu);
  await run(feishu,"context",[...own(fb),"--date",day,"--message-id","own1"]);
  const messages=await load(join(fb.batch,"evidence.json"));assert.equal(messages.filter((m:{ref:{channel:string}})=>m.ref.channel==="feishu-message").length,4);
  const calls=(await readFile(log,"utf8")).trim().split("\n").map(v=>JSON.parse(v));
  assert.equal(calls.filter((v:string[])=>v[1]==="+messages-search").length,3);
  assert(calls.every((v:string[])=>["auth","im"].includes(v[0]!)));
  const ff=await factFile(feishu,fb);await run(feishu,"validate",[...own(fb),"--facts",ff]);await run(feishu,"publish",own(fb));
  console.log("PASS Feishu three-page discovery, selected context and messages-only import");

  // Reuse only the executable fixture; each job owns separate configuration and state.
  const partialJob=await fixture("partial");partialJob.env.PATH=feishu.env.PATH;
  Object.assign(partialJob.c.sources.feishu,{enabled:true,accountScope:"partial-account"});await save(partialJob.config,partialJob.c);
  await registerSource(pool,ownerId,{sourceScope:"feishu:partial-account:messages",producerId:"partial",sourceNamespace:partialJob.c.sourceNamespace,name:"部分读取",effectiveFrom:day,effectiveTo:null});
  await writeFile(mode,"partial");
  let pb=await prepare(partialJob);let pf=await factFile(partialJob,pb);await run(partialJob,"validate",[...own(pb),"--facts",pf]);
  const partialResult=await run(partialJob,"publish",own(pb));assert(partialResult.remainingDays.includes(day));
  assert.equal((await load(join(partialJob.c.stateDir,"state.json"))).days[day].complete,false);
  await writeFile(mode,"complete");
  pb=await prepare(partialJob);pf=await factFile(partialJob,pb);await run(partialJob,"validate",[...own(pb),"--facts",pf]);await run(partialJob,"publish",own(pb));
  assert.equal((await load(join(partialJob.c.stateDir,"state.json"))).days[day].complete,true);
  console.log("PASS partial collection remains catch-up eligible and fills the same day");

  const pending=await fixture("pending");const pendingBatch=await prepare(pending);const pendingFacts=await factFile(pending,pendingBatch);
  await run(pending,"validate",[...own(pendingBatch),"--facts",pendingFacts]);
  replayBodies.length=0;dropAllImports=true;
  const unknown=await run(pending,"publish",own(pendingBatch),false);assert.match(unknown.error,/RESULT_UNKNOWN/);
  assert.equal(replayBodies.length,3);assert.equal(new Set(replayBodies).size,1);
  const pendingMeta=await load(join(pendingBatch.batch,"batch.json"));assert(pendingMeta.pending);
  const originalRequest=await readFile(pendingMeta.pending.request,"utf8");
  const changed=JSON.parse(originalRequest);changed.arguments.input.days[0].facts[0].title="篡改";
  await save(pendingMeta.pending.request,changed);
  const tampered=await run(pending,"reconcile",own(pendingBatch),false);assert.match(tampered.error,/FROZEN_REQUEST_CHANGED/);
  await writeFile(pendingMeta.pending.request,originalRequest,{mode:0o600});
  pending.c.suiji.autoPublish=false;await save(pending.config,pending.c);
  const disabled=await run(pending,"reconcile",own(pendingBatch),false);assert.match(disabled.error,/AUTO_PUBLISH_DISABLED/);
  pending.c.suiji.autoPublish=true;await save(pending.config,pending.c);
  dropAllImports=false;
  await run(pending,"reconcile",own(pendingBatch));await run(pending,"publish",own(pendingBatch));
  console.log("PASS bounded frozen-request recovery after repeated lost responses");


  const race=await fixture("race"), raceBatch=await prepare(race), raceFacts=await factFile(race,raceBatch);
  await run(race,"validate",[...own(raceBatch),"--facts",raceFacts]);conflictOnce=true;
  await run(race,"publish",own(raceBatch));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_import_runs WHERE source_namespace=$1",[race.c.sourceNamespace])).rows[0].n,1);
  const raceAttempts=(await readdir(raceBatch.batch)).filter(n=>n.startsWith("publish-"));assert.equal(raceAttempts.length,2);
  console.log("PASS feed conflict re-prepares only explicitly rejected imports");

  const restart=await fixture("restart");
  const ownerProcess=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});
  assert(ownerProcess.pid);
  let restartBatch;
  try {
    restartBatch=await run(restart,"prepare",["--run-id","old-run","--thread-id","old-thread","--owner-pid",String(ownerProcess.pid)]);
    const restartFacts=await factFile(restart,restartBatch);await run(restart,"validate",[...own(restartBatch),"--facts",restartFacts]);
    dropAllImports=true;
    await run(restart,"publish",own(restartBatch),false);
  } finally {
    dropAllImports=false;
    const exited=new Promise<void>(r=>ownerProcess.once("exit",()=>r()));ownerProcess.kill();await exited;
  }
  const before=await load(join(restartBatch.batch,"batch.json"));
  const requestText=await readFile(before.pending.request,"utf8");
  const recovered=await run(restart,"prepare",["--run-id","new-run","--thread-id","new-thread","--owner-pid",String(process.pid),"--recover-run-id","old-run"]);
  assert.equal(recovered.generation,restartBatch.generation+1);
  assert.equal(await readFile(before.pending.request,"utf8"),requestText);
  const oldWrite=await run(restart,"read",[...own(restartBatch),"--id","unused"],false);assert.match(oldWrite.error,/OWNER_CHANGED/);
  await run(restart,"reconcile",own(recovered));await run(restart,"publish",own(recovered));
  console.log("PASS process restart and pending-request generation fencing");

  const self=await fixture("self");
  for(const [name,origin] of [["report-thread","exec"],["real-background","exec"]]) {
    const rows=[{type:"session_meta",payload:{id:name,cwd:self.dir,source:origin}}, {type:"response_item",timestamp:day+"T12:00:00+08:00",payload:{type:"message",role:"user",id:name,content:[{type:"input_text",text:name}]}}];
    await writeFile(join(self.dir,"home/.codex/sessions",name!+".jsonl"),rows.map(r=>JSON.stringify(r)).join("\n")+"\n",{mode:0o600});
  }
  const sb=await prepare(self), selfEvidence=await load(join(sb.batch,"evidence.json"));
  assert(!selfEvidence.some((m:{threadId:string})=>m.threadId==="report-thread"));
  assert(selfEvidence.some((m:{threadId:string;origin:string})=>m.threadId==="real-background"&&m.origin==="background"));
  console.log("PASS own report exclusion preserves unrelated background work");


  const overflow=await fixture("overflow");
  const many=Array.from({length:101},(_,n)=>({type:"response_item",timestamp:day+"T12:00:00+08:00",payload:{type:"message",role:"user",id:"many-"+n,content:[{type:"input_text",text:"独立事项 "+n}]}}));
  await writeFile(join(overflow.dir,"home/.codex/sessions",day+".jsonl"),[{type:"session_meta",payload:{id:"overflow-thread",cwd:overflow.dir}},...many].map(r=>JSON.stringify(r)).join("\n")+"\n",{mode:0o600});
  const ob=await prepare(overflow), of=await factFile(overflow,ob);
  const tooMany=await run(overflow,"validate",[...own(ob),"--facts",of],false);assert.match(tooMany.error,/WORK_PACKAGE_LIMIT/);
  const large=await load(of);large.days[0].items=large.days[0].items.slice(0,100).map((v:object)=>({...v,statement:"字".repeat(3000)}));await save(of,large);
  const tooLarge=await run(overflow,"validate",[...own(ob),"--facts",of],false);assert.match(tooLarge.error,/WORK_PACKAGE_LIMIT/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_import_runs WHERE source_namespace=$1",[overflow.c.sourceNamespace])).rows[0].n,0);
  console.log("PASS single-day count/byte overflow and frozen-request tamper/opt-in guards");

  if (process.platform === "darwin") {
    const browserJob = await fixture("browser", dateOffset(-1));
    // Establish a real legacy job before adding a new effective-dated source.
    const legacy = await prepare(browserJob);
    const legacyFacts = await factFile(browserJob, legacy);
    await run(browserJob, "validate", [...own(legacy), "--facts", legacyFacts]);
    await run(browserJob, "publish", own(legacy));
    const previousState = await readFile(join(browserJob.c.stateDir, "state.json"), "utf8");
    const historyRoot = join(browserJob.dir, "history");
    const writer = new BrowserHistoryWriter(historyRoot);
    const sourceIds = [randomUUID(), randomUUID()];
    const visits: BrowserVisitObservation[] = Array.from({ length: 142 }, (_, n) => ({
      schemaVersion: 1, sourceId: sourceIds[n % 2]!, browser: n % 2 ? "edge" : "chrome",
      visitId: randomUUID(), revision: 1, visitedAt: day + "T04:00:00.000Z", observedAt: day + "T04:00:00.000Z",
      url: "https://example.test/docs/" + (n < 3 ? "same" : n), title: "资料 " + n,
      navigation: "document", profileLabel: "fixture", actor: "unknown",
    }));
    await writer.append(visits);
    await writer.append([{ ...visits[0]!, revision: 2, title: "标题修订" }]);
    await writer.close();
    const next = { ...browserJob.c, sources: { ...browserJob.c.sources, browser: {
      enabled: true, effectiveFrom: day, root: historyRoot,
      collectorArgv: [process.execPath, join(repoRoot, "packages/browser-history/dist/cli.cjs")], expectedSourceIds: sourceIds,
    } } };
    const nextPath = join(browserJob.dir, "next.json"); await save(nextPath, next);
    const dry = await run(browserJob, "migrate-sources", ["--next-config", nextPath, "--dry-run"]);
    assert.deepEqual(dry.affectedDays, [day]);
    assert.equal(await readFile(join(browserJob.c.stateDir, "state.json"), "utf8"), previousState);
    await run(browserJob, "migrate-sources", ["--next-config", nextPath]);
    const migrated = await load(join(browserJob.c.stateDir, "state.json"));
    assert.deepEqual(migrated.identities, JSON.parse(previousState).identities);
    assert.equal(migrated.days[dateOffset(-1)].complete, true);
    await registerSource(pool, ownerId, { sourceScope: "browser:browser:observed", producerId: "browser", sourceNamespace: browserJob.c.sourceNamespace, name: "Mac 浏览概览（仅已记录访问）", effectiveFrom: day, effectiveTo: null });
    const bb = await prepare(browserJob);
    const browserMaterials = (await load(join(bb.batch, "evidence.json"))) as { id:string; ref:{channel:string}; browserVisits?:{id:string}[]; project:null }[];
    const pages = browserMaterials.filter(m => m.ref.channel === "browser-visit");
    assert.equal(pages.length, 140);
    assert.equal(pages.reduce((n, m) => n + m.browserVisits!.length, 0), 142);
    for (const m of browserMaterials) await run(browserJob, "read", [...own(bb), "--id", m.id]);
    await run(browserJob, "read", [...own(bb), "--id", pages[0]!.id, "--verify-source"]);
    const merged = await load(bb.template);
    const agent = browserMaterials.find(m => m.ref.channel === "local-agent")!;
    const prior = Object.values(migrated.identities).find((v) => (v as {date:string}).date === day) as {eventKey:string};
    merged.days[0].items = [{ title: "工作讨论", statement: "讨论每日记录", status: "discussed", project: agent.project, sourceIds: [agent.id], eventKey: prior.eventKey },
      { title: "浏览概览：开发资料", statement: "浏览开发资料，集中查看接口与使用说明。", status: "documented", project: null, sourceIds: pages.map(m=>m.id) }];
    const candidate = join(bb.batch, "merged.json"); await save(candidate, merged);
    await run(browserJob, "validate", [...own(bb), "--facts", candidate]);
    const browserExport = await load(join(bb.batch, "export.json"));
    assert.equal(browserExport.days[0].facts[1].sourceRefs.length, 1);
    assert.equal(browserExport.days[0].facts.length, 2);
    const index = await load(join(bb.batch, "browser-evidence-index.json"));
    assert.equal((Object.values(index)[0] as {visits:unknown[]}).visits.length, 142);
    // Rejections operate on real collected evidence, not mirrored pure functions.
    const invalid = structuredClone(merged);
    invalid.days[0].items[1].status = "verified"; await save(candidate, invalid);
    assert.match((await run(browserJob, "validate", [...own(bb), "--facts", candidate], false)).error, /BROWSER_ONLY_IS_OBSERVATION/);
    invalid.days[0].items[1].status = "documented";
    invalid.days[0].items[1].statement = "字".repeat(161); await save(candidate, invalid);
    assert.match((await run(browserJob, "validate", [...own(bb), "--facts", candidate], false)).error, /BROWSER_THEME_TOO_VERBOSE/);
    invalid.days[0].items[1].statement = "浏览开发资料";
    invalid.days[0].items.push(structuredClone(invalid.days[0].items[1])); await save(candidate, invalid);
    assert.match((await run(browserJob, "validate", [...own(bb), "--facts", candidate], false)).error, /BROWSER_EVIDENCE_REPEATED/);
    const tooManyThemes = structuredClone(merged);
    tooManyThemes.days[0].items = [merged.days[0].items[0], ...pages.slice(0, 4).map(m => ({title:"浏览概览：资料",statement:"浏览资料",status:"documented",project:null,sourceIds:[m.id]}))];
    await save(candidate, tooManyThemes);
    assert.match((await run(browserJob, "validate", [...own(bb), "--facts", candidate], false)).error, /TOO_MANY_BROWSER_THEMES/);
    await save(candidate, merged); await run(browserJob, "validate", [...own(bb), "--facts", candidate]);
    dropResponse = true;
    await run(browserJob, "publish", own(bb));
    const browserFact = (await records.list(ownerId, {from:day,to:day})).items.find(v=>v.title==="浏览概览：开发资料")!;
    assert(browserFact && browserFact.status === "documented");
    // Recollect with a changed title and wording; stable anchors retain the same fact.
    const reopen = await load(join(browserJob.c.stateDir, "state.json")); reopen.days[day].complete = false;
    await save(join(browserJob.c.stateDir, "state.json"), reopen);
    const replay = await prepare(browserJob);
    const replayCandidate = await load(replay.template);
    replayCandidate.days[0].items = structuredClone(merged.days[0].items);
    replayCandidate.days[0].items[1].statement = "集中浏览接口和开发使用说明。";
    const replayMaterials = await load(join(replay.batch, "evidence.json"));
    for (const m of replayMaterials) await run(browserJob, "read", [...own(replay), "--id", m.id]);
    const replayPath = join(replay.batch, "facts.json"); await save(replayPath, replayCandidate);
    await run(browserJob, "validate", [...own(replay), "--facts", replayPath]);
    await run(browserJob, "publish", own(replay));
    const replayFact = (await records.list(ownerId, {from:day,to:day})).items.find(v=>v.title==="浏览概览：开发资料")!;
    assert.equal(replayFact.id, browserFact.id);
    assert.equal((await load(join(browserJob.c.stateDir, "state.json"))).days[day].complete, true);
    console.log("PASS Mac browser effective-date migration, 142 visits merged into one theme/reference, concise-output guards, real source verification, HTTP import/recovery and stable replay");
  }

  }
  if (process.platform === "darwin") {
    const screen = await fixture("screen");
    let batch = await prepare(screen);
    let candidate = await factFile(screen,batch);
    await run(screen,"validate",[...own(batch),"--facts",candidate]);
    await run(screen,"publish",own(batch));
    const before = await load(join(screen.c.stateDir,"state.json"));
    const identity = Object.values(before.identities)[0] as {eventKey:string};
    const deviceID = randomUUID(), cardID = randomUUID(), matterID = randomUUID();
    const scope = `screen:screen:${deviceID}:observed`;
    const exporter = join(screen.dir,"exporter.py"), snapshotFile = join(screen.dir,"snapshot.json");
    const at = Date.parse(day+"T12:00:00+08:00");
    const snapshot = {schemaVersion:1,deviceID,day,timeZone:"Asia/Shanghai",snapshotID:deviceID+":"+day+":1",revision:1,generatedAt:Date.now(),sourceReadAt:Date.now(),coverage:"complete",missingIntervals:[],cards:[{cardID,matterID,revision:1,title:"工作讨论",summary:"查看隔离讨论材料",detail:"非个人屏幕样本",actor:"person",state:"documented",spans:[{startMs:at,endMs:at,actor:"person"}],evidenceIDs:["capture"],updatedAt:Date.now()}],evidence:[{id:"capture",source:"screen",captureID:"capture",occurredAtMs:at}],summary:"仅已记录范围",contentHash:""};
    await save(snapshotFile,snapshot);
    await writeFile(exporter,`#!/usr/bin/env python3
import sys,json,pathlib,hashlib,os
root=pathlib.Path(__file__).parent
v=json.loads((root/'snapshot.json').read_text())
v['contentHash']=hashlib.sha256(json.dumps(dict(v,contentHash=''),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
raw=json.dumps(v,ensure_ascii=False).encode()
if '--out' in sys.argv:
 out=pathlib.Path(sys.argv[sys.argv.index('--out')+1]);out.mkdir(mode=0o700)
 (out/'export.json').write_bytes(raw);os.chmod(out/'export.json',0o600)
 (out/'manifest.json').write_text(json.dumps({'sha256':hashlib.sha256(raw).hexdigest(),'revision':v['revision'],'snapshotID':v['snapshotID']}));os.chmod(out/'manifest.json',0o600)
print(json.dumps(v))
`,{mode:0o700});
    const next = structuredClone(screen.c) as typeof screen.c & {sources:{screen:unknown}};
    next.sources.screen = {enabled:true,effectiveFrom:day,expectedDeviceID:deviceID,exporterArgv:[exporter,"screen-recording","analysis","export","--instance","stable"]};
    const nextFile = join(screen.dir,"next.json");await save(nextFile,next);
    await run(screen,"migrate-sources",["--next-config",nextFile,"--dry-run"]);
    await run(screen,"migrate-sources",["--next-config",nextFile]);
    await registerSource(pool!,ownerId,{sourceScope:scope,producerId:"screen",sourceNamespace:screen.c.sourceNamespace,name:"屏幕事项隔离样本",effectiveFrom:day,effectiveTo:null});
    batch = await prepare(screen);
    const materials = await load(join(batch.batch,"evidence.json"));
    assert(materials.some((m:{ref:{channel:string}})=>m.ref.channel==="screen-timeline"));
    for(const m of materials)await run(screen,"read",[...own(batch),"--id",m.id]);
    const facts = await load(batch.template);
    facts.days[0].items = [{eventKey:identity.eventKey,title:"工作讨论",statement:"讨论每日记录并查看材料",status:"documented",project:null,sourceIds:materials.map((m:{id:string})=>m.id)}];
    candidate = join(batch.batch,"merged-screen.json");await save(candidate,facts);
    await run(screen,"validate",[...own(batch),"--facts",candidate]);
    dropResponse = true;await run(screen,"publish",own(batch));
    const after = await load(join(screen.c.stateDir,"state.json"));
    assert.equal(after.days[day].screenRevision,1);
    assert.equal(Object.keys(after.identities).length,Object.keys(before.identities).length);
    assert.equal((await prepare(screen)).complete,true);
    snapshot.revision=2;snapshot.snapshotID=deviceID+":"+day+":2";snapshot.cards[0]!.revision=2;await save(snapshotFile,snapshot);
    const replay = await prepare(screen);assert(replay.batch);
    const newMaterials = await load(join(replay.batch,"evidence.json"));
    for(const m of newMaterials)await run(screen,"read",[...own(replay),"--id",m.id]);
    const revised = await load(replay.template);revised.days[0].items=structuredClone(facts.days[0].items);revised.days[0].items[0].sourceIds=newMaterials.map((m:{id:string})=>m.id);
    const revisedFile=join(replay.batch,"revised-screen.json");await save(revisedFile,revised);
    await run(screen,"validate",[...own(replay),"--facts",revisedFile]);await run(screen,"publish",own(replay));
    assert.equal((await load(join(screen.c.stateDir,"state.json"))).days[day].screenRevision,2);
    assert.equal((await prepare(screen)).complete,true);
    console.log("PASS screen source additive migration, merged stable identity, frozen hash, HTTP response loss recovery, revision backfill and independent readback (isolated service only)");
  }

  const old = new RecordService(pool);const baseline=await old.create(context(ownerId),{kind:"task",body:"unrelated baseline"});
  assert.equal((await old.get(ownerId,baseline.record.id)).body,"unrelated baseline");
  console.log("PASS ordinary record compatibility");
  console.log(JSON.stringify({ result:"pass", artifacts:root, database:"disposable database removed in finally" }));
} finally {
  await new Promise<void>(r => proxy ? proxy.close(()=>r()) : r());
  await new Promise<void>(r => server ? server.close(()=>r()) : r());
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
  // Protected artifacts are retained for diagnosis; no raw user data was read.
  await rm(join(root,"token.env"),{force:true});
}
