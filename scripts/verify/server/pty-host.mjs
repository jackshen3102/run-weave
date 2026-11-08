// Real Host/native PTY integration. No user configuration or running terminal is touched.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { copyNativeLockRuntime } from '../../../packages/config-node/scripts/native-runtime.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'packages/runweave-cli/package.json'));
const { build } = require('esbuild');
const fixture = mkdtempSync(path.join(os.tmpdir(), 'rw host 中文-'));
const release = path.join(fixture, 'release');
const scope = { kind: 'stable', instanceId: 'stable', configRoot: path.join(fixture, 'data') };
mkdirSync(scope.configRoot, { mode: 0o700 });
if (process.platform === 'win32') {
  const script = '$p=$env:RW_HOST_FIXTURE; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $p /inheritance:r /grant:r "*${sid}:(OI)(CI)F" | Out-Null; if ($LASTEXITCODE) { exit $LASTEXITCODE }';
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, RW_HOST_FIXTURE: fixture } });
}
const options = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['node-pty', 'fs-native-extensions'],
  define: { 'import.meta.url': '__IMPORT_META_URL__' }, banner: { js: "const __IMPORT_META_URL__ = require('url').pathToFileURL(__filename).href;" } };
await build({ ...options, entryPoints: [path.join(repo, 'packages/pty-host/src/index.ts')], outfile: path.join(release, 'pty-host/index.cjs') });
await build({ ...options, stdin: { contents: 'export * from "./packages/pty-host/src/client"; export * from "./packages/pty-host/src/lifecycle";', resolveDir: repo }, outfile: path.join(fixture, 'client.cjs') });
copyNativeLockRuntime(fixture);
copyNativeLockRuntime(path.join(release, 'pty-host'));
cpSync(path.join(repo, 'backend/node_modules/node-pty'), path.join(release, 'pty-host/node_modules/node-pty'), { recursive: true, dereference: true, filter: () => true });
const { PtyHostClient, ensureHost, readHost } = require(path.join(fixture, 'client.cjs'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let client, observer, second;
const delivered = new Set();
const upstream = createServer((req, res) => {
  let source = ''; req.on('data', data => { source += data; }); req.on('end', () => {
    if (req.url === '/events') delivered.add(JSON.parse(source).dedupeKey);
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${upstream.address().port}`;
try {
  await ensureHost(scope, release);
  client = await PtyHostClient.connect(scope, randomUUID());
  observer = await PtyHostClient.connect(scope);
  const host = client.descriptor;
  const id = randomUUID(), sessionInstanceId = randomUUID();
  const counter = path.join(fixture, 'counter.cjs');
  writeFileSync(counter, 'console.log("CHILD_PID="+process.pid);let tick=0;setInterval(()=>console.log("TICK="+(++tick)),100);');
  const command = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  const counterCommand = `& '${process.execPath.replaceAll("'", "''")}' '${counter.replaceAll("'", "''")}'`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('RUNWEAVE_') && !['PSModulePath', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)));
  const info = await client.request('createSession', { generation: client.generation, sessionInstanceId, terminalSessionId: id, projectId: 'fixture',
    command, args: process.platform === 'win32' ? ['-NoProfile', '-NoExit', '-Command', counterCommand] : ['-c', `exec '${process.execPath}' '${counter}'`],
    cwd: fixture, cols: 100, rows: 30, env });
  assert(info.pid > 1);
  const target = { hostInstanceId: host.hostInstanceId, sessionInstanceId, terminalSessionId: id, generation: client.generation };
  let output = '';
  observer.events.add(event => { if (event.type === 'output') output += event.data; });
  const attached = await observer.request('attachSession', target);
  output += attached.snapshot.data + attached.frames.map(frame => frame.data).join('');
  async function wait(predicate, label) { const deadline = Date.now() + 15000; while (!predicate()) { assert(Date.now() < deadline, `${label}: ${output.slice(-500)}`); await sleep(50); } }
  await wait(() => /TICK=3/.test(output), 'counter ready');
  const beforeTick = Math.max(...[...output.matchAll(/TICK=(\d+)/g)].map(match => +match[1]));
  const counterPid = output.match(/CHILD_PID=(\d+)/)?.[1];
  assert(counterPid, 'child identity missing');
  // Host input queue continues after the accepting client disappears mid-delay.
  const operationId = randomUUID();
  await client.request('writeInput', { ...target, wait: false, input: { operationId, sequence: 1,
    steps: [{ type: 'text', data: 'x' }, { type: 'delay', ms: 500 }, { type: 'text', data: '\r' }] } });
  client.close();
  await sleep(700);
  const operation = await observer.request('getInputOperation', { ...target, operationId });
  assert.equal(operation.state, 'written');
  await wait(() => Math.max(...[...output.matchAll(/TICK=(\d+)/g)].map(match => +match[1])) > beforeTick + 4, 'counter survives client exit');
  second = await PtyHostClient.connect(scope, randomUUID());
  const nextTarget = { ...target, generation: second.generation };
  const after = (await second.request('listSessions'))[0];
  assert.equal(after.pid, info.pid); assert.equal(after.sessionInstanceId, sessionInstanceId);
  assert.equal(second.descriptor.pid, host.pid); assert.equal(second.descriptor.hostInstanceId, host.hostInstanceId);
  await assert.rejects(observer.request('writeInput', { ...target, input: { operationId: randomUUID(), sequence: 2, steps: [] } }), /HOST_WRITER_STALE/);
  const resumed = await second.request('attachSession', nextTarget);
  assert.equal(resumed.snapshot.cursor.streamId, attached.snapshot.cursor.streamId);
  await second.request('freeze', { frozen: true });
  await assert.rejects(second.request('createSession', { generation: second.generation, sessionInstanceId: randomUUID(), terminalSessionId: randomUUID(), projectId: 'fixture', command, args: [], cwd: fixture, cols: 80, rows: 24, env }), /HOST_BUSY/);
  await second.request('freeze', { frozen: false });
  await assert.rejects(second.request('stop', { terminateSessions: false }), /HOST_SESSIONS_ACTIVE/);
  const event = { type: 'agent.hook', dedupeKey: randomUUID(), scope: { terminalSessionId: id, projectId: 'fixture' }, data: {} };
  const response = await fetch(`${host.gatewayUrl}app-server/events`, { method: 'POST', headers: { authorization: `Bearer ${info.gatewayToken}`, 'content-type': 'application/json' }, body: JSON.stringify(event) });
  assert.equal(response.status, 202);
  assert.equal(delivered.size, 0, 'offline gateway did not retain event');
  await second.request('setUpstreams', { backendUrl: url, backendToken: 'fixture', appServerUrl: url, appServerToken: 'fixture' });
  await wait(() => delivered.has(event.dedupeKey), 'outbox drained');
  await second.request('closeSession', nextTarget);
  await wait(async () => true, 'close');
  await sleep(400);
  assert.equal((await second.request('listSessions'))[0].status, 'exited');
  console.log(JSON.stringify({ platform: process.platform, hostPid: host.pid, shellPid: info.pid, counterPid, hostIdentityPreserved: true,
    inputSurvivedDisconnect: true, writerFencing: true, outputStreamPreserved: true, eventOutboxDrained: true, explicitClose: true }));
} finally {
  client?.close(); second?.close();
  try { observer ??= await PtyHostClient.connect(scope); await observer.request('stop', { terminateSessions: true }); } catch { /* Fixture only. */ }
  observer?.close();
  await new Promise(resolve => upstream.close(resolve));
  for (let i = 0; i < 50; i++) { try { readHost(scope); await sleep(100); } catch { break; } }
  try { rmSync(fixture, { recursive: true, force: true }); } catch { console.error(`Fixture cleanup pending: ${fixture}`); }
}
