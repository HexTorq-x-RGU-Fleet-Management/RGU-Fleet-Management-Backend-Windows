import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { postgresFixture } from './helpers.mjs';
import { Cameras } from '../lib/cameras.mjs';
import { MediaHub } from '../lib/media.mjs';
import { TenantStorage } from '../lib/storage.mjs';
import { HealthMonitor, healthKey } from '../lib/health.mjs';
import { createSaas } from '../server.mjs';
import { tokenHash } from '../lib/auth.mjs';
import { LiveError } from '../vendor/windows-sdk/lib/live.mjs';
test('superadmin-only monitoring tracks failure, recovery, storage pressure and server incidents', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t),
    password = 'synthetic-password-42';
  const directory = await mkdtemp(path.join(tmpdir(), 'saas-health-test-')),
    storage = await new TenantStorage(directory, db).open();
  let failStart = true,
    failDevices = false,
    lastLive,
    freeBytes = 10 * 1024 ** 3,
    diskCalls = 0;
  const cameras = new Cameras(db, cipher, {
    personal: async () => ({
      credentials: {
        sessionId: 'private-session-token',
        sdkAccessToken: 'private-sdk-token',
        sdkExpiresAt: Date.now() + 3600000,
        accountUserId: 'fixture',
        origin: 'https://iindia.hik-connect.com',
      },
    }),
    hik: {
      devices: async () => {
        if (failDevices) throw Error('private-password private-sdk-token C:/private/server-path');
        return [];
      },
      sharing: async () => ({
        devices: [
          {
            id: 'private-camera-serial',
            serial: 'private-camera-serial',
            name: 'Test recorder',
            status: 'online',
            channels: [{ number: 1, name: 'Gate' }],
          },
        ],
      }),
    },
  });
  const hub = new MediaHub(auth, cameras, {
    createLive: (_p, d, channel) => {
      const live = (lastLive = new EventEmitter());
      Object.assign(live, {
        deviceId: d.id,
        channel,
        state: failStart ? 'failed' : 'playing',
        errorCode: failStart ? 'stream-timeout' : null,
        ready: failStart
          ? Promise.reject(new LiveError('private-password', 502, 'stream-timeout'))
          : Promise.resolve({ state: 'playing' }),
        status() {
          return { state: this.state, deviceId: this.deviceId, channel: this.channel };
        },
        stop() {
          if (this.state === 'stopped') return;
          this.state = 'stopped';
          this.emit('ended');
        },
      });
      live.ready.catch(() => {});
      return live;
    },
  });
  const health = new HealthMonitor(db, {
    storage,
    hub,
    disk: async () => {
      diskCalls++;
      return freeBytes;
    },
  });
  const { server } = createSaas({
    db,
    auth,
    workspaces,
    cipher,
    cameras,
    hub,
    storage,
    health,
    rateLimit: 100,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await health.drain();
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (route, { token, data } = {}) => {
    const r = await fetch(base + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Cookie: 'hik_saas=' + token } : {}),
        ...(data === undefined ? {} : { 'X-Hik-Local': '1', 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: r.status, body: await r.json() };
  };
  const root = await auth.bootstrap({ email: 'root@example.test', fullName: 'Owner', password });
  await auth.signup({
    email: 'admin@example.test',
    fullName: 'Admin',
    workspaceName: 'Monitored Workspace',
    password,
  });
  const request = (await workspaces.platform(root.token)).workspaces[0];
  await workspaces.decide(root.token, request.id, 'approve');
  const admin = await auth.login({ email: 'admin@example.test', password });
  await cameras.connect(admin.token, { account: 'fixture', password: 'provider-password' });
  await cameras.devices(admin.token);
  await workspaces.createMember(admin.token, {
    email: 'member@example.test',
    fullName: 'Member',
    password,
  });
  let member = await auth.login({ email: 'member@example.test', password });
  member = await auth.changePassword(member.token, {
    currentPassword: password,
    newPassword: 'member-new-password-42',
  });
  const snapshot = async (query) =>
    (await call('/api/platform/health' + (query || ''), { token: root.token })).body;
  const start = () =>
    call('/api/live/start', {
      token: admin.token,
      data: { deviceId: 'private-camera-serial', channel: 1, slot: 0, quality: 'sd' },
    });
  await t.test(
    'ordinary users cannot read global health, trigger scans, acknowledge or resolve alerts',
    async () => {
      assert.equal((await call('/api/platform/health')).status, 401);
      for (const actor of [admin, member]) {
        assert.equal(
          (await call('/api/platform/health?fresh=1', { token: actor.token })).status,
          403,
        );
        for (const action of ['acknowledge', 'resolve'])
          assert.equal(
            (
              await call('/api/platform/health/00000000-0000-4000-8000-000000000001/' + action, {
                token: actor.token,
                data: {},
              })
            ).status,
            403,
          );
        const rows = await db.session(tokenHash(actor.token), (c) =>
          c.query('SELECT id FROM cam.health_alerts'),
        );
        assert.equal(rows.rowCount, 0);
      }
      assert.equal(diskCalls, 0);
    },
  );
  let streamId;
  await t.test(
    'failed playback creates a redacted workspace alert and retries deduplicate it',
    async () => {
      assert.equal((await start()).status, 502);
      let model = await snapshot();
      const first = model.alerts.find((a) => a.kind === 'stream');
      assert.ok(first);
      streamId = first.id;
      assert.equal(first.workspace, 'Monitored Workspace');
      assert.equal(first.recorder, 'Test recorder');
      assert.equal(first.channel, 1);
      assert.equal(first.observations, 1);
      assert.equal((await start()).status, 502);
      model = await snapshot();
      assert.equal(model.alerts.filter((a) => a.kind === 'stream').length, 1);
      assert.equal(model.alerts.find((a) => a.id === streamId).observations, 2);
      for (const secret of [
        'private-session-token',
        'private-sdk-token',
        'private-password',
        'private-camera-serial',
        'C:/private/server-path',
      ])
        assert.equal(JSON.stringify(model).includes(secret), false);
    },
  );
  await t.test(
    'acknowledging does not hide an active failure or get undone by another retry',
    async () => {
      assert.equal(
        (
          await call(`/api/platform/health/${streamId}/acknowledge`, {
            token: root.token,
            data: {},
          })
        ).status,
        200,
      );
      await start();
      const model = await snapshot();
      assert.ok(model.alerts.find((a) => a.id === streamId).acknowledgedAt);
      assert.equal(model.counts.active, 1);
      assert.equal(model.counts.unacknowledged, 0);
    },
  );
  await t.test(
    'successful playback resolves a failure, later failures reopen it, and manual stop clears it',
    async () => {
      failStart = false;
      assert.equal((await start()).status, 200);
      let model = await snapshot('?state=resolved');
      assert.ok(model.alerts.find((a) => a.id === streamId).resolvedAt);
      lastLive.state = 'failed';
      lastLive.errorCode = 'decode-failed';
      lastLive.emit('ended');
      await health.drain();
      model = await snapshot();
      assert.equal(model.alerts.find((a) => a.id === streamId).acknowledgedAt, null);
      await call('/api/live/stop-all', { token: admin.token, data: {} });
      await health.drain();
      model = await snapshot('?state=resolved');
      assert.equal(model.alerts.find((a) => a.id === streamId).resolution, 'playback-stopped');
    },
  );
  await t.test(
    'recording disk alerts escalate and clear only after sufficient free space returns',
    async () => {
      freeBytes = 1024 ** 3;
      await health.sample();
      let model = await snapshot();
      assert.equal(model.alerts.find((a) => a.title.includes('disk')).severity, 'warning');
      const id = model.alerts.find((a) => a.title.includes('disk')).id;
      await health.acknowledge(root.token, id);
      freeBytes = 100 * 1024 ** 2;
      await health.sample();
      model = await snapshot();
      assert.equal(model.alerts.find((a) => a.id === id).severity, 'critical');
      assert.equal(model.alerts.find((a) => a.id === id).acknowledgedAt, null);
      freeBytes = 2.2 * 1024 ** 3;
      await health.sample();
      assert.ok((await snapshot()).alerts.find((a) => a.id === id));
      freeBytes = 4 * 1024 ** 3;
      await health.sample();
      assert.equal(
        (await snapshot('?state=resolved')).alerts.find((a) => a.id === id).resolution,
        'storage-recovered',
      );
    },
  );
  await t.test(
    'an unreadable storage probe is shown as unavailable rather than healthy free space',
    async () => {
      const original = health.disk;
      health.disk = async () => null;
      try {
        await health.sample();
        const model = await snapshot();
        assert.equal(model.metrics.recordingStorage.maxBytes, 10 * 1024 ** 3);
        assert.ok(model.alerts.some((a) => a.title === 'Recording storage could not be checked'));
      } finally {
        health.disk = original;
        await health.sample();
      }
    },
  );
  await t.test('workspace recording usage is observed without changing policy limits', async () => {
    let usage = 99;
    const limit = 1024 ** 3;
    health.storage = {
      directory,
      stores: new Map([
        [
          admin.principal.tenantId,
          Promise.resolve({
            summary: async () => ({ usedBytes: (limit * usage) / 100, maxBytes: limit }),
          }),
        ],
      ]),
    };
    await health.sample();
    let model = await snapshot();
    const alert = model.alerts.find((a) => a.title.includes('nearly full'));
    assert.equal(alert.severity, 'critical');
    assert.equal(model.storage[0].maxBytes, limit);
    usage = 80;
    await health.sample();
    model = await snapshot('?state=resolved');
    assert.equal(model.alerts.find((a) => a.id === alert.id).resolution, 'storage-recovered');
    health.storage = storage;
  });
  await t.test(
    'server errors produce safe component alerts that only superadmin can resolve',
    async () => {
      failDevices = true;
      assert.equal((await call('/api/devices', { token: admin.token })).status, 500);
      let model = await snapshot('?kind=server');
      const incident = model.alerts.find((a) => a.details.component === 'Device discovery');
      assert.ok(incident);
      assert.equal(incident.severity, 'critical');
      assert.equal(incident.workspace, 'Monitored Workspace');
      assert.equal(JSON.stringify(model).includes('private-password'), false);
      assert.equal(JSON.stringify(model).includes('server-path'), false);
      assert.equal(
        (
          await call(`/api/platform/health/${incident.id}/resolve`, {
            token: admin.token,
            data: {},
          })
        ).status,
        403,
      );
      failDevices = false;
      assert.equal(
        (await call(`/api/platform/health/${incident.id}/resolve`, { token: root.token, data: {} }))
          .status,
        200,
      );
      model = await snapshot('?state=resolved&kind=server');
      assert.equal(model.alerts.find((a) => a.id === incident.id).resolution, 'manually-resolved');
    },
  );
  await t.test(
    'alerts survive a monitor restart and same-key updates do not create a flood',
    async () => {
      await health.report('persistent-test', { code: 'server-request-failed' });
      const again = new HealthMonitor(db, { storage, hub, disk: async () => freeBytes });
      const before = (await again.snapshot(root.token)).alerts.find(
        (a) => a.title === 'Server request failed',
      );
      assert.ok(before);
      for (let i = 0; i < 5; i++)
        await again.report('persistent-test', { code: 'server-request-failed' });
      const row = await db.session(
        tokenHash(root.token),
        async (c) =>
          (
            await c.query('SELECT occurrences FROM cam.health_alerts WHERE alert_key=$1', [
              healthKey('persistent-test'),
            ])
          ).rows[0],
      );
      assert.equal(row.occurrences, 6);
    },
  );
  await t.test(
    'monitor persistence failures are bounded, retried and cannot reject a viewer request',
    async () => {
      let unavailable = true,
        now = Date.now();
      const adapter = {
        ...db,
        pool: {
          query: (...args) => {
            if (unavailable) return Promise.reject(Error('secret database failure'));
            return db.pool.query(...args);
          },
        },
        session: db.session.bind(db),
      };
      const fallback = new HealthMonitor(adapter, {
        storage,
        hub,
        now: () => now,
        disk: async () => freeBytes,
      });
      assert.equal(
        await fallback.report('pending-save', {
          code: 'server-request-failed',
          details: { password: 'private-password' },
        }),
        false,
      );
      assert.equal(fallback.fallback.size, 1);
      unavailable = false;
      now += 31000;
      await fallback.sample();
      assert.equal(fallback.fallback.size, 0);
      const model = await fallback.snapshot(root.token);
      assert.equal(model.persistenceAvailable, true);
      assert.equal(JSON.stringify(model).includes('private-password'), false);
    },
  );
  await t.test(
    'filters reject invalid values and storage alerts cannot be manually marked healthy',
    async () => {
      assert.equal(
        (await call('/api/platform/health?state=bad', { token: root.token })).status,
        400,
      );
      await health.report('active-storage', {
        code: 'storage-usage',
        tenantId: admin.principal.tenantId,
      });
      const model = await snapshot('?kind=storage'),
        id = model.alerts[0].id;
      assert.equal(
        (await call(`/api/platform/health/${id}/resolve`, { token: root.token, data: {} })).status,
        404,
      );
      const rows = await db.session(tokenHash(admin.token), (c) =>
        c.query('UPDATE cam.health_alerts SET acknowledged_at=now()'),
      );
      assert.equal(rows.rowCount, 0);
    },
  );
});
test('in-memory monitoring fallback is bounded during a sustained database outage', async () => {
  let attempts = 0;
  const monitor = new HealthMonitor(
    {
      pool: {
        query: async () => {
          attempts++;
          throw Error('Unavailable');
        },
      },
    },
    { storage: { directory: '.', stores: new Map() }, hub: { viewers: new Map() } },
  );
  for (let i = 0; i < 250; i++)
    assert.equal(await monitor.report('failure-' + i, { code: 'server-request-failed' }), false);
  await monitor.drain();
  assert.equal(monitor.fallback.size, 200);
  assert.equal(monitor.resources.size, 0);
  assert.equal(attempts, 1);
});
