import test from 'node:test';
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

import { postgresFixture } from './helpers.mjs';

test('real PostgreSQL approval workflow and row policies isolate two workspaces', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t);
  assert.equal(await auth.setupRequired(), true);
  const password = 'synthetic-password-42';
  const root = await auth.bootstrap({
    email: 'root@example.test',
    fullName: 'Platform owner',
    password,
  });
  assert.equal(root.principal.role, 'superadmin');
  assert.equal(await auth.setupRequired(), false);
  await assert.rejects(
    auth.bootstrap({ email: 'another@example.test', fullName: 'Another root', password }),
  );
  for (const name of ['a', 'b'])
    await auth.signup({
      email: name + '@example.test',
      fullName: 'Admin ' + name,
      workspaceName: 'Workspace ' + name,
      password,
      role: 'superadmin',
    });
  await assert.rejects(
    auth.login({ email: 'a@example.test', password }),
    (error) => error.code === 'approval-pending',
  );
  const requests = (await workspaces.platform(root.token)).workspaces;
  assert.equal(requests.length, 2);
  const a = requests.find((u) => u.email === 'a@example.test'),
    b = requests.find((u) => u.email === 'b@example.test');
  await workspaces.decide(root.token, a.id, 'approve');
  await workspaces.decide(root.token, b.id, 'approve');
  const aa = await auth.login({ email: 'a@example.test', password }),
    bb = await auth.login({ email: 'b@example.test', password });
  assert.notEqual(aa.principal.tenantId, bb.principal.tenantId);
  await assert.rejects(workspaces.platform(aa.token), (error) => error.status === 403);
  const user = await workspaces.createMember(aa.token, {
    email: 'member@example.test',
    fullName: 'Member A',
    password,
    role: 'admin',
    tenantId: bb.principal.tenantId,
  });
  const member = await auth.login({ email: 'member@example.test', password });
  assert.equal(member.principal.role, 'member');
  assert.equal(member.principal.tenantId, aa.principal.tenantId);
  const deviceId = 'shared-recorder';
  const cameras = new Cameras(db, cipher, {
    personal: async (input) => ({
      credentials: {
        sessionId: 'synthetic-' + input.account,
        accountUserId: input.account,
        origin: 'https://iindia.hik-connect.com',
        sdkAccessToken: 'synthetic-' + input.account,
        sdkExpiresAt: Date.now() + 3600000,
      },
    }),
    hik: {
      devices: async () => [],
      sharing: async () => ({
        devices: [
          {
            id: deviceId,
            serial: 'private-serial',
            name: 'Entrance',
            status: 'online',
            source: 'shared',
            channels: [
              { number: 1, name: 'Gate' },
              { number: 2, name: 'Office' },
            ],
          },
        ],
      }),
    },
  });
  await cameras.connect(aa.token, { account: 'account-a' });
  await cameras.connect(bb.token, { account: 'account-b' });
  await cameras.devices(aa.token);
  await cameras.devices(bb.token);
  assert.deepEqual((await cameras.devices(member.token)).devices, []);
  await workspaces.editMember(aa.token, user.id, {
    grants: [{ deviceId, view: true, download: false, record: false, channels: [1] }],
  });
  await assert.rejects(auth.principal(member.token), (error) => error.status === 401);
  const member2 = await auth.login({ email: 'member@example.test', password });
  assert.deepEqual(
    (await cameras.devices(member2.token)).devices[0].channels.map((c) => c.number),
    [1],
  );
  assert.equal(
    (await cameras.media(member2.token, deviceId, 1)).provider.accountUserId,
    'account-a',
  );
  await assert.rejects(cameras.media(member2.token, deviceId, 2), (error) => error.status === 403);
  await assert.rejects(
    cameras.media(member2.token, deviceId, 1, 'download'),
    (error) => error.status === 403,
  );
  await assert.rejects(
    cameras.connect(member2.token, { account: 'account-b' }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    workspaces.editMember(bb.token, user.id, { status: 'suspended' }),
    (error) => error.status === 404,
  );
  const rows = await db.session(tokenHash(aa.token), (client) =>
    client.query('SELECT tenant_id FROM cam.devices'),
  );
  assert.ok(rows.rows.every((row) => row.tenant_id === aa.principal.tenantId));
  assert.equal((await db.pool.query('SELECT id FROM cam.users')).rowCount, 0);
  const rootProviders = await db.session(tokenHash(root.token), (client) =>
    client.query('SELECT tenant_id FROM cam.providers'),
  );
  assert.equal(rootProviders.rowCount, 0);
  await assert.rejects(
    db.session(tokenHash(aa.token), (client) =>
      client.query("INSERT INTO cam.preferences(tenant_id,user_id,data) VALUES($1,$2,'{}')", [
        bb.principal.tenantId,
        user.id,
      ]),
    ),
    (error) => error.code === '42501',
  );
  const sealed = cipher.seal({ sdkAccessToken: 'private-token' }, aa.principal.tenantId);
  assert.ok(!sealed.includes(Buffer.from('private-token')));
  assert.throws(() => cipher.open(sealed, bb.principal.tenantId));
  await workspaces.decide(root.token, a.id, 'suspend');
  await assert.rejects(auth.principal(aa.token), (error) => error.status === 401);
  await assert.rejects(auth.principal(member2.token), (error) => error.status === 401);
  assert.equal((await auth.principal(bb.token)).tenantId, bb.principal.tenantId);
});
