import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { project, readPrivate } from '../lib/config.mjs';
import { Database } from '../lib/database.mjs';
import { Auth, tokenHash } from '../lib/auth.mjs';
import { Workspaces } from '../lib/workspaces.mjs';
import { ProviderCipher } from '../lib/cipher.mjs';
import { Cameras } from '../lib/cameras.mjs';

export async function postgresFixture(t) {
  const secrets = await readPrivate('database-admin');
  const name = 'cam_test_' + process.pid + '_' + randomBytes(4).toString('hex');
  assert.match(name, /^cam_test_\d+_[a-f0-9]{8}$/);
  const options = {
    host: '127.0.0.1',
    port: 55432,
    user: 'saas_bootstrap',
    password: secrets.bootstrapPassword,
  };
  const admin = new pg.Client({ ...options, database: 'postgres' });
  await admin.connect();
  await admin.query('CREATE DATABASE ' + name);
  const migration = new pg.Client({ ...options, database: name });
  await migration.connect();
  try {
    await migration.query(await readFile(path.join(project, 'db/schema.sql'), 'utf8'));
    await migration.query(await readFile(path.join(project, 'db/grants.sql'), 'utf8'));
    await migration.query(await readFile(path.join(project, 'db/fleet.sql'), 'utf8'));
  } finally {
    await migration.end();
  }
  const db = await new Database(
    `postgresql://cam_app:${secrets.appPassword}@127.0.0.1:55432/${name}`,
  ).connect();
  t.after(async () => {
    await db.close();
    await admin.query('DROP DATABASE ' + name);
    await admin.end();
  });
  return {
    db,
    auth: new Auth(db),
    workspaces: new Workspaces(db),
    cipher: new ProviderCipher(randomBytes(32)),
  };
}
