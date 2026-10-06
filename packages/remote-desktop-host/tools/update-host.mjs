// Single Release installation; build failures never touch the deployed bundle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(packagePath, '../..');
const appPath = '/Applications/RemoteDesk.app';
const statePath = path.join(os.homedir(), '.runweave/remote-host');
const lockPath = path.join(statePath, 'update.lock');
const options = {};
const usage = 'Usage: pnpm host:update [--team TEAM_ID] [--interface INTERFACE] [--configuration Release]';
if (process.argv.slice(2).length === 1 && ['--help', '-h'].includes(process.argv[2])) {
  console.log(`${usage}\nUpdates the current checkout to /Applications/RemoteDesk.app.\nExisting installation: reuse its signing team and last successful interface.\nFirst installation: specify --team and --interface. Does not update the iPhone app.`);
  process.exit(0);
}
let evidencePath;
let lockOwned = false;
let stagePath;
let backupPath;
let previousPath;
let previousRunning = false;
let stopped = false;
let displaced = false;
let installed = false;
let helperPath;
const result = { schemaVersion: 1, state: 'failed', update: 'not_started', rollback: 'not_needed',
  appPath, remoteSessionVerified: false };

function run(command, args, logName) {
  const log = logName ? fs.openSync(path.join(evidencePath, logName), 'a') : undefined;
  try {
    const child = spawnSync(command, args, {
      cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      stdio: log !== undefined ? ['ignore', log, log] : ['ignore', 'pipe', 'pipe'],
    });
    if (child.error || child.status !== 0) {
      throw new Error(`${path.basename(command)} failed (${child.status ?? child.error?.message}). ${logName
        ? `See ${path.join(evidencePath, logName)}` : (child.stderr || child.stdout || '').trim()}`);
    }
    return `${child.stdout || ''}${child.stderr || ''}`;
  } finally { if (log !== undefined) fs.closeSync(log); }
}
function lifecycle(args, name) {
  const child = spawnSync(helperPath, args, { encoding: 'utf8', timeout: 65000 });
  try { fs.writeFileSync(path.join(evidencePath, name), child.stdout || child.stderr || String(child.error)); }
  catch (error) {
    result.evidenceError = error.message;
    console.error(`Cannot save ${name}: ${error.message}`);
  }
  let receipt;
  try { receipt = JSON.parse(child.stdout); } catch { /* Report the original lifecycle failure below. */ }
  if (child.error || child.status !== 0) throw new Error(receipt?.message || child.error?.message || `${name} failed`);
  return receipt;
}
function inspect() { return lifecycle(['--inspect'], 'running.json').applications; }
function verify(bundlePath) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundlePath]);
  const signature = run('/usr/bin/codesign', ['-dv', '--verbose=4', bundlePath]);
  if (!signature.includes('\nIdentifier=com.runweave.remote-host\n') ||
      !signature.includes(`\nTeamIdentifier=${options.team}\n`)) {
    throw new Error(`Unexpected Host identity or signing team: ${bundlePath}`);
  }
  return signature.match(/^CDHash=(.+)$/m)?.[1];
}
function start(bundlePath, name, networkInterface) {
  return lifecycle([bundlePath, evidencePath, ...(networkInterface ? [networkInterface] : [])], name);
}
function stop(bundlePath, name) { return lifecycle(['--stop', bundlePath, evidencePath], name); }
function saveResult() {
  if (!evidencePath) return;
  try { fs.writeFileSync(path.join(evidencePath, 'result.json'), `${JSON.stringify(result, null, 2)}\n`); }
  catch (error) {
    // Evidence I/O must not prevent a needed rollback or releasing our lock.
    result.evidenceError = error.message;
    console.error(`Cannot save update receipt: ${error.message}`);
  }
}

