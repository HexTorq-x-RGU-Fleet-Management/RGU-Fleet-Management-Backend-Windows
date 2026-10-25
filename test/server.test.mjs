import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { postgresFixture } from './helpers.mjs';
import { Cameras } from '../lib/cameras.mjs';
import { TenantStorage } from '../lib/storage.mjs';
import { MediaHub } from '../lib/media.mjs';
import { createSaas } from '../server.mjs';
import { PortalError } from '../vendor/windows-sdk/lib/personal-client.mjs';

test('HTTP SaaS approvals, tenants, camera permissions, recording files and revocation are isolated', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t),
    directory = await mkdtemp(path.join(tmpdir(), 'saas-test-'));
  const cameras = new Cameras(db, cipher, {
    personal: async (input) => {
      if (input.password !== 'synthetic-provider-password')
        throw new PortalError('Synthetic sign-in rejected.');
      return {
        credentials: {
          sessionId: 'web-' + input.account,
          accountUserId: input.account,
          origin: 'https://iindia.hik-connect.com',
          sdkAccessToken: 'sdk-' + input.account,
          sdkExpiresAt: Date.now() + 3600000,
          user: { username: input.account },
        },
      };
    },
    hik: {
      devices: async () => [],
      sharing: async (provider) => ({
        devices: [
          {
            id: 'same-device-id',
            serial: 'private-' + provider.accountUserId,
            name: provider.accountUserId + ' recorder',
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
  const storage = await new TenantStorage(directory, db).open();
  let started = 0,
    stopped = 0;
  const hub = new MediaHub(auth, cameras, {
    createLive: (_provider, device, channel, quality) => {
      started++;
      const live = {
        state: 'playing',
        deviceId: device.id,
        channel,
        quality,
        ready: Promise.resolve({ state: 'playing', deviceId: device.id, channel, quality }),
        status() {
          return { state: this.state, deviceId: this.deviceId, channel, quality };
        },
        stop() {
          stopped++;
          this.state = 'stopped';
        },
      };
      return live;
    },
  });
  const { server } = createSaas({
    db,
    auth,
    workspaces,
    cameras,
    cipher,
    storage,
    hub,
    rateLimit: 100,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (route, { cookie = '', data, headers = {}, raw } = {}) => {
    const response = await fetch(base + route, {
      method: data !== undefined || raw ? 'POST' : 'GET',
      headers: {
        Cookie: cookie,
        ...(data !== undefined || raw
          ? { 'X-Hik-Local': '1', 'Content-Type': 'application/json' }
          : {}),
        ...headers,
      },
      ...(raw ? { body: raw } : data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('json')
        ? await response.json()
        : Buffer.from(await response.arrayBuffer()),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  };
  assert.equal((await call('/')).status, 200);
  assert.equal((await call('/')).body.frontend, 'separate');
  assert.equal((await call('/saas-auth.mjs')).status, 404);
  assert.equal((await call('/server.mjs')).status, 404);
  assert.equal((await call('/db/schema.sql')).status, 404);
  assert.equal((await call('/%2e%2e/server.mjs')).status, 404);
  const password = 'synthetic-password-42';
  assert.equal((await call('/api/team')).status, 401);
  assert.equal(
    (
      await call('/api/auth/setup', {
        data: { email: 'root@example.test', fullName: 'Root', password },
        headers: { Origin: 'https://hostile.invalid' },
      })
    ).status,
    403,
  );
  const root = (
    await call('/api/auth/setup', {
      data: { email: 'root@example.test', fullName: 'Root', password },
    })
  ).cookie;
  assert.ok(root);
  assert.equal(
    (
      await call('/api/auth/setup', {
        data: { email: 'root2@example.test', fullName: 'Root 2', password },
      })
    ).status,
    409,
  );
  for (const name of ['alpha', 'beta'])
    assert.equal(
      (
        await call('/api/auth/signup', {
          data: {
            email: name + '@example.test',
            fullName: name,
            workspaceName: name + ' company',
            password,
            role: 'superadmin',
          },
        })
      ).body.status,
      'pending',
    );
  assert.equal(
    (await call('/api/auth/login', { data: { email: 'alpha@example.test', password } })).body.code,
    'approval-pending',
  );
  const requests = (await call('/api/platform/workspaces', { cookie: root })).body.workspaces,
    alpha = requests.find((u) => u.email === 'alpha@example.test'),
    beta = requests.find((u) => u.email === 'beta@example.test');
  for (const user of [alpha, beta])
    assert.equal(
      (await call(`/api/platform/requests/${user.id}/approve`, { cookie: root, data: {} })).status,
      200,
    );
  const a = (await call('/api/auth/login', { data: { email: alpha.email, password } })).cookie,
    b = (await call('/api/auth/login', { data: { email: beta.email, password } })).cookie;
  assert.equal((await call('/api/platform/workspaces', { cookie: a })).status, 403);
  assert.equal(
    (
      await call('/api/connect/personal', {
        cookie: root,
        data: { account: 'alpha', password: 'synthetic-provider-password' },
      })
    ).status,
    403,
  );
  for (const [cookie, name] of [
    [a, 'alpha'],
    [b, 'beta'],
  ])
    assert.equal(
      (
        await call('/api/connect/personal', {
          cookie,
          data: { account: name, password: 'synthetic-provider-password' },
        })
      ).status,
      200,
    );
  const ad = (await call('/api/devices', { cookie: a })).body.devices,
    bd = (await call('/api/devices', { cookie: b })).body.devices;
  assert.equal(ad[0].name, 'alpha recorder');
  assert.equal(bd[0].name, 'beta recorder');
  assert.equal(ad[0].serial, undefined);
  const member = (
    await call('/api/team', {
      cookie: a,
      data: {
        email: 'member@example.test',
        fullName: 'A member',
        password,
        role: 'admin',
        tenantId: beta.tenantId,
      },
    })
  ).body;
  const first = (
    await call('/api/auth/login', { data: { email: 'member@example.test', password } })
  ).cookie;
  assert.equal(
    (await call('/api/devices', { cookie: first })).body.code,
    'password-change-required',
  );
  const memberPassword = 'member-private-password-42';
  let m = (
    await call('/api/auth/password', {
      cookie: first,
      data: { currentPassword: password, newPassword: memberPassword },
    })
  ).cookie;
  assert.equal((await call('/api/team', { cookie: m })).status, 403);
  assert.equal(
    (
      await call('/api/connect/personal', {
        cookie: m,
        data: { account: 'alpha', password: 'synthetic-provider-password' },
      })
    ).status,
    403,
  );
  for (const route of ['/api/provider/recovery/retry', '/api/provider/recovery/disable']) {
    for (const cookie of [m, root])
      assert.equal((await call(route, { cookie, data: {} })).status, 403);
  }
  assert.equal(
    (await call('/api/team/' + member.id, { cookie: b, data: { status: 'suspended' } })).status,
    404,
  );
  assert.equal(
    (
      await call('/api/team/' + member.id, {
        cookie: a,
        data: {
          grants: [
            {
              deviceId: 'same-device-id',
              view: true,
              record: true,
              download: false,
              channels: [1],
            },
          ],
        },
      })
    ).status,
    200,
  );
  assert.equal((await call('/api/status', { cookie: m })).status, 401);
  m = (
    await call('/api/auth/login', {
      data: { email: 'member@example.test', password: memberPassword },
    })
  ).cookie;
  const md = (await call('/api/devices', { cookie: m })).body.devices;
  assert.deepEqual(
    md[0].channels.map((c) => c.number),
    [1],
  );
  assert.equal(md[0].channels[0].canDownload, false);
  assert.equal(
    (
      await call('/api/live/start', {
        cookie: m,
        data: { deviceId: 'same-device-id', channel: 2, quality: 'sd', slot: 0 },
      })
    ).status,
    403,
  );
  for (const cookie of [a, b, m])
    assert.equal(
      (
        await call('/api/live/start', {
          cookie,
          data: {
            deviceId: 'same-device-id',
            channel: 1,
            quality: 'sd',
            slot: 0,
            tenantId: beta.tenantId,
          },
        })
      ).status,
      200,
    );
  assert.equal(started, 3);
  await call('/api/live/stop-all', { cookie: b, data: { tenantId: alpha.tenantId } });
  assert.equal((await call('/api/live/status?all=1', { cookie: a })).body[0].state, 'playing');
  assert.equal((await call('/api/live/status?all=1', { cookie: m })).body[0].state, 'playing');
  assert.equal(
    (await call('/api/status', { cookie: a, headers: { 'X-Saas-User': member.id } })).status,
    401,
  );
  const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)]),
    id = randomUUID();
  const uploaded = await call('/api/recordings', {
    cookie: m,
    raw: bytes,
    headers: {
      'Content-Type': 'video/webm',
      'X-Recording-Id': id,
      'X-Recording-Meta': encodeURIComponent(
        JSON.stringify({
          deviceId: 'same-device-id',
          channel: 1,
          cameraName: 'forged name',
          recorderName: 'other tenant',
          tenantId: beta.tenantId,
          duration: 1000,
          audio: false,
        }),
      ),
    },
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.clip.recorderName, 'alpha recorder');
  assert.equal(uploaded.body.clip.canDownload, false);
  assert.equal(uploaded.body.storage, null);
  const video = uploaded.body.clip.url;
  assert.equal((await call(video, { cookie: b })).status, 404);
  assert.equal((await call(video, { cookie: root })).status, 403);
  assert.equal((await call(video, { cookie: m, headers: { Range: 'bytes=0-3' } })).status, 206);
  assert.equal((await call(video + '?download=1', { cookie: m })).status, 403);
  assert.equal((await call(`/api/recordings/${id}/delete`, { cookie: m, data: {} })).status, 403);
  assert.equal(
    (
      await call('/api/recordings/settings', {
        cookie: m,
        data: { retentionDays: 1, maxBytes: 1073741824 },
      })
    ).status,
    403,
  );
  assert.equal((await call('/api/recordings', { cookie: b })).body.clips.length, 0);
  const reopenedStorage = await new TenantStorage(directory, db).open();
  const memberToken = m.split('=')[1],
    betaToken = b.split('=')[1];
  const persisted = await reopenedStorage.list(memberToken, await auth.principal(memberToken));
  assert.equal(persisted.clips[0].id, id);
  assert.equal(persisted.clips[0].deviceId, 'same-device-id');
  assert.equal(persisted.clips[0].channel, 1);
  assert.equal(persisted.clips[0].createdBy, member.id);
  assert.equal(persisted.clips[0].canDownload, false);
  assert.equal(
    (await reopenedStorage.list(betaToken, await auth.principal(betaToken))).clips.length,
    0,
  );
  await call('/api/preferences', {
    cookie: a,
    data: { favourites: ['alpha-only'], tenantId: beta.tenantId },
  });
  for (const invalid of [
    { layouts: [{ name: 'bad', grid: 99, cameras: [] }] },
    { layouts: [{ name: 'missing cameras', grid: 4, cameras: [] }] },
    { favourites: 'invalid' },
  ]) {
    const rejected = await call('/api/preferences', { cookie: a, data: invalid });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.code, 'invalid-preferences');
  }
  assert.deepEqual((await call('/api/preferences', { cookie: a })).body.favourites, ['alpha-only']);
  assert.deepEqual((await call('/api/preferences', { cookie: b })).body, {});
  await call('/api/team/' + member.id, { cookie: a, data: { status: 'suspended' } });
  assert.equal((await call('/api/status', { cookie: m })).status, 401);
  assert.ok(stopped >= 2);
  assert.equal((await call('/api/live/status?all=1', { cookie: a })).body[0].state, 'playing');
  await call('/api/team/' + member.id, { cookie: a, data: { status: 'active' } });
  m = (
    await call('/api/auth/login', {
      data: { email: 'member@example.test', password: memberPassword },
    })
  ).cookie;
  await call('/api/connect/personal', {
    cookie: a,
    data: { account: 'gamma', password: 'synthetic-provider-password' },
  });
  await call('/api/devices', { cookie: a });
  assert.equal((await call('/api/status', { cookie: m })).status, 401);
  m = (
    await call('/api/auth/login', {
      data: { email: 'member@example.test', password: memberPassword },
    })
  ).cookie;
  assert.equal((await call('/api/devices', { cookie: m })).body.devices.length, 0);
  assert.equal((await call('/api/recordings', { cookie: m })).body.clips.length, 0);
  assert.equal((await call('/api/devices', { cookie: b })).body.devices[0].name, 'beta recorder');
  assert.equal((await call('/api/recordings', { cookie: a })).body.clips.length, 1);
  await call(`/api/platform/requests/${alpha.id}/suspend`, { cookie: root, data: {} });
  assert.equal((await call('/api/status', { cookie: a })).status, 401);
  assert.equal((await call('/api/status', { cookie: b })).status, 200);
  const switched = await call('/api/auth/login', {
    cookie: b,
    data: { email: 'root@example.test', password },
  });
  assert.equal(switched.status, 200);
  assert.equal((await call('/api/status', { cookie: b })).status, 401);
});
