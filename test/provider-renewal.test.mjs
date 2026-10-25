import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { postgresFixture } from './helpers.mjs';
import { Cameras } from '../lib/cameras.mjs';
import { ProviderRecovery } from '../lib/provider-recovery.mjs';
import { MediaHub } from '../lib/media.mjs';
import { providerConnectionId } from '../lib/provider-state.mjs';
import { tokenHash } from '../lib/auth.mjs';
import { HikError } from '../vendor/windows-sdk/lib/hik-connect.mjs';
import { PortalError } from '../vendor/windows-sdk/lib/personal-client.mjs';

test('durable provider recovery preserves identity, credentials and permissions under faults', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t),
    password = 'synthetic-password-42';
  const root = await auth.bootstrap({ email: 'root@example.test', fullName: 'Root', password });
  for (const name of ['alpha', 'beta'])
    await auth.signup({
      email: name + '@example.test',
      fullName: name,
      workspaceName: name,
      password,
    });
  for (const request of (await workspaces.platform(root.token)).workspaces)
    await workspaces.decide(root.token, request.id, 'approve');
  const admin = await auth.login({ email: 'alpha@example.test', password }),
    other = await auth.login({ email: 'beta@example.test', password });
  let now = Date.now(),
    hooks = {},
    calls = {},
    recovered = [];
  const device = {
    id: 'same-device',
    serial: 'synthetic-serial',
    name: 'Fixture recorder',
    status: 'online',
    channels: [{ number: 1, name: 'Gate' }],
  };
  const cameras = new Cameras(db, cipher, {
    hik: {
      devices: async (p) => {
        calls.devices++;
        return hooks.devices ? hooks.devices(p) : [];
      },
      sharing: async (p) => {
        calls.sharing++;
        return hooks.sharing ? hooks.sharing(p) : { devices: [device] };
      },
    },
    personal: async (input) => {
      calls.login++;
      return hooks.login
        ? hooks.login(input)
        : {
            credentials: {
              sessionId: 'web-renewed',
              accountUserId: 'account-a',
              origin: 'https://iindia.hik-connect.com',
              user: { username: 'Fixture' },
            },
          };
    },
    desktopToken: async () => {
      calls.desktop++;
      return hooks.desktop ? hooks.desktop() : 'updated-sdk-grant';
    },
    verifySdk: async (...args) => {
      calls.verify++;
      return hooks.verify ? hooks.verify(...args) : { validatedAt: now };
    },
  });
  const worker = (options) =>
    new ProviderRecovery(db, cipher, cameras, {
      now: () => now,
      platform: 'win32',
      onRecovered: (id) => recovered.push(id),
      ...options,
    });
  const seed = async (overrides) => {
    hooks = {};
    calls = { devices: 0, sharing: 0, login: 0, desktop: 0, verify: 0 };
    recovered = [];
    now = Date.now();
    const p = {
      accountUserId: 'account-a',
      sessionId: 'web-old',
      sdkAccessToken: 'sdk-old',
      sdkExpiresAt: now + 3600000,
      origin: 'https://iindia.hik-connect.com',
      connectionRevision: randomUUID(),
      credentialVersion: randomUUID(),
      recovery: {
        webEnabled: true,
        playbackEnabled: false,
        secret: {
          account: 'fixture-account',
          password: 'synthetic-provider-password',
          origin: 'https://iindia.hik-connect.com',
        },
        web: {},
        playback: {},
      },
      ...overrides,
    };
    await db.session(tokenHash(admin.token), async (client) => {
      await client.query(
        'INSERT INTO cam.providers(tenant_id,payload,account_key) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET payload=excluded.payload,account_key=excluded.account_key',
        [admin.principal.tenantId, cipher.seal(p, admin.principal.tenantId), 'fixture-key'],
      );
      await client.query(
        'INSERT INTO cam.devices(tenant_id,device_id,data) VALUES($1,$2,$3) ON CONFLICT(tenant_id,device_id) DO UPDATE SET data=excluded.data,available=true',
        [admin.principal.tenantId, device.id, device],
      );
    });
    return p;
  };
  const load = async () => (await cameras.adminProvider(admin.token)).provider;
  const expire = () => {
    hooks.devices = (p) => {
      if (p.sessionId === 'web-old') throw new HikError('Expired', 401, 'provider-auth-required');
      return [];
    };
  };
  await t.test(
    'opt-in sign-in credentials are encrypted and never returned by status',
    async () => {
      await seed();
      const sealed = await db.session(
        tokenHash(admin.token),
        async (c) => (await c.query('SELECT payload FROM cam.providers')).rows[0].payload,
      );
      assert.equal(sealed.includes(Buffer.from('synthetic-provider-password')), false);
      const status = JSON.stringify(await cameras.status(admin.token));
      for (const secret of ['synthetic-provider-password', 'fixture-account', 'web-old', 'sdk-old'])
        assert.equal(status.includes(secret), false);
      assert.equal((await cameras.status(admin.token)).automaticReconnect, true);
      assert.equal((await cameras.status(admin.token)).automaticRenewal, false);
    },
  );
  await t.test(
    'web 401 reauthenticates once, preserves playback and a stable connection identity',
    async () => {
      const before = await seed();
      expire();
      await cameras.preferences(admin.token, { favourites: ['saved-camera'] });
      const job = worker();
      assert.equal(await job.run(admin.principal.tenantId), true);
      const after = await load();
      assert.equal(calls.login, 1);
      assert.equal(after.sessionId, 'web-renewed');
      assert.equal(after.sdkAccessToken, 'sdk-old');
      assert.equal(providerConnectionId(before), providerConnectionId(after));
      assert.deepEqual((await cameras.preferences(admin.token)).favourites, ['saved-camera']);
      assert.equal((await cameras.devices(admin.token)).devices.length, 1);
      assert.equal((await auth.principal(admin.token)).role, 'admin');
      assert.deepEqual(recovered, [admin.principal.tenantId]);
    },
  );
  await t.test(
    'web expiry detected by device discovery preserves cached channel metadata',
    async () => {
      await seed();
      expire();
      await assert.rejects(cameras.devices(admin.token), { code: 'provider-auth-required' });
      assert.equal((await load()).needsReconnect, true);
      const rows = await cameras.devices(admin.token, false);
      assert.equal(rows.devices.length, 1);
      await worker().run(admin.principal.tenantId);
      assert.equal((await load()).needsReconnect, false);
    },
  );
  await t.test(
    'same-account renewal preserves member grants, sessions and member settings',
    async () => {
      await seed();
      const id = (
        await workspaces.createMember(admin.token, {
          email: 'preserved@example.test',
          fullName: 'Preserved',
          password,
        })
      ).id;
      await workspaces.editMember(admin.token, id, {
        grants: [
          { deviceId: device.id, channels: [1], view: true, record: false, download: false },
        ],
      });
      let member = await auth.login({ email: 'preserved@example.test', password });
      member = await auth.changePassword(member.token, {
        currentPassword: password,
        newPassword: 'preserved-member-password-42',
      });
      await cameras.preferences(member.token, { favourites: ['member-camera'] });
      expire();
      await worker().run(admin.principal.tenantId);
      assert.equal((await auth.principal(member.token)).role, 'member');
      assert.deepEqual((await cameras.preferences(member.token)).favourites, ['member-camera']);
      assert.equal((await cameras.devices(member.token)).devices[0].channels[0].canRecord, false);
    },
  );
  await t.test(
    'known web expiry can recover from encrypted opt-in without a failing camera request',
    async () => {
      await seed({ webExpiresAt: Date.now() - 1 });
      assert.equal(await worker().run(admin.principal.tenantId), true);
      assert.equal(calls.login, 1);
      assert.equal((await load()).sessionId, 'web-renewed');
    },
  );
  await t.test(
    'concurrent workers share one database lease and one password submission',
    async () => {
      await seed({ needsReconnect: true });
      let release, entered;
      const started = new Promise((resolve) => (entered = resolve)),
        gate = new Promise((resolve) => (release = resolve));
      hooks.login = async () => {
        entered();
        await gate;
        return {
          credentials: {
            sessionId: 'new-web',
            accountUserId: 'account-a',
            origin: 'https://iindia.hik-connect.com',
          },
        };
      };
      const first = worker().run(admin.principal.tenantId);
      await started;
      const second = await worker().run(admin.principal.tenantId);
      assert.equal(second, false);
      assert.equal(calls.login, 1);
      release();
      assert.equal(await first, true);
      assert.equal(calls.login, 1);
    },
  );
  await t.test(
    'outages back off durably and a new worker cannot bypass the retry time',
    async () => {
      await seed();
      hooks.devices = () => {
        throw new HikError('Unavailable', 502, 'provider-unavailable');
      };
      await worker().run(admin.principal.tenantId);
      const failed = await load();
      assert.equal(failed.needsReconnect, undefined);
      assert.ok(failed.recovery.web.nextRetryAt > now);
      assert.equal(calls.login, 0);
      const attempts = calls.devices;
      await worker().run(admin.principal.tenantId);
      assert.equal(calls.devices, attempts);
      now = failed.recovery.web.nextRetryAt + 1;
      await worker().run(admin.principal.tenantId);
      assert.equal(calls.devices, attempts + 1);
      assert.ok((await load()).recovery.web.nextRetryAt > now);
    },
  );
  await t.test('rejected passwords or verification challenges stop login retry loops', async () => {
    await seed({ needsReconnect: true });
    hooks.login = () => {
      throw new PortalError('Verification required', { code: 1011 });
    };
    await worker().run(admin.principal.tenantId);
    assert.equal((await load()).recovery.web.blocked, 'sign-in-required');
    now += 3600000;
    await worker().run(admin.principal.tenantId, { force: true });
    assert.equal(calls.login, 1);
    assert.equal((await auth.principal(admin.token)).role, 'admin');
  });
  await t.test('web access denial is not treated as an expired password', async () => {
    await seed();
    hooks.devices = () => {
      throw new HikError('Forbidden', 403, 'provider-access-denied');
    };
    await worker().run(admin.principal.tenantId);
    assert.equal(calls.login, 0);
    assert.equal((await load()).recovery.web.blocked, 'access-denied');
    assert.equal((await load()).sessionId, 'web-old');
  });
  await t.test(
    'provider rate limits schedule recovery without marking the password invalid',
    async () => {
      await seed({ needsReconnect: true });
      hooks.login = () => {
        throw new PortalError('Rate limited', { status: 429 });
      };
      await worker().run(admin.principal.tenantId);
      const p = await load();
      assert.equal(p.recovery.web.blocked, null);
      assert.ok(p.recovery.web.nextRetryAt > now);
      await worker().run(admin.principal.tenantId, { force: true });
      assert.equal(calls.login, 1);
    },
  );
  await t.test(
    'accounts without opt-in never store a password or submit automatic login',
    async () => {
      await seed({ recovery: { webEnabled: false, playbackEnabled: false }, needsReconnect: true });
      await worker().run(admin.principal.tenantId);
      assert.equal(calls.login, 0);
      assert.equal((await load()).recovery.secret, undefined);
      assert.equal((await load()).recovery.web.blocked, 'sign-in-required');
    },
  );
  await t.test('a successful login for the wrong provider account is rejected', async () => {
    const before = await seed({ needsReconnect: true });
    hooks.login = () => ({
      credentials: {
        sessionId: 'wrong-web',
        accountUserId: 'account-b',
        origin: 'https://iindia.hik-connect.com',
      },
    });
    await worker().run(admin.principal.tenantId);
    const after = await load();
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.accountUserId, 'account-a');
    assert.equal(after.recovery.web.blocked, 'account-mismatch');
    assert.equal(recovered.length, 0);
  });
  await t.test(
    'disconnect wins over an in-flight renewal without resurrecting credentials',
    async () => {
      await seed({ needsReconnect: true });
      let release, entered;
      const started = new Promise((resolve) => (entered = resolve)),
        gate = new Promise((resolve) => (release = resolve));
      hooks.login = async () => {
        entered();
        await gate;
        return {
          credentials: {
            sessionId: 'late-web',
            accountUserId: 'account-a',
            origin: 'https://iindia.hik-connect.com',
          },
        };
      };
      const job = worker().run(admin.principal.tenantId);
      await started;
      await cameras.saveProvider(admin.token, null, await load());
      release();
      assert.equal(await job, false);
      assert.equal(await load(), null);
      assert.equal(recovered.length, 0);
    },
  );
  await t.test('disabling recovery removes secrets and cancels an in-flight update', async () => {
    await seed({ needsReconnect: true });
    let release, entered;
    const started = new Promise((resolve) => (entered = resolve)),
      gate = new Promise((resolve) => (release = resolve));
    hooks.login = async () => {
      entered();
      await gate;
      return {
        credentials: {
          sessionId: 'late-web',
          accountUserId: 'account-a',
          origin: 'https://iindia.hik-connect.com',
        },
      };
    };
    const job = worker().run(admin.principal.tenantId);
    await started;
    await cameras.disableRecovery(admin.token);
    release();
    assert.equal(await job, false);
    const after = await load();
    assert.equal(after.recovery.secret, undefined);
    assert.equal(after.recovery.webEnabled, false);
    assert.equal(after.sessionId, 'web-old');
  });
  await t.test(
    'a new account wins over an old renewal response and keeps separate layouts',
    async () => {
      await seed({ needsReconnect: true });
      let release, entered;
      const started = new Promise((resolve) => (entered = resolve)),
        gate = new Promise((resolve) => (release = resolve));
      hooks.login = async (input) => {
        if (input.account === 'new-account')
          return {
            credentials: {
              sessionId: 'account-b-web',
              accountUserId: 'account-b',
              origin: 'https://iindia.hik-connect.com',
            },
          };
        entered();
        await gate;
        return {
          credentials: {
            sessionId: 'late-web',
            accountUserId: 'account-a',
            origin: 'https://iindia.hik-connect.com',
          },
        };
      };
      const job = worker().run(admin.principal.tenantId);
      await started;
      await cameras.connect(admin.token, {
        account: 'new-account',
        password: 'new-provider-password',
      });
      release();
      await job;
      const after = await load();
      assert.equal(after.accountUserId, 'account-b');
      assert.equal(after.recovery.secret, undefined);
      assert.equal(after.sdkAccessToken, undefined);
      assert.deepEqual(await cameras.preferences(admin.token), {});
    },
  );
  await t.test(
    'updated installed-client playback tokens are verified before being saved',
    async () => {
      const before = await seed({
        sdkExpiresAt: Date.now() - 1,
        recovery: { webEnabled: false, playbackEnabled: true, web: {}, playback: {} },
      });
      hooks.verify = (token, d, channel) => {
        assert.equal(token, 'updated-sdk-grant');
        assert.equal(d.serial, device.serial);
        assert.equal(channel, 1);
        return { validatedAt: now };
      };
      assert.equal(await worker().run(admin.principal.tenantId), true);
      const after = await load();
      assert.equal(after.sdkAccessToken, 'updated-sdk-grant');
      assert.equal(after.sdkSource, 'installed-client');
      assert.equal(after.sdkExpiresAt, null);
      assert.equal(after.playbackNeedsReconnect, false);
      assert.equal(providerConnectionId(before), providerConnectionId(after));
    },
  );
  await t.test(
    'rejected SDK candidates never replace grants and unchanged candidates are not hammered',
    async () => {
      await seed({
        sdkExpiresAt: Date.now() - 1,
        recovery: { webEnabled: false, playbackEnabled: true, web: {}, playback: {} },
      });
      hooks.verify = () => {
        throw Error('Candidate not authorized');
      };
      await worker().run(admin.principal.tenantId);
      assert.equal((await load()).sdkAccessToken, 'sdk-old');
      assert.equal((await load()).playbackNeedsReconnect, true);
      assert.equal(calls.verify, 1);
      now += 120000;
      await worker().run(admin.principal.tenantId);
      assert.equal(calls.verify, 1);
      hooks.desktop = () => 'different-updated-grant';
      hooks.verify = () => ({ validatedAt: now });
      now += 120000;
      await worker().run(admin.principal.tenantId);
      assert.equal((await load()).sdkAccessToken, 'different-updated-grant');
      assert.equal((await load()).playbackNeedsReconnect, false);
    },
  );
  await t.test('checking the same SDK token never erases its known expiry', async () => {
    const expires = Date.now() + 30000;
    await seed({
      sdkExpiresAt: expires,
      recovery: { webEnabled: false, playbackEnabled: true, web: {}, playback: {} },
    });
    hooks.desktop = () => 'sdk-old';
    await worker().run(admin.principal.tenantId);
    assert.equal((await load()).sdkExpiresAt, expires);
    now = expires + 1;
    await worker().run(admin.principal.tenantId, { force: true });
    assert.equal((await load()).sdkExpiresAt, expires);
    assert.equal((await load()).recovery.playback.blocked, 'playback-sign-in-required');
  });
  await t.test('native playback failures cannot hammer SDK checks or web discovery', async () => {
    await seed({ recovery: { webEnabled: false, playbackEnabled: true, web: {}, playback: {} } });
    await worker().run(admin.principal.tenantId, { playbackCheck: true });
    const first = { ...calls };
    await worker().run(admin.principal.tenantId, { playbackCheck: true });
    assert.equal(calls.verify, first.verify);
    assert.equal(calls.devices, first.devices);
    assert.equal(calls.sharing, first.sharing);
  });
  await t.test(
    'Linux reports missing playback without reading a Windows client or inventing renewal',
    async () => {
      await seed({
        sdkExpiresAt: Date.now() - 1,
        recovery: { webEnabled: false, playbackEnabled: true, web: {}, playback: {} },
      });
      await worker({ platform: 'linux' }).run(admin.principal.tenantId);
      assert.equal(calls.desktop, 0);
      assert.equal(calls.verify, 0);
      assert.equal((await cameras.status(admin.token)).sdkConnected, false);
    },
  );
  await t.test('expired worker leases can be reclaimed after a process interruption', async () => {
    await seed({
      needsReconnect: true,
      recovery: {
        webEnabled: true,
        secret: {
          account: 'fixture',
          password: 'synthetic-provider-password',
          origin: 'https://iindia.hik-connect.com',
        },
        lease: { id: 'old-process', until: now + 120000 },
        web: {},
        playback: {},
      },
    });
    assert.equal(await worker().run(admin.principal.tenantId), false);
    assert.equal(calls.login, 0);
    now += 180000;
    assert.equal(await worker().run(admin.principal.tenantId), true);
    assert.equal(calls.login, 1);
    assert.equal((await load()).recovery.lease, undefined);
  });
  await t.test(
    'background discovery removes revoked cameras and closes their active feeds',
    async () => {
      await seed();
      const hub = new MediaHub(auth, cameras, {
        createLive: (_p, d, channel) => ({
          deviceId: d.id,
          channel,
          state: 'playing',
          ready: Promise.resolve({ state: 'playing' }),
          status() {
            return { state: this.state };
          },
          stop() {
            this.state = 'stopped';
          },
        }),
      });
      try {
        await hub.start(admin.token, admin.principal, {
          deviceId: device.id,
          channel: 1,
          quality: 'sd',
        });
        hooks.sharing = () => ({ devices: [] });
        await worker().run(admin.principal.tenantId);
        await hub.reap();
        assert.equal(hub.viewer(admin.token, admin.principal).states()[0].state, 'stopped');
        assert.equal((await cameras.devices(admin.token, false)).devices.length, 0);
      } finally {
        hub.close();
      }
    },
  );
  await t.test('the worker can recover without an active admin browser session', async () => {
    await seed({ needsReconnect: true });
    await auth.logout(admin.token);
    assert.equal(await worker().run(admin.principal.tenantId), true);
    const next = await auth.login({ email: 'alpha@example.test', password });
    admin.token = next.token;
    assert.equal((await load()).sessionId, 'web-renewed');
  });
  await t.test(
    'suspended workspaces do not run background logins and another workspace is untouched',
    async () => {
      await seed({ needsReconnect: true });
      const request = (await workspaces.platform(root.token)).workspaces.find(
        (w) => w.email === 'alpha@example.test',
      );
      await workspaces.decide(root.token, request.id, 'suspend');
      assert.equal(await worker().run(admin.principal.tenantId), false);
      assert.equal(calls.login, 0);
      assert.equal((await auth.principal(other.token)).role, 'admin');
    },
  );
});
