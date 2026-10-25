import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { postgresFixture } from './helpers.mjs';
import { Cameras } from '../lib/cameras.mjs';
import { TenantStorage } from '../lib/storage.mjs';
import { createSaas } from '../server.mjs';
import { AuditLog, writeAudit, auditDetails } from '../lib/audit.mjs';
import { tokenHash } from '../lib/auth.mjs';

test('audit history records real actions and enforces role, workspace and deletion boundaries', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t),
    password = 'synthetic-password-42';
  const directory = await mkdtemp(path.join(tmpdir(), 'saas-audit-test-'));
  const storage = await new TenantStorage(directory, db).open();
  const cameras = new Cameras(db, cipher, {
    personal: async (input) => ({
      credentials: {
        sessionId: 'private-web-token',
        sdkAccessToken: 'private-sdk-token',
        sdkExpiresAt: Date.now() + 3600000,
        accountUserId: input.account,
        origin: 'https://iindia.hik-connect.com',
        user: { username: input.account },
      },
    }),
    hik: {
      devices: async () => [],
      sharing: async (p) => ({
        devices: [
          {
            id: 'device',
            serial: 'private-camera-serial',
            name: p.accountUserId + ' recorder',
            status: 'online',
            channels: [{ number: 1, name: 'Gate' }],
          },
        ],
      }),
    },
  });
  const { server } = createSaas({ db, auth, workspaces, cipher, cameras, storage, rateLimit: 100 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (route, { token, data, raw, headers = {} } = {}) => {
    const response = await fetch(base + route, {
      method: data !== undefined || raw ? 'POST' : 'GET',
      headers: {
        ...(token ? { Cookie: 'hik_saas=' + token } : {}),
        ...(data !== undefined || raw
          ? { 'X-Hik-Local': '1', 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      ...(raw ? { body: raw } : data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const root = await auth.bootstrap({
    email: 'root@example.test',
    fullName: 'Platform Owner',
    password,
  });
  for (const name of ['Alpha', 'Beta'])
    await auth.signup({
      email: name.toLowerCase() + '@example.test',
      fullName: name + ' Admin',
      workspaceName: name + ' Workspace',
      password,
    });
  for (const request of (await workspaces.platform(root.token)).workspaces)
    await workspaces.decide(root.token, request.id, 'approve');
  const alpha = await auth.login({ email: 'alpha@example.test', password }),
    beta = await auth.login({ email: 'beta@example.test', password });
  for (const [name, user] of [
    ['Alpha', alpha],
    ['Beta', beta],
  ]) {
    await cameras.connect(user.token, { account: name, password: 'synthetic-provider-secret' });
    await cameras.devices(user.token);
  }
  const memberId = (
    await workspaces.createMember(alpha.token, {
      email: 'member@example.test',
      fullName: 'Audit Member',
      password,
    })
  ).id;
  await workspaces.editMember(alpha.token, memberId, {
    grants: [{ deviceId: 'device', view: true, download: false, record: false }],
  });
  let member = await auth.login({ email: 'member@example.test', password });
  member = await auth.changePassword(member.token, {
    currentPassword: password,
    newPassword: 'member-private-password-42',
  });
  const audit = new AuditLog(db),
    get = (token, query = '') => call('/api/audit' + query, { token });
  await t.test(
    'superadmin sees platform activity, admin sees only own workspace, members are denied',
    async () => {
      assert.equal((await get()).status, 401);
      assert.equal((await get(member.token)).status, 403);
      const global = await get(root.token);
      assert.equal(global.status, 200);
      assert.equal(global.body.scope, 'platform');
      assert.ok(global.body.events.some((e) => e.workspace === 'Alpha Workspace'));
      assert.ok(global.body.events.some((e) => e.workspace === 'Beta Workspace'));
      const own = await get(alpha.token, '?tenantId=' + beta.principal.tenantId);
      assert.equal(own.body.scope, 'workspace');
      assert.ok(own.body.events.length);
      assert.ok(own.body.events.every((e) => e.workspace === 'Alpha Workspace'));
      assert.equal((await get(alpha.token, '?q=Beta')).body.events.length, 0);
    },
  );
  await t.test(
    'entries identify approvals, targets and permission settings without secrets',
    async () => {
      const events = (await get(root.token)).body.events;
      assert.ok(
        events.some(
          (e) =>
            e.action === 'workspace.approve' &&
            e.actor.name === 'Platform Owner' &&
            e.target.email === 'alpha@example.test',
        ),
      );
      const permission = events.find((e) => e.action === 'member.permissions_changed');
      assert.equal(permission.target.name, 'Audit Member');
      assert.match(permission.details.changes[0], /View on, Download off, Record off/);
      const serialized = JSON.stringify(events);
      for (const secret of [
        'private-web-token',
        'private-sdk-token',
        'synthetic-provider-secret',
        'private-camera-serial',
        'password_hash',
        'password_salt',
      ])
        assert.equal(serialized.includes(secret), false);
      assert.deepEqual(
        auditDetails({
          password: 'never-log',
          sessionId: 'never-log',
          targetName: 'Allowed',
          changes: ['View on'],
        }),
        { targetName: 'Allowed', changes: ['View on'] },
      );
    },
  );
  await t.test(
    'category, literal search and date validation are applied on the server',
    async () => {
      const accounts = await get(root.token, '?category=accounts');
      assert.ok(accounts.body.events.length);
      assert.ok(accounts.body.events.every((e) => e.action.startsWith('provider.')));
      assert.equal((await get(root.token, '?category=not-real')).status, 400);
      assert.equal((await get(root.token, '?before=999999999999999999999')).status, 400);
      assert.equal((await get(root.token, '?from=invalid')).status, 400);
      assert.equal(
        (await get(root.token, '?from=2026-10-25T00:00:00Z&to=2026-10-24T00:00:00Z')).status,
        400,
      );
      assert.equal(
        (await get(root.token, '?q=' + encodeURIComponent("' OR true --"))).body.events.length,
        0,
      );
      await audit.record(alpha.token, 'member.updated', memberId, {
        targetName: 'Literal 100% Person',
      });
      assert.equal((await get(root.token, '?q=%25')).body.events.length, 1);
    },
  );
  await t.test(
    'keyset pagination does not duplicate events or let tenant parameters expand scope',
    async () => {
      await db.session(tokenHash(alpha.token), async (client) => {
        for (let i = 0; i < 63; i++)
          await writeAudit(client, {
            tenantId: alpha.principal.tenantId,
            actorId: alpha.principal.id,
            action: 'member.updated',
            targetId: memberId,
            details: { targetName: 'Paging Marker ' + i },
          });
      });
      const first = (await get(alpha.token, '?q=Paging%20Marker')).body;
      assert.equal(first.events.length, 50);
      assert.ok(first.nextCursor);
      const next = (await get(alpha.token, '?q=Paging%20Marker&before=' + first.nextCursor)).body;
      assert.equal(next.events.length, 13);
      assert.equal(next.nextCursor, null);
      assert.equal(new Set([...first.events, ...next.events].map((e) => e.id)).size, 63);
      assert.equal(
        (await get(beta.token, '?q=Paging%20Marker&tenantId=' + alpha.principal.tenantId)).body
          .events.length,
        0,
      );
    },
  );
  const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)]);
  const upload = async () => {
    const id = randomUUID(),
      r = await call('/api/recordings', {
        token: alpha.token,
        raw: bytes,
        headers: {
          'Content-Type': 'video/webm',
          'X-Recording-Id': id,
          'X-Recording-Meta': encodeURIComponent(
            JSON.stringify({ deviceId: 'device', channel: 1, duration: 1000, audio: false }),
          ),
        },
      });
    assert.equal(r.status, 201);
    return id;
  };
  await t.test(
    'manual deletion records an intent and completion only for an authorized actor',
    async () => {
      const id = await upload();
      assert.equal(
        (await call(`/api/recordings/${id}/delete`, { token: member.token, data: {} })).status,
        403,
      );
      assert.equal(
        (await call(`/api/recordings/${id}/delete`, { token: beta.token, data: {} })).status,
        404,
      );
      assert.equal(
        (await call(`/api/recordings/${id}/delete`, { token: alpha.token, data: {} })).status,
        200,
      );
      const rows = (await get(alpha.token, '?category=recordings')).body.events.filter(
        (e) => e.target.id === id,
      );
      assert.deepEqual(
        rows.map((e) => e.action),
        ['recording.deleted', 'recording.delete_requested'],
      );
      assert.equal(rows[0].actor.name, 'Alpha Admin');
      assert.equal(rows[0].details.recorderName, 'Alpha recorder');
      assert.equal((await get(beta.token, '?category=recordings')).body.events.length, 0);
    },
  );
  await t.test('retention cleanup is identified as a system action with its reason', async () => {
    const id = await upload(),
      store = await storage.store(alpha.principal.tenantId);
    store.now = () => Date.now() + 8 * 86400000;
    await store.cleanup();
    const rows = (await get(alpha.token, '?category=recordings')).body.events.filter(
      (e) => e.target.id === id,
    );
    assert.deepEqual(
      rows.map((e) => e.action),
      ['recording.cleaned', 'recording.cleanup_requested'],
    );
    assert.equal(rows[0].actor.name, 'System');
    assert.equal(rows[0].details.reason, 'retention');
    store.now = Date.now;
  });
  await t.test('cleanup cannot remove a clip if its audit intent cannot be stored', async () => {
    const id = await upload(),
      store = await storage.store(alpha.principal.tenantId),
      original = store.onPrune;
    store.now = () => Date.now() + 8 * 86400000;
    store.onPrune = async () => {
      throw Error('Synthetic audit outage');
    };
    try {
      await assert.rejects(store.cleanup(), /Synthetic audit outage/);
      const clip = store.index.clips.find((c) => c.id === id);
      assert.ok(clip);
      await access(store.file(clip));
    } finally {
      store.onPrune = original;
      store.now = Date.now;
    }
  });
  await t.test('application database access cannot rewrite or delete audit history', async () => {
    for (const sql of ["UPDATE cam.audit SET action='forged'", 'DELETE FROM cam.audit'])
      await assert.rejects(
        db.session(tokenHash(root.token), (client) => client.query(sql)),
        { code: '42501' },
      );
    await assert.rejects(
      db.session(tokenHash(alpha.token), (client) =>
        client.query("INSERT INTO cam.audit(tenant_id,actor_id,action) VALUES($1,$2,'forged')", [
          beta.principal.tenantId,
          alpha.principal.id,
        ]),
      ),
      { code: '42501' },
    );
  });
});
