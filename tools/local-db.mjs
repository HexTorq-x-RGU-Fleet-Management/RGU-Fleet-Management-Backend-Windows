import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateDirectory } from '../lib/config.mjs';
const action = process.argv[2];
if (process.platform !== 'win32' || !['status', 'stop'].includes(action))
  throw Error('Use db:status or db:stop on Windows.');
const args = ['-D', path.join(privateDirectory, 'pgdata')];
if (action === 'stop') args.push('-m', 'fast', '-w');
args.push(action);
try {
  const result = await promisify(execFile)(
    path.join(privateDirectory, 'postgresql/pgsql/bin/pg_ctl.exe'),
    args,
    { windowsHide: true, timeout: 60000 },
  );
  process.stdout.write(result.stdout);
} catch {
  console.error('The private local PostgreSQL instance is not available.');
  process.exitCode = 1;
}
