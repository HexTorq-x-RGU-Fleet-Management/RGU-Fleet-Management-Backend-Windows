import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresFixture } from './helpers.mjs';
import { tokenHash } from '../lib/auth.mjs';

test('authentication lifecycle, approval races and recovery preserve workspace boundaries', async (t) => {
  const { db, auth, workspaces } = await postgresFixture(t);
  const password = 'synthetic-password-42';
  let root, admin, member, memberId, request;
  await t.test('signup is unavailable until the one-time platform setup finishes', async () => {
    await assert.rejects(
      auth.signup({
        email: 'early@example.test',
        fullName: 'Early',
        workspaceName: 'Early',
        password,
      }),
      { status: 503 },
    );
    const attempts = await Promise.allSettled(
      ['one', 'two'].map((name) =>
        auth.bootstrap({ email: name + '@root.example.test', fullName: name, password }),
      ),
    );
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((a) => a.status === 'rejected').length, 1);
    root = attempts.find((a) => a.status === 'fulfilled').value;
    assert.equal(await auth.setupRequired(), false);
  });
  await t.test('weak passwords, missing names and malformed emails are rejected', async () => {
    const input = {
      email: 'admin@example.test',
      fullName: 'Admin',
      workspaceName: 'Tenant',
      password,
    };
    for (const invalid of [
      { password: 'short' },
      { email: 'bad-email' },
      { fullName: '' },
      { workspaceName: '' },
    ])
      await assert.rejects(auth.signup({ ...input, ...invalid }), { status: 400 });
  });
  await t.test(
    'signup ignores injected privileges and duplicate email casing is rejected',
    async () => {
      await auth.signup({
        email: 'admin@example.test',
        fullName: 'Admin',
        workspaceName: 'Tenant',
        password,
        role: 'superadmin',
        status: 'active',
        tenantId: root.principal.id,
      });
      await assert.rejects(
        auth.signup({
          email: 'ADMIN@example.test',
          fullName: 'Other',
          workspaceName: 'Other',
          password,
        }),
        { code: '23505' },
      );
      await assert.rejects(auth.login({ email: 'admin@example.test', password }), {
        status: 403,
        code: 'approval-pending',
      });
      await assert.rejects(
        auth.login({ email: 'admin@example.test', password: 'wrong-password' }),
        { status: 401, code: 'invalid-credentials' },
      );
      request = (await workspaces.platform(root.token)).workspaces.find(
        (a) => a.email === 'admin@example.test',
      );
      assert.equal(request.role, 'admin');
      assert.equal(request.status, 'pending');
    },
  );
  await t.test('concurrent approval has one winner and rejects the stale decision', async () => {
    const decisions = await Promise.allSettled([
      workspaces.decide(root.token, request.id, 'approve'),
      workspaces.decide(root.token, request.id, 'reject'),
    ]);
    assert.equal(decisions.filter((a) => a.status === 'fulfilled').length, 1);
    assert.equal(decisions.find((a) => a.status === 'rejected').reason.status, 409);
    // Whichever request won the race must determine the final authorization.
    const final = (await workspaces.platform(root.token)).workspaces.find(
      (a) => a.id === request.id,
    );
    if (final.status === 'rejected') {
      await assert.rejects(auth.login({ email: request.email, password }), {
        status: 403,
        code: 'account-inactive',
      });
      await auth.signup({
        email: 'approved@example.test',
        fullName: 'Approved',
        workspaceName: 'Approved tenant',
        password,
      });
      request = (await workspaces.platform(root.token)).workspaces.find(
        (a) => a.email === 'approved@example.test',
      );
      await workspaces.decide(root.token, request.id, 'approve');
    }
    admin = await auth.login({ email: request.email, password });
    assert.equal(admin.principal.role, 'admin');
  });
  await t.test('new members cannot bypass their forced password change', async () => {
    memberId = (
      await workspaces.createMember(admin.token, {
        email: 'member@example.test',
        fullName: 'Member',
        password,
        role: 'admin',
      })
    ).id;
    member = await auth.login({ email: 'member@example.test', password });
    assert.equal(member.principal.role, 'member');
    assert.equal(member.principal.mustChangePassword, true);
    await assert.rejects(workspaces.members(member.token), { status: 403 });
    await assert.rejects(workspaces.platform(admin.token), { status: 403 });
  });
  await t.test(
    'password changes revoke every old session and preserve a fresh session',
    async () => {
      const second = await auth.login({ email: 'member@example.test', password });
      await assert.rejects(
        auth.changePassword(member.token, {
          currentPassword: 'incorrect',
          newPassword: 'member-password-43',
        }),
        { status: 400 },
      );
      await auth.principal(member.token);
      const next = await auth.changePassword(member.token, {
        currentPassword: password,
        newPassword: 'member-password-43',
      });
      for (const old of [member, second])
        await assert.rejects(auth.principal(old.token), { status: 401 });
      await assert.rejects(auth.login({ email: 'member@example.test', password }), { status: 401 });
      member = next;
      assert.equal(member.principal.mustChangePassword, false);
    },
  );
  await t.test(
    'admin reset invalidates member sessions and requires another password change',
    async () => {
      await workspaces.editMember(admin.token, memberId, { password: 'reset-member-password-44' });
      await assert.rejects(auth.principal(member.token), { status: 401 });
      await assert.rejects(
        auth.login({ email: 'member@example.test', password: 'member-password-43' }),
        { status: 401 },
      );
      member = await auth.login({
        email: 'member@example.test',
        password: 'reset-member-password-44',
      });
      assert.equal(member.principal.mustChangePassword, true);
      member = await auth.changePassword(member.token, {
        currentPassword: 'reset-member-password-44',
        newPassword: 'member-password-45',
      });
    },
  );
  await t.test('suspension blocks members; restoring never revives an old session', async () => {
    await workspaces.editMember(admin.token, memberId, { status: 'suspended' });
    await assert.rejects(auth.principal(member.token), { status: 401 });
    await assert.rejects(
      auth.login({ email: 'member@example.test', password: 'member-password-45' }),
      { status: 403 },
    );
    await workspaces.editMember(admin.token, memberId, { status: 'active' });
    await assert.rejects(auth.principal(member.token), { status: 401 });
    member = await auth.login({ email: 'member@example.test', password: 'member-password-45' });
  });
  await t.test('expired sessions and logout cannot be reused', async () => {
    const extra = await auth.login({ email: request.email, password });
    await auth.logout(extra.token);
    await auth.logout(extra.token);
    await assert.rejects(auth.principal(extra.token), { status: 401 });
    // Test fixture migration owner can expire a synthetic session; runtime cannot.
    const { readPrivate } = await import('../lib/config.mjs');
    const { default: pg } = await import('pg');
    const secret = await readPrivate('database-admin'),
      url = new URL(db.pool.options.connectionString);
    url.username = 'saas_bootstrap';
    url.password = secret.bootstrapPassword;
    const owner = new pg.Client({ connectionString: url.href });
    await owner.connect();
    try {
      await owner.query(
        "UPDATE cam.sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
        [tokenHash(member.token)],
      );
    } finally {
      await owner.end();
    }
    await assert.rejects(auth.principal(member.token), { status: 401 });
  });
  await t.test(
    'workspace restoration needs fresh login and leaves the superadmin active',
    async () => {
      await workspaces.decide(root.token, request.id, 'suspend');
      await assert.rejects(auth.principal(admin.token), { status: 401 });
      await assert.rejects(auth.login({ email: request.email, password }), { status: 403 });
      await workspaces.decide(root.token, request.id, 'restore');
      await assert.rejects(auth.principal(admin.token), { status: 401 });
      assert.equal((await auth.login({ email: request.email, password })).principal.role, 'admin');
      assert.equal((await auth.principal(root.token)).role, 'superadmin');
    },
  );
  await t.test(
    'a new database pool restores valid sessions without carrying a prior workspace scope',
    async () => {
      const { Database } = await import('../lib/database.mjs'),
        { Auth } = await import('../lib/auth.mjs');
      const fresh = await new Database(db.pool.options.connectionString).connect();
      try {
        const restored = await new Auth(fresh).principal(root.token);
        assert.equal(restored.role, 'superadmin');
        const unscoped = await fresh.pool.query('SELECT id FROM cam.users');
        assert.equal(unscoped.rowCount, 0);
        await assert.rejects(new Auth(fresh).principal(member.token), { status: 401 });
      } finally {
        await fresh.close();
      }
    },
  );
});