try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--team', '--interface', '--configuration'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error(usage);
    }
    options[args[i].slice(2)] = args[i + 1];
  }
  if (options.configuration && options.configuration !== 'Release') {
    throw new Error('The installed Host uses Release. Use build-host.sh for Debug builds.');
  }
  if (!options.team && fs.existsSync(appPath)) {
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    const installedSignature = run('/usr/bin/codesign', ['-dv', '--verbose=4', appPath]);
    options.team = installedSignature.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1];
  }
  if (!options.team || !/^[A-Z0-9]+$/.test(options.team)) {
    throw new Error('Cannot resolve a signing team from the installed Host. Specify --team TEAM_ID; first installation also needs --interface INTERFACE.');
  }
  result.signingTeam = options.team;
  fs.mkdirSync(path.join(statePath, 'updates'), { recursive: true });
  // Shared by all checkouts. Never remove another update's lock, including a stale one.
  try { fs.mkdirSync(lockPath); lockOwned = true; }
  catch { throw new Error(`Another update owns ${lockPath}. Inspect owner.json before recovering an abandoned lock.`); }
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, repository, startedAt: new Date().toISOString() }));
  evidencePath = fs.mkdtempSync(path.join(statePath, 'updates/update-'));
  result.evidencePath = evidencePath;
  console.error(`Host update evidence: ${evidencePath}`);
  helperPath = path.join(evidencePath, 'start-host');
  run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', path.join(packagePath, 'tools/start-host.swift'), '-o', helperPath], 'helper-build.log');
  const running = inspect();
  if (running.length > 1) throw new Error('Multiple Host processes are running; no process was stopped.');
  const legacyPath = path.join(repository, '.runweave/remote-desktop-implementation/HostDerivedData/Build/Products/Release/RemoteDesk.app');
  const allowed = [appPath, legacyPath, '/Applications/Runweave Remote Host.app'];
  if (running.some(app => !allowed.includes(app.appPath))) {
    throw new Error(`An unmanaged Host is running at ${running[0].appPath}; left unchanged.`);
  }
  if (fs.existsSync(appPath)) {
    if (fs.lstatSync(appPath).isSymbolicLink()) throw new Error('Installed Host must not be a symlink.');
    verify(appPath);
  }
  previousPath = running[0]?.appPath || (fs.existsSync(appPath) ? appPath : undefined);
  previousRunning = running.length === 1;
  if (previousPath) verify(previousPath);
  if (previousRunning && previousPath !== appPath && fs.existsSync(appPath)) {
    throw new Error('Both a legacy running Host and an installed Host exist; no migration was attempted.');
  }
  result.previous = { appPath: previousPath ?? null, pid: running[0]?.pid ?? null };
  // Reserve the destination before building; staging and rename stay on the same volume.
  stagePath = fs.mkdtempSync('/Applications/.RemoteDesk-update-');
  backupPath = path.join(stagePath, 'RemoteDesk-before.app');
  result.backupPath = previousPath ? backupPath : null;
  result.source = { repository, revision: run('git', ['rev-parse', 'HEAD']).trim(),
    dirty: run('git', ['status', '--porcelain']).trim().length > 0 };
  const derivedData = path.join(evidencePath, 'DerivedData');
  result.update = 'building';
  saveResult();
  run(path.join(packagePath, 'build-host.sh'), ['--configuration', 'Release', '--team', options.team,
    '--derived-data-path', derivedData], 'build.log');
  const candidate = path.join(stagePath, 'RemoteDesk.app');
  run('/usr/bin/ditto', [path.join(derivedData, 'Build/Products/Release/RemoteDesk.app'), candidate]);
  result.codeHash = verify(candidate);
  if (previousPath && previousPath !== appPath) {
    run('/usr/bin/ditto', [previousPath, backupPath]);
    verify(backupPath);
  }
  // A build may take minutes: recheck process ownership before changing the installation.
  if (JSON.stringify(inspect()) !== JSON.stringify(running)) throw new Error('Host process changed during build; deployment cancelled.');
  if (previousRunning) { stop(previousPath, 'stop-previous.json'); stopped = true; }
  result.update = 'installing';
  saveResult();
  if (fs.existsSync(appPath)) { fs.renameSync(appPath, backupPath); displaced = true; }
  fs.renameSync(candidate, appPath);
  installed = true;
  result.update = 'starting';
  saveResult();
  result.startup = start(appPath, 'startup.json', options.interface);
  result.state = 'ready';
  result.update = 'succeeded';
  // Keep the public receipt fields available to existing callers.
  Object.assign(result, result.startup, { update: 'succeeded', rollback: 'not_needed' });
} catch (error) {
  result.message = error.message;
  result.failedPhase = result.update;
  result.update = 'failed';
  if (stopped || displaced || installed) {
    result.rollback = 'in_progress';
    saveResult();
    try {
      if (installed) {
        stop(appPath, 'stop-candidate.json');
        result.failedAppPath = path.join(stagePath, 'RemoteDesk-failed.app');
        fs.renameSync(appPath, result.failedAppPath);
        installed = false;
      }
      if (displaced) {
        fs.renameSync(backupPath, appPath); displaced = false;
        result.backupPath = null;
        result.restoredAppPath = appPath;
      }
      if (previousRunning) {
        // Reuse the last successful interface, never the failed update's requested one.
        result.rollbackStartup = start(previousPath, 'rollback-startup.json');
        result.rollback = 'service_restored';
      } else {
        result.rollback = previousPath ? 'app_restored' : 'installation_removed';
      }
    } catch (rollbackError) {
      result.rollback = 'failed';
      result.rollbackMessage = rollbackError.message;
    }
  }
  process.exitCode = 1;
} finally {
  saveResult();
  if (lockOwned) fs.rmSync(lockPath, { recursive: true });
  // Backups and failed candidates are retained for diagnosis and manual recovery.
  console.log(JSON.stringify(result, null, 2));
}
