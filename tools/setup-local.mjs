import path from 'node:path';
import { access, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { project, privateDirectory, readPrivate, savePrivate } from '../lib/config.mjs';
const exec = promisify(execFile);
if (process.platform !== 'win32')
  throw new Error('This helper configures only the private local Windows database.');
const bin = path.join(privateDirectory, 'postgresql/pgsql/bin'),
  data = path.join(privateDirectory, 'pgdata');
await access(path.join(bin, 'initdb.exe'));
await mkdir(privateDirectory, { recursive: true });
let secrets;
try {
  secrets = await readPrivate('database-admin');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = {
    bootstrapPassword: randomBytes(24).toString('hex'),
    appPassword: randomBytes(24).toString('hex'),
  };
  await savePrivate('database-admin', secrets);
}
let initialized = true;
try {
  await access(path.join(data, 'PG_VERSION'));
} catch {
  initialized = false;
}
if (!initialized) {
  const passwordFile = path.join(privateDirectory, 'init-password.tmp');
  try {
    await writeFile(passwordFile, secrets.bootstrapPassword, { mode: 0o600 });
    await exec(
      path.join(bin, 'initdb.exe'),
      [
        '-D',
        data,
        '-U',
        'saas_bootstrap',
        '-A',
        'scram-sha-256',
        '--pwfile',
        passwordFile,
        '--encoding=UTF8',
        '--locale=C',
      ],
      { windowsHide: true, timeout: 60000 },
    );
  } finally {
    await unlink(passwordFile).catch(() => {});
  }
}
let running = true;
try {
  await exec(path.join(bin, 'pg_ctl.exe'), ['-D', data, 'status'], { windowsHide: true });
} catch {
  running = false;
}
if (!running)
  await exec(
    path.join(bin, 'pg_ctl.exe'),
    [
      '-D',
      data,
      '-l',
      path.join(privateDirectory, 'postgres.log'),
      '-o',
      '-h 127.0.0.1 -p 55432 -c shared_buffers=64MB -c max_connections=40 -c log_parameter_max_length_on_error=0',
      '-w',
      'start',
    ],
    { windowsHide: true, timeout: 60000 },
  );
const admin = new pg.Client({
  host: '127.0.0.1',
  port: 55432,
  user: 'saas_bootstrap',
  password: secrets.bootstrapPassword,
  database: 'postgres',
});
await admin.connect();
try {
  if (!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname='cam_app'")).rowCount) {
    if (!/^[a-f0-9]{48}$/.test(secrets.appPassword))
      throw new Error('Invalid generated credential.');
    await admin.query(
      `CREATE ROLE cam_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${secrets.appPassword}'`,
    );
  }
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname='cam_saas'")).rowCount)
    await admin.query('CREATE DATABASE cam_saas');
} finally {
  await admin.end();
}
const migrate = new pg.Client({
  host: '127.0.0.1',
  port: 55432,
  user: 'saas_bootstrap',
  password: secrets.bootstrapPassword,
  database: 'cam_saas',
});
await migrate.connect();
try {
  await migrate.query('BEGIN');
  await migrate.query(await readFile(path.join(project, 'db/schema.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/google-auth.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/grants.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/fleet.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye-admin.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye-live.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye-10s.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye-segments.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye-5s-test.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye-segment-fields.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/wheelseye-retention.sql'), 'utf8'));
  await migrate.query(await readFile(path.join(project, 'db/workspace.sql'), 'utf8'));
  await migrate.query('COMMIT');
} catch (error) {
  await migrate.query('ROLLBACK');
  throw error;
} finally {
  await migrate.end();
}
await savePrivate('runtime', {
  databaseUrl: `postgresql://cam_app:${secrets.appPassword}@127.0.0.1:55432/cam_saas`,
  dataDirectory: path.join(project, 'data'),
  port: 8101,
});
console.log(
  'Local PostgreSQL ready at 127.0.0.1:55432. Runtime credentials protected by Windows DPAPI.',
);
