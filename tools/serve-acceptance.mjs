// Isolated loopback-only acceptance fixtures. This module is never imported by server.mjs.
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { postgresFixture } from '../test/helpers.mjs';
import { Cameras } from '../lib/cameras.mjs';
import { Fleet } from '../lib/fleet.mjs';
import { ChannelAvailability } from '../lib/workspace-ui.mjs';
import { MediaHub } from '../lib/media.mjs';
import { TenantStorage } from '../lib/storage.mjs';
import { createSaas } from '../server.mjs';
import { tokenHash } from '../lib/auth.mjs';
import { fileURLToPath } from 'node:url';
const cleanup = [],
  t = { after: (fn) => cleanup.push(fn) };
const { db, auth, workspaces, cipher } = await postgresFixture(t);
const media = JSON.parse(
  execFileSync('python', [fileURLToPath(new URL('./acceptance-media.py', import.meta.url))], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 5000000,
  }),
);
class FixtureLive extends EventEmitter {
  constructor(provider, device, channel, quality, options) {
    super();
    Object.assign(this, {
      deviceId: device.id,
      channel,
      quality,
      delivery: options.delivery,
      state: 'playing',
      lastFrameAt: Date.now(),
    });
    this.ready = Promise.resolve(this.status());
    this.timers = new Set();
  }
  status() {
    return {
      state: this.state,
      deviceId: this.deviceId,
      channel: this.channel,
      quality: this.quality,
      width: 320,
      height: 180,
      audioState: 'available',
      audio: true,
      lastFrameAt: this.lastFrameAt,
    };
  }
  watchFrames(fn) {
    let tick = 0;
    const timer = setInterval(() => {
      if (this.state !== 'playing') return;
      this.lastFrameAt = Date.now();
      const p = media.frames[tick % media.frames.length];
      fn(
        this.delivery === 'smooth'
          ? { ...p, timestamp: tick * 100000 }
          : { jpeg: media.jpeg, width: 320, height: 180, displayWidth: 320 },
      );
      tick++;
    }, 100);
    this.timers.add(timer);
    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }
  watchAudio(fn) {
    const timer = setInterval(() => {
      if (this.state === 'playing') fn({ pcm: media.pcm, sampleRate: 16000, samples: 1600 });
    }, 100);
    this.timers.add(timer);
    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }
  async preview() {
    return { jpeg: media.jpeg, width: 320, height: 180, capturedAt: Date.now() };
  }
  stop() {
    this.state = 'stopped';
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
    this.emit('ended');
  }
}
const cameras = new Cameras(db, cipher, {
  personal: async (input) => ({
    credentials: {
      sessionId: 'acceptance-web-session',
      accountUserId: input.account,
      origin: 'https://iindia.hik-connect.com',
      user: { email: input.account },
    },
  }),
  hik: {
    devices: async () => [],
    sharing: async () => ({
      devices: [
        {
          id: 'acceptance-online',
          name: 'Acceptance recorder',
          status: 'online',
          source: 'shared',
          channels: [
            { number: 1, name: 'Front camera' },
            { number: 2, name: 'Rear camera' },
          ],
        },
        {
          id: 'acceptance-offline',
          name: 'Offline acceptance recorder',
          status: 'offline',
          source: 'shared',
          channels: [{ number: 1, name: 'Offline camera' }],
        },
      ],
    }),
  },
  desktopToken: async () => ({
    accessToken: 'acceptance-sdk-token',
    expiresAt: Date.now() + 3600000,
  }),
  verifySdk: async () => ({ valid: true }),
});
const password = 'acceptance-local-only-password-123';
const root = await auth.bootstrap({
  email: 'platform@acceptance.test',
  fullName: 'Acceptance Platform',
  password,
});
for (const name of ['alpha', 'beta', 'pending'])
  await auth.signup({
    email: name + '@acceptance.test',
    fullName: name + ' admin',
    workspaceName: name + ' workspace',
    password,
  });
for (const w of (await workspaces.platform(root.token)).workspaces)
  if (!w.email.startsWith('pending')) await workspaces.decide(root.token, w.id, 'approve');
const alpha = await auth.login({ email: 'alpha@acceptance.test', password }),
  beta = await auth.login({ email: 'beta@acceptance.test', password });
await cameras.connect(alpha.token, {
  account: 'fixture-provider',
  password: 'fixture-provider-password',
});
// Only this explicit fixture server injects a synthetic playback grant.
await db.session(tokenHash(alpha.token), async (c, p) => {
  const row = (await c.query('SELECT payload FROM cam.providers WHERE tenant_id=$1', [p.tenantId]))
    .rows[0];
  const provider = cipher.open(row.payload, p.tenantId);
  provider.sdkAccessToken = 'acceptance-sdk-token';
  provider.sdkExpiresAt = Date.now() + 3600000;
  await c.query('UPDATE cam.providers SET payload=$1 WHERE tenant_id=$2', [
    cipher.seal(provider, p.tenantId),
    p.tenantId,
  ]);
});
await cameras.devices(alpha.token);
const fleet = new Fleet(db),
  bus = (
    await fleet.save(alpha.token, {
      busNumber: 'Acceptance Bus',
      registration: 'TN TEST API',
      driverName: 'Acceptance Driver',
      recorderId: 'acceptance-online',
      telemetryDeviceId: 'acceptance-telemetry',
      favoriteChannels: [1, 2],
    })
  ).bus;
