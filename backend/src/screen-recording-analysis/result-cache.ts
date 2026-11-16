import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisManifest, AnalysisResult } from '@runweave/shared/screen-recording';
import type { AnalysisProviderConfig } from './provider';
import { validateResult } from './validator';

// Bump when provider instructions, image selection or result semantics change.
const version = 'screen-result-v1-ax-delta';
const maximumBytes = 2 * 1024 * 1024;
const lifetime = 3 * 86400000;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

/** Disposable successful results only; the source owner still validates every commit. */
export class AnalysisResultCache {
  private constructor(private readonly directory: string, private readonly key: string, private readonly manifest: AnalysisManifest) {}
  static async prepare(root: string, config: AnalysisProviderConfig, manifest: AnalysisManifest): Promise<AnalysisResultCache | undefined> {
    try {
      const candidates = path.isAbsolute(config.binary) || config.binary.includes(path.sep) ? [path.resolve(config.binary)] :
        (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir,config.binary));
      let binary = '';
      for (const candidate of candidates) {
        try { if ((await stat(candidate)).isFile()) { binary = await realpath(candidate); break; } } catch { /* next PATH entry */ }
      }
      if (!binary) return undefined;
      const identity = await stat(binary,{ bigint: true });
      const key = digest(canonical({ version,manifest,model: config.model,effort: config.effort,
        binary,identity: `${identity.dev}:${identity.ino}:${identity.size}:${identity.mtimeNs}:${identity.ctimeNs}` }));
      const directory = path.join(root,'results');
      for (let current = directory; current !== path.dirname(current); current = path.dirname(current)) {
        if ((await lstat(current).catch(() => undefined))?.isSymbolicLink()) return undefined;
      }
      await mkdir(directory,{ recursive: true,mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) return undefined;
      return new AnalysisResultCache(directory,key,manifest);
    } catch { return undefined; }
  }
  async read(): Promise<AnalysisResult | undefined> {
    const file = path.join(this.directory,this.key + '.json');
    try {
      const handle = await open(file,constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > maximumBytes || (info.mode & 0o077)) return undefined;
        const value = JSON.parse(await handle.readFile('utf8')) as { key: string; expires: number; resultHash: string; result: unknown };
        if (value.key !== this.key || !Number.isFinite(value.expires) || value.expires <= Date.now() || value.resultHash !== digest(canonical(value.result))) return undefined;
        return validateResult(value.result,this.manifest);
      } finally { await handle.close(); }
    } catch { return undefined; }
  }
  async write(result: AnalysisResult): Promise<void> {
    const file = path.join(this.directory,this.key + '.json'), temporary = file + '.pending-' + randomUUID();
    try {
      const expires = Math.min(Date.now()+lifetime,...this.manifest.captures.map(frame => frame.availableUntilMs));
      if (expires <= Date.now()) return;
      const json = JSON.stringify({ key: this.key,expires,resultHash: digest(canonical(result)),result });
      if (Buffer.byteLength(json) > maximumBytes) return;
      const handle = await open(temporary,'wx',0o600);
      try { await handle.writeFile(json); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary,file);
      // Bound retained private results even when the source queue never retries.
      const entries: { file: string; modified: number; bytes: number }[] = [];
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const item = path.join(this.directory,name), info = await lstat(item);
        if (info.isFile() && !info.isSymbolicLink()) entries.push({ file: item,modified: info.mtimeMs,bytes: info.size });
      }
      entries.sort((a,b) => b.modified-a.modified);
      let bytes = 0;
      for (const [index,entry] of entries.entries()) {
        bytes += entry.bytes;
        if (index >= 100 || bytes > 32*1024*1024 || Date.now()-entry.modified > lifetime) await rm(entry.file,{ force: true });
      }
    } catch { /* Cache availability never changes source/model/commit success. */ }
    finally { await rm(temporary,{ force: true }).catch(() => {}); }
  }
}
