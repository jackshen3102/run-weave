import { readdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function markJobOwner(directory: string, pid: number): Promise<void> {
  await writeFile(path.join(directory,'owner.json'),JSON.stringify({ version: 1,pid }),{ mode: 0o600 });
}
/** Remove only private jobs with a positively dead recorded owner. The provider
 * watchdog records itself before receiving images and cleans on parent loss. */
export async function cleanAbandonedJobs(root: string): Promise<void> {
  const entries = await readdir(root,{ withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^job-[0-9a-f-]{36}-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const directory = path.join(root,entry.name), owner = path.join(directory,'owner.json');
    try {
      const info = await lstat(owner);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) continue;
      const value = JSON.parse(await readFile(owner,'utf8')) as { version: number; pid: number };
      if (value.version !== 1 || !Number.isInteger(value.pid) || value.pid <= 1) continue;
      try { process.kill(value.pid,0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
      await rm(directory,{ recursive: true,force: true });
    } catch { /* A partial marker cannot authorize deleting another worker's data. */ }
  }
}