await fleet.pollMock(alpha.token);
await workspaces.createMember(alpha.token, {
  fullName: 'Acceptance Member',
  email: 'member@acceptance.test',
  password,
});
const memberLogin = await auth.login({ email: 'member@acceptance.test', password }),
  memberPassword = password + '-member';
await auth.changePassword(memberLogin.token, {
  currentPassword: password,
  newPassword: memberPassword,
});
await workspaces.editMember(alpha.token, memberLogin.principal.id, {
  grants: [
    { deviceId: 'acceptance-online', channels: [1], view: true, record: false, download: false },
  ],
});
const availability = new ChannelAvailability(db);
for (const channel of [1, 2])
  await availability.observe({
    viewer: tokenHash(alpha.token),
    tenantId: alpha.principal.tenantId,
    deviceId: 'acceptance-online',
    channel,
    ok: true,
  });
const directory = await mkdtemp(path.join(tmpdir(), 'rgu-ui-acceptance-'));
const storage = await new TenantStorage(directory, db).open(),
  hub = new MediaHub(auth, cameras, { createLive: (...args) => new FixtureLive(...args) });
const { server } = createSaas({
  db,
  auth,
  workspaces,
  cameras,
  cipher,
  storage,
  hub,
  frontendOrigins: ['http://127.0.0.1:3117'],
  rateLimit: 1000,
});
const original = server.listeners('request')[0];
server.removeAllListeners('request');
const config = {
  admin: { email: 'alpha@acceptance.test', password },
  platform: { email: 'platform@acceptance.test', password },
  member: { email: 'member@acceptance.test', password: memberPassword },
  beta: { email: 'beta@acceptance.test', password },
  pending: { email: 'pending@acceptance.test', password },
  busId: bus.id,
  memberId: memberLogin.principal.id,
  onlineRecorder: 'acceptance-online',
  offlineRecorder: 'acceptance-offline',
};
server.on('request', (req, res) => {
  if (req.url.startsWith('/__acceptance/tile/')) {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public,max-age=600' });
    res.end(Buffer.from(media.jpeg, 'base64'));
    return;
  }
  if (req.url === '/__acceptance/reset' && req.method === 'POST') {
    void (async () => {
      hub.close();
      await db.session(tokenHash(alpha.token), async (c) => {
        await c.query('DELETE FROM cam.buses WHERE id<>$1', [bus.id]);
        await c.query('UPDATE cam.buses SET favorite_channels=ARRAY[1,2] WHERE id=$1', [bus.id]);
      });
      const store = await storage.store(alpha.principal.tenantId);
      for (const clip of [...store.index.clips]) await store.remove(clip.id);
      for (const channel of [1, 2])
        await availability.observe({
          viewer: tokenHash(alpha.token),
          tenantId: alpha.principal.tenantId,
          deviceId: 'acceptance-online',
          channel,
          ok: true,
        });
      await fleet.pollMock(alpha.token);
      res.writeHead(200);
      res.end('reset');
    })().catch(() => {
      res.writeHead(500);
      res.end('fixture reset failed');
    });
    return;
  }
  if (req.url === '/__acceptance/drop' && req.method === 'POST') {
    hub.closeTenant(alpha.principal.tenantId);
    res.writeHead(200);
    res.end('dropped');
    return;
  }
  if (req.url === '/__acceptance/stop' && req.method === 'POST') {
    res.writeHead(200);
    res.end('stopping');
    setTimeout(() => void close().then(() => process.exit(0)), 20);
    return;
  }
  if (req.url === '/__acceptance/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(config));
    return;
  }
  if (req.url === '/__acceptance/ready') {
    res.writeHead(200);
    res.end('isolated acceptance backend');
    return;
  }
  original(req, res);
});
server.listen(8109, '127.0.0.1');
await once(server, 'listening');
console.log(
  'Isolated acceptance API ready at 127.0.0.1:8109. Synthetic media only; temporary PostgreSQL database.',
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  const target = path.resolve(directory),
    temporaryRoot = path.resolve(tmpdir()) + path.sep;
  if (!target.startsWith(temporaryRoot) || !path.basename(target).startsWith('rgu-ui-acceptance-'))
    throw new Error('Unexpected acceptance cleanup directory.');
  await rm(target, { recursive: true, force: true });
  for (const fn of cleanup.reverse()) await fn();
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => void close().then(() => process.exit(0)));
