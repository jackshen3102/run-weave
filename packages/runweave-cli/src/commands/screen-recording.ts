import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AnalysisExport } from '@runweave/shared/screen-recording';
import { parseArgs, getStringOption, requireStringOption } from '../args.js';
import { resolveAuthContext } from '../client/auth-context.js';
import { CliError } from '../errors.js';

export async function runScreenRecordingCommand(subcommand: string | undefined, args: string[], io: { stdout: Pick<NodeJS.WriteStream,'write'>; env: NodeJS.ProcessEnv }): Promise<void> {
  const parsed = parseArgs(args,new Set(['json']));
  if (subcommand !== 'analysis' || parsed.positionals.length !== 1 || parsed.positionals[0] !== 'export') throw new CliError('Usage: rw screen-recording analysis export --instance stable --day YYYY-MM-DD [--out NEW_DIRECTORY] --json',2);
  const day = requireStringOption(parsed.options,'day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day) throw new CliError('Invalid day',2);
  if (!getStringOption(parsed.options,'instance')) throw new CliError('Explicit --instance required',2);
  const auth = await resolveAuthContext({ env: io.env });
  const value = await auth.requestJson<AnalysisExport>(`/api/screen-recording/analysis/export?day=${day}`);
  if (value.schemaVersion !== 1 || value.day !== day || value.timeZone !== 'Asia/Shanghai' || value.nextCursor || !Number.isSafeInteger(value.revision) || !value.deviceID || !Array.isArray(value.cards)) throw new CliError('Invalid or incomplete screen timeline export',1);
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => [key,canonical(item)])) : input;
  const hash = createHash('sha256').update(JSON.stringify(canonical({ ...value,contentHash: '' }))).digest('hex');
  if (hash !== value.contentHash) throw new CliError('Screen export content hash mismatch',1);
  const output = getStringOption(parsed.options,'out');
  if (output) {
    if (!path.isAbsolute(output)) throw new CliError('--out must be an absolute new directory',2);
    let parent = path.dirname(output);
    while (parent !== path.dirname(parent)) {
      const info = await lstat(parent);
      if (info.isSymbolicLink()) throw new CliError('Symlink output parent rejected',2);
      parent = path.dirname(parent);
    }
    await mkdir(output,{ mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify(value));
    await writeFile(path.join(output,'export.json'),bytes,{ mode: 0o600,flag: 'wx' });
    await writeFile(path.join(output,'manifest.json'),JSON.stringify({ schemaVersion: 1,deviceID: value.deviceID,day,revision: value.revision,snapshotID: value.snapshotID,sha256: createHash('sha256').update(bytes).digest('hex') }),{ mode: 0o600,flag: 'wx' });
    io.stdout.write(JSON.stringify({ output,revision: value.revision,coverage: value.coverage })+'\n');
  } else io.stdout.write(JSON.stringify(value)+'\n');
}
