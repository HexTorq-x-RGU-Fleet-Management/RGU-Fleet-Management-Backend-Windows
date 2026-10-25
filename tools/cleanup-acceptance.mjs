// Cleanup for a force-stopped acceptance process; cannot target application databases.
import pg from 'pg';
import { readPrivate } from '../lib/config.mjs';
const pid = process.argv[2];
if (!/^[1-9]\d{1,9}$/.test(pid || '')) throw Error('Supply the stopped acceptance process ID.');
const secret = await readPrivate('database-admin');
const client = new pg.Client({
  host: '127.0.0.1',
  port: 55432,
  user: 'saas_bootstrap',
  password: secret.bootstrapPassword,
  database: 'postgres',
});
await client.connect();
try {
  const rows = (
    await client.query('SELECT datname FROM pg_database WHERE datname ~ $1', [
      '^cam_test_' + pid + '_[a-f0-9]{8}$',
    ])
  ).rows;
  for (const { datname } of rows) {
    if (!new RegExp('^cam_test_' + pid + '_[a-f0-9]{8}$').test(datname))
      throw Error('Unexpected database name.');
    await client.query('DROP DATABASE ' + pg.escapeIdentifier(datname) + ' WITH (FORCE)');
  }
  console.log('Removed ' + rows.length + ' temporary acceptance database(s).');
} finally {
  await client.end();
}
