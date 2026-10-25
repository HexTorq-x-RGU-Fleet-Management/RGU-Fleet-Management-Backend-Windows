import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { postgresFixture } from './helpers.mjs';
import { TenantStorage } from '../lib/storage.mjs';
import { createSaas } from '../server.mjs';
import { tokenHash } from '../lib/auth.mjs';

test('superadmin password support resets admins and members without changing workspace access', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'saas-reset-test-'));
  const storage = await new TenantStorage(directory, db).open(),
    closed = [];
  const hub = {
    closeUser: (id) => closed.push(id),
    closeSession() {},
    closeTenant() {},
    async reap() {},
    close() {},
  };
  const { server } = createSaas({ db, auth, workspaces, cipher, storage, hub, rateLimit: 100 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port,
    password = 'synthetic-password-42';
  const call = async (route, { token, data } = {}) => {
    const response = await fetch(base + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Cookie: 'hik_saas=' + token } : {}),
        ...(data === undefined ? {} : { 'X-Hik-Local': '1', 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const root = await auth.bootstrap({ email: 'root@example.test', fullName: 'Root', password });
  for (const name of ['alpha', 'beta', 'pending'])
    await auth.signup({
      email: name + '@example.test',
      fullName: name,
      workspaceName: name,
      password,
    });
  const requests = (await workspaces.platform(root.token)).workspaces;
  const alphaRequest = requests.find((u) => u.email === 'alpha@example.test'),
    betaRequest = requests.find((u) => u.email === 'beta@example.test'),
    pending = requests.find((u) => u.email === 'pending@example.test');
  for (const user of [alphaRequest, betaRequest])
    await workspaces.decide(root.token, user.id, 'approve');
  let alpha = await auth.login({ email: alphaRequest.email, password });
  const beta = await auth.login({ email: betaRequest.email, password });
  const memberId = (
    await workspaces.createMember(alpha.token, {
      email: 'member@example.test',
      fullName: 'Member',
      password,
    })
  ).id;
  let member = await auth.login({ email: 'member@example.test', password });
  member = await auth.changePassword(member.token, {
    currentPassword: password,
    newPassword: 'original-member-password-42',
  });
  const route = (id) => `/api/platform/users/${id}/password`,
    usersRoute = `/api/platform/workspaces/${alpha.principal.tenantId}/users`;
  await t.test('only superadmin can list workspace users or reset passwords', async () => {
    assert.equal((await call(usersRoute)).status, 401);
    for (const actor of [alpha, beta, member]) {
      assert.equal((await call(usersRoute, { token: actor.token })).status, 403);
      assert.equal(
        (
          await call(route(memberId), {
            token: actor.token,
            data: { password: 'forbidden-password-42' },
          })
        ).status,
        403,
      );
    }
    const list = await call(usersRoute, { token: root.token });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.users.map((u) => u.id).sort(),
      [alpha.principal.id, memberId].sort(),
    );
    assert.equal(JSON.stringify(list.body).includes('password_hash'), false);
    assert.equal(JSON.stringify(list.body).includes('password_salt'), false);
    assert.equal(
      (
        await call(route(root.principal.id), {
          token: root.token,
          data: { password: 'root-reset-password-42' },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await call(route(randomUUID()), {
          token: root.token,
          data: { password: 'unknown-password-42' },
        })
      ).status,
      404,
    );
  });
  await t.test('invalid passwords do not change an account or close its sessions', async () => {
    for (const password of ['short', 'x'.repeat(129), null])
      assert.equal(
        (await call(route(memberId), { token: root.token, data: { password } })).status,
        400,
      );
    await auth.principal(member.token);
    assert.equal(closed.length, 0);
  });
  await t.test('member reset revokes sessions and requires a fresh personal password', async () => {
    const result = await call(route(memberId), {
      token: root.token,
      data: {
        password: 'temporary-member-password-42',
        status: 'active',
        role: 'admin',
        tenantId: beta.principal.tenantId,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.mustChangePassword, true);
    assert.deepEqual(closed, [memberId]);
    assert.equal(JSON.stringify(result.body).includes('temporary-member-password-42'), false);
    await assert.rejects(auth.principal(member.token), { status: 401 });
    await assert.rejects(
      auth.login({ email: 'member@example.test', password: 'original-member-password-42' }),
      { status: 401 },
    );
    member = await auth.login({
      email: 'member@example.test',
      password: 'temporary-member-password-42',
    });
    assert.equal(member.principal.role, 'member');
    assert.equal(member.principal.tenantId, alpha.principal.tenantId);
    assert.equal(
      (await call('/api/devices', { token: member.token })).body.code,
      'password-change-required',
    );
    member = await auth.changePassword(member.token, {
      currentPassword: 'temporary-member-password-42',
      newPassword: 'final-member-password-42',
    });
    assert.equal(member.principal.mustChangePassword, false);
  });
  await t.test(
    'admin reset closes only that user and preserves other users and provider data',
    async () => {
      const sealed = cipher.seal({ sessionId: 'synthetic-web-grant' }, alpha.principal.tenantId);
      await db.session(tokenHash(alpha.token), (client) =>
        client.query('INSERT INTO cam.providers(tenant_id,payload,account_key) VALUES($1,$2,$3)', [
          alpha.principal.tenantId,
          sealed,
          'synthetic-account',
        ]),
      );
      assert.equal(
        (
          await call(route(alpha.principal.id), {
            token: root.token,
            data: { password: 'temporary-admin-password-42' },
          })
        ).status,
        200,
      );
      await assert.rejects(auth.principal(alpha.token), { status: 401 });
      await assert.rejects(auth.login({ email: alphaRequest.email, password }), { status: 401 });
      await auth.principal(beta.token);
      await auth.principal(member.token);
      await auth.principal(root.token);
      alpha = await auth.login({
        email: alphaRequest.email,
        password: 'temporary-admin-password-42',
      });
      assert.equal(alpha.principal.mustChangePassword, true);
      assert.equal(
        (await call('/api/team', { token: alpha.token })).body.code,
        'password-change-required',
      );
      alpha = await auth.changePassword(alpha.token, {
        currentPassword: 'temporary-admin-password-42',
        newPassword: 'final-admin-password-42',
      });
      await db.session(tokenHash(alpha.token), async (client) => {
        const saved = (
          await client.query('SELECT payload FROM cam.providers WHERE tenant_id=$1', [
            alpha.principal.tenantId,
          ])
        ).rows[0];
        assert.equal(
          cipher.open(saved.payload, alpha.principal.tenantId).sessionId,
          'synthetic-web-grant',
        );
      });
    },
  );
  await t.test(
    'resets neither approve pending workspaces nor restore suspended users',
    async () => {
      assert.equal(
        (
          await call(route(pending.id), {
            token: root.token,
            data: { password: 'temporary-pending-password-42' },
          })
        ).status,
        200,
      );
      await assert.rejects(
        auth.login({ email: pending.email, password: 'temporary-pending-password-42' }),
        { code: 'approval-pending' },
      );
      await workspaces.editMember(alpha.token, memberId, { status: 'suspended' });
      const result = await call(route(memberId), {
        token: root.token,
        data: { password: 'temporary-suspended-password-42', status: 'active' },
      });
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'suspended');
      await assert.rejects(
        auth.login({ email: 'member@example.test', password: 'temporary-suspended-password-42' }),
        { code: 'account-inactive' },
      );
    },
  );
  await t.test('reset actions are audited without storing the temporary password', async () => {
    await db.session(tokenHash(root.token), async (client) => {
      const events = (
        await client.query(
          "SELECT action,target_id,actor_id FROM cam.audit WHERE action='user.password_reset'",
        )
      ).rows;
      assert.equal(events.length, 4);
      assert.ok(events.every((e) => e.actor_id === root.principal.id));
      assert.equal(JSON.stringify(events).includes('temporary-'), false);
    });
  });
});
