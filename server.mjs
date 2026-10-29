import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeConfig } from './lib/config.mjs';
import { httpPolicy, frontendOriginsFromEnv } from './lib/http-policy.mjs';
import { Database, HttpError } from './lib/database.mjs';
import { Fleet } from './lib/fleet.mjs';
import { WorkspaceUi, ChannelAvailability } from './lib/workspace-ui.mjs';
import { Auth, tokenHash } from './lib/auth.mjs';
import { Workspaces } from './lib/workspaces.mjs';
import { Cameras } from './lib/cameras.mjs';
import { ProviderCipher } from './lib/cipher.mjs';
import { MediaHub } from './lib/media.mjs';
import { ProviderRecovery } from './lib/provider-recovery.mjs';
import { AuditLog } from './lib/audit.mjs';
import { HealthMonitor } from './lib/health.mjs';
import { TenantStorage } from './lib/storage.mjs';
import { AccessError, requireAccess, canManageTenant } from './lib/access.mjs';
import { RecordingError } from './lib/recordings.mjs';
import { HikError } from './vendor/windows-sdk/lib/hik-connect.mjs';
import { PortalError } from './vendor/windows-sdk/lib/personal-client.mjs';
import { LiveError } from './vendor/windows-sdk/lib/live.mjs';
import { DesktopSdkError } from './vendor/windows-sdk/lib/desktop-sdk.mjs';
import { slotNumber } from './vendor/windows-sdk/lib/viewer.mjs';
const localHost = (value) => ['localhost', '127.0.0.1', '[::1]'].includes(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const tokenFrom = (req) =>
  /(?:^|;\s*)hik_saas=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
const json = (res, status, value) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new HttpError('The request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new HttpError('Use a valid JSON request.');
  }
}
function tileId(value) {
  try {
    return slotNumber(value ?? 0);
  } catch {
    throw new HttpError('Choose a valid camera tile.');
  }
}
export function createSaas({
  db,
  cipher,
  storage,
  cameras = new Cameras(db, cipher),
  auth = new Auth(db),
  workspaces = new Workspaces(db),
  hub = new MediaHub(auth, cameras),
  health = new HealthMonitor(db, { storage, hub }),
  publicOrigin = null,
  frontendOrigins = [],
  cookieSameSite = 'Strict',
  rateLimit = 12,
} = {}) {
  if (!db || !cipher || !storage)
    throw new Error('Database, provider cipher and scoped recording storage are required.');
  if (
    publicOrigin &&
    (new URL(publicOrigin).origin !== publicOrigin || new URL(publicOrigin).protocol !== 'https:')
  )
    throw new Error('Remote hosting requires an HTTPS PUBLIC_ORIGIN.');
  const policy = httpPolicy({ publicOrigin, frontendOrigins, cookieSameSite });
  const attempts = new Map(),
    connecting = new Set();
  const audit = new AuditLog(db);
  const fleet = new Fleet(db, cipher);
  const wheelseyePoll = fleet.startWheelseyePolling({
    intervalMs: Math.max(5000, Number(process.env.WHEELSEYE_POLL_INTERVAL_MS || 60000)),
  });
  const wheelseyeRetention = setInterval(() => {
    void fleet.cleanupWheelseyeLogs(24).then(() => health.taskRecovered('wheelseye-retention')).catch(() => health.taskFailed('wheelseye-retention'));
  }, 24 * 60 * 60 * 1000);
  wheelseyeRetention.unref();
  const workspaceUi = new WorkspaceUi(db);
  const availability = new ChannelAvailability(db);
  const recovery = new ProviderRecovery(db, cipher, cameras, {
    onRecovered: (id) => hub.closeTenant(id),
  });
  hub.onPlaybackFailure = (id) => {
    void recovery.run(id, { playbackCheck: true }).catch(() => {});
  };
  hub.onStreamHealth = (event) => {
    void health.observeStream(event).catch(() => {});
    void availability.observe(event).catch(() => {});
  };
  const cookie = (res, token) => res.setHeader('Set-Cookie', policy.cookie(token));
  function throttle(req) {
    const key = req.socket.remoteAddress || 'local',
      now = Date.now();
    let value = attempts.get(key);
    if (!value || value.until < now) {
      value = { count: 0, until: now + 60000 };
      attempts.set(key, value);
    }
    if (++value.count > rateLimit)
      throw new HttpError('Too many attempts. Wait one minute and try again.', 429);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    let healthTenant = null;
    try {
      const requestOrigin = 'http://' + (req.headers.host || ''),
        url = new URL(req.url, requestOrigin),
        host = new URL(requestOrigin);
      // Accept both direct API paths and reverse-proxy paths such as /rgu/api/...
      // so the frontend remains compatible with either nginx location style.
      if (url.pathname === '/rgu') url.pathname = '/';
      else if (url.pathname.startsWith('/rgu/')) url.pathname = url.pathname.slice(4);
      if (!localHost(host.hostname) && (!publicOrigin || new URL(publicOrigin).host !== host.host))
        throw new HttpError('Host is not allowed.', 403);
      policy.apply(req, res, requestOrigin);
      if (req.method === 'OPTIONS') {
        if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
        policy.preflight(req, res);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/')
          return json(res, 200, {
            service: 'rgu-fleet-management-backend-windows',
            version: '0.1.0',
            frontend: 'separate',
            health: '/api/health',
          });
        return json(res, 404, { error: 'Not found.' });
      }
      if (
        req.method === 'POST' &&
        (req.headers['x-hik-local'] !== '1' ||
          !(
            req.headers['content-type']?.startsWith('application/json') ||
            (url.pathname === '/api/recordings' &&
              /^video\/(webm|mp4)(?:;|$)/.test(req.headers['content-type'] || ''))
          ))
      )
        throw new HttpError('Use the workspace controls for this action.', 403);
      const token = tokenFrom(req);
      if (url.pathname === '/api/health' && req.method === 'GET')
        return json(res, 200, {
          ok: true,
          app: 'rgu-fleet-management-backend-windows',
          database: 'postgresql',
        });
      if (url.pathname === '/api/auth/status' && req.method === 'GET') {
        let user = null;
        if (token)
          try {
            user = await auth.principal(token);
          } catch (error) {
            if (error.status !== 401) throw error;
          }
        return json(res, 200, {
          authenticated: Boolean(user),
          setupRequired: await auth.setupRequired(),
          user,
        });
      }
      if (
        req.method === 'POST' &&
        [
          '/api/auth/setup',
          '/api/auth/signup',
          '/api/auth/login',
          '/api/auth/google/login',
        ].includes(url.pathname)
      ) {
        throttle(req);
        const input = await body(req);
        try {
          if (url.pathname.endsWith('/signup')) return json(res, 201, await auth.signup(input));
          if (url.pathname.endsWith('/google/login')) {
            const result = await auth.googleLogin(input);
            cookie(res, result.token);
            return json(res, 200, { authenticated: true, user: result.principal });
          }
          if (url.pathname.endsWith('/setup') && (!localHost(host.hostname) || publicOrigin))
            throw new HttpError('Finish initial platform setup locally.', 403);
          const result = await (url.pathname.endsWith('/setup')
            ? auth.bootstrap(input)
            : auth.login(input));
          if (token) {
            await auth.logout(token);
            hub.closeSession(token);
          }
          cookie(res, result.token);
          return json(res, 200, { authenticated: true, user: result.principal });
        } finally {
          delete input.password;
        }
      }
      const principal = await auth.principal(token);
      healthTenant = principal.tenantId;
      const clientUser =
        req.headers['x-saas-user'] ||
        (['/api/live/events', '/api/live/audio-events'].includes(url.pathname) ||
        url.pathname.startsWith('/api/recordings/')
          ? url.searchParams.get('user')
          : null);
      if (clientUser && clientUser !== principal.id)
        throw new HttpError(
          'Your signed-in account changed. Reload this page.',
          401,
          'viewer-auth-required',
        );
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        await auth.logout(token);
        hub.closeSession(token);
        cookie(res, '');
        return json(res, 200, { authenticated: false });
      }
      if (url.pathname === '/api/auth/google/status' && req.method === 'GET')
        return json(res, 200, await auth.googleStatus(token));
      if (url.pathname === '/api/auth/google/link' && req.method === 'POST') {
        const input = await body(req);
        return json(res, 200, await auth.linkGoogle(token, input));
      }
      if (url.pathname === '/api/auth/google/unlink' && req.method === 'POST') {
        return json(res, 200, await auth.unlinkGoogle(token));
      }
      if (url.pathname === '/api/auth/password' && req.method === 'POST') {
        const input = await body(req);
        try {
          const result = await auth.changePassword(token, input);
          hub.closeUser(principal.id);
          cookie(res, result.token);
          return json(res, 200, { changed: true });
        } finally {
          delete input.currentPassword;
          delete input.newPassword;
        }
      }
      if (principal.mustChangePassword)
        throw new HttpError(
          'Change your temporary password before using the workspace.',
          403,
          'password-change-required',
        );
      if (url.pathname === '/api/ui/preferences') {
        if (req.method === 'GET') return json(res, 200, await workspaceUi.preferences(token));
        if (req.method === 'POST')
          return json(res, 200, await workspaceUi.preferences(token, await body(req)));
      }
      if (url.pathname === '/api/workspace' && req.method === 'GET') {
        const prefs = await workspaceUi.preferences(token);
        if (principal.role === 'superadmin')
          return json(res, 200, {
            user: principal,
            preferences: prefs,
            devices: [],
            buses: [],
            provider: null,
            telemetry: null,
          });
        const [devices, buses, provider, telemetry] = await Promise.all([
          cameras.devices(token, false),
          fleet.list(token),
          cameras.status(token),
          fleet.latest(token),
        ]);
        return json(res, 200, {
          user: principal,
          preferences: prefs,
          devices: await availability.annotate(token, devices.devices),
          buses: buses.buses,
          provider,
          telemetry,
        });
      }
      if (url.pathname === '/api/platform/health' && req.method === 'GET')
        return json(res, 200, await health.snapshot(token, url.searchParams));
      const healthAction = url.pathname.match(
        /^\/api\/platform\/health\/([a-f0-9-]{36})\/(acknowledge|resolve)$/i,
      );
      if (healthAction && req.method === 'POST') {
        if (!uuid.test(healthAction[1])) throw new HttpError('Alert not found.', 404);
        return json(
          res,
          200,
          await (healthAction[2] === 'acknowledge'
            ? health.acknowledge(token, healthAction[1])
            : health.resolveServer(token, healthAction[1])),
        );
      }
      if (url.pathname === '/api/audit' && req.method === 'GET')
        return json(res, 200, await audit.list(token, url.searchParams));
      if (url.pathname === '/api/platform/workspaces' && req.method === 'GET')
        return json(res, 200, await workspaces.platform(token));
      const platformUsers = url.pathname.match(
        /^\/api\/platform\/workspaces\/([a-f0-9-]{36})\/users$/i,
      );
      if (platformUsers && req.method === 'GET') {
        if (!uuid.test(platformUsers[1])) throw new HttpError('Workspace not found.', 404);
        return json(res, 200, await workspaces.platformUsers(token, platformUsers[1]));
      }
      const resetPassword = url.pathname.match(
        /^\/api\/platform\/users\/([a-f0-9-]{36})\/password$/i,
      );
      if (resetPassword && req.method === 'POST') {
        if (!uuid.test(resetPassword[1])) throw new HttpError('User not found.', 404);
        const input = await body(req);
        try {
          const result = await workspaces.resetPlatformPassword(token, resetPassword[1], input);
          hub.closeUser(result.id);
          return json(res, 200, result);
        } finally {
          delete input.password;
        }
      }
      const decision = url.pathname.match(
        /^\/api\/platform\/requests\/([a-f0-9-]{36})\/(approve|reject|suspend|restore)$/i,
      );
      if (decision && req.method === 'POST') {
        if (!uuid.test(decision[1])) throw new HttpError('Request not found.', 404);
        const result = await workspaces.decide(token, decision[1], decision[2]);
        hub.closeTenant(result.tenantId);
        return json(res, 200, result);
      }
      if (url.pathname === '/api/team') {
        requireAccess(canManageTenant(principal, principal.tenantId));
        if (req.method === 'GET') return json(res, 200, await workspaces.members(token));
        if (req.method === 'POST') {
          const input = await body(req);
          try {
            return json(res, 201, await workspaces.createMember(token, input));
          } finally {
            delete input.password;
          }
        }
      }
      const member = url.pathname.match(/^\/api\/team\/([a-f0-9-]{36})$/i);
      if (member && req.method === 'POST') {
        requireAccess(canManageTenant(principal, principal.tenantId));
        if (!uuid.test(member[1])) throw new HttpError('Member not found.', 404);
        const input = await body(req);
        try {
          const result = await workspaces.editMember(token, member[1], input);
          hub.closeUser(result.id);
          return json(res, 200, result);
        } finally {
          delete input.password;
        }
      }
      if (!principal.tenantId || !['admin', 'member'].includes(principal.role))
        throw new HttpError(
          'Use an approved workspace account for camera access.',
          403,
          'access-denied',
        );
      if (url.pathname === '/api/recordings' || url.pathname.startsWith('/api/recordings/')) {
        const store = await storage.store(principal.tenantId);
        if (
          req.method === 'GET' &&
          ['/api/recordings', '/api/recordings/storage'].includes(url.pathname)
        )
          return json(res, 200, await storage.list(token, principal));
        if (req.method === 'POST' && url.pathname === '/api/recordings/settings') {
          requireAccess(canManageTenant(principal, principal.tenantId));
          const input = await body(req),
            result = await store.settings(input);
          await audit.record(token, 'recording.policy_changed', null, {
            changes: [
              `Retention: ${input.retentionDays} days`,
              `Storage limit: ${input.maxBytes} bytes`,
            ],
          });
          return json(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/recordings') {
          let metadata;
          try {
            if (
              typeof req.headers['x-recording-meta'] !== 'string' ||
              req.headers['x-recording-meta'].length > 4096
            )
              throw new Error();
            metadata = JSON.parse(decodeURIComponent(req.headers['x-recording-meta']));
          } catch {
            throw new HttpError('Invalid recording details.');
          }
          const channel = Number(metadata.channel),
            allowed = await cameras.media(token, metadata.deviceId, channel, 'record', {
              providerRequired: false,
            });
          metadata = {
            cameraName: allowed.device.channels.find((c) => c.number === channel).name,
            recorderName: allowed.device.name,
            duration: metadata.duration,
            audio: metadata.audio,
            deviceId: metadata.deviceId,
            channel,
            createdBy: principal.id,
          };
          const result = await store.ingest(req, {
            type: req.headers['content-type'],
            id: req.headers['x-recording-id'],
            metadata,
            contentLength:
              req.headers['content-length'] === undefined
                ? undefined
                : Number(req.headers['content-length']),
          });
          await auth.principal(token);
          const permission = (await storage.permissions(token, [result.clip]))[0];
          result.clip = {
            ...result.clip,
            canDownload: permission.download,
            canDelete: permission.remove,
          };
          if (principal.role !== 'admin') result.storage = null;
          return json(res, 201, result);
        }
        const clip = url.pathname.match(/^\/api\/recordings\/([a-f0-9-]{36})\/(video|delete)$/i);
        if (clip) {
          const value = store.index.clips.find((item) => item.id === clip[1]);
          if (!value) throw new HttpError('Recording not found.', 404);
          const permission = (await storage.permissions(token, [value]))[0];
          if (!permission.view) throw new HttpError('Recording not found.', 404);
          if (['GET', 'HEAD'].includes(req.method) && clip[2] === 'video') {
            if (url.searchParams.get('download') === '1') requireAccess(permission.download);
            return await store.serve(req, res, clip[1], url.searchParams.get('download') === '1');
          }
          if (req.method === 'POST' && clip[2] === 'delete') {
            requireAccess(permission.remove);
            const details = {
              targetName: value.name,
              recorderName: value.recorderName,
              cameraName: value.cameraName,
              reason: 'Manual deletion',
            };
            await audit.record(token, 'recording.delete_requested', clip[1], details);
            let result;
            try {
              result = await store.remove(clip[1]);
            } catch (error) {
              await audit.record(token, 'recording.delete_failed', clip[1], details);
              throw error;
            }
            await audit.record(token, 'recording.deleted', clip[1], details);
            return json(res, 200, result);
          }
        }
        throw new HttpError('Recording not found.', 404);
      }
      if (url.pathname === '/api/status' && req.method === 'GET')
        return json(res, 200, await cameras.status(token));
      const expected =
        req.headers['x-hik-connection'] ||
        (['/api/live/events', '/api/live/audio-events'].includes(url.pathname)
          ? url.searchParams.get('connection')
          : null);
      if (expected) {
        const status = await cameras.status(token);
        if (expected !== (status.connectionId || 'none'))
          throw new HttpError(
            'The camera account changed. Refresh and try again.',
            409,
            'account-changed',
          );
      }
      if (
        req.method === 'POST' &&
        ['/api/provider/recovery/retry', '/api/provider/recovery/disable'].includes(url.pathname)
      ) {
        requireAccess(canManageTenant(principal, principal.tenantId));
        throttle(req);
        if (url.pathname.endsWith('/disable')) await cameras.disableRecovery(token);
        else void recovery.run(principal.tenantId, { force: true }).catch(() => {});
        return json(
          res,
          url.pathname.endsWith('/disable') ? 200 : 202,
          await cameras.status(token),
        );
      }
      if (url.pathname === '/api/preferences') {
        if (req.method === 'GET') return json(res, 200, await cameras.preferences(token));
        if (req.method === 'POST')
          return json(res, 200, await cameras.preferences(token, await body(req)));
      }
      if (
        req.method === 'POST' &&
        ['/api/connect/personal', '/api/connect/desktop', '/api/disconnect'].includes(url.pathname)
      ) {
        requireAccess(canManageTenant(principal, principal.tenantId));
        if (connecting.has(principal.tenantId))
          throw new HttpError(
            'An account connection is already in progress.',
            409,
            'account-change-in-progress',
          );
        connecting.add(principal.tenantId);
        try {
          if (url.pathname === '/api/connect/personal') {
            throttle(req);
            const input = await body(req);
            try {
              await cameras.connect(token, input);
            } finally {
              delete input.password;
            }
          } else if (url.pathname === '/api/connect/desktop') await cameras.desktop(token);
          else {
            const { provider } = await cameras.adminProvider(token);
            await cameras.saveProvider(token, null, provider);
          }
          hub.closeTenant(principal.tenantId);
          return json(res, 200, await cameras.status(token));
        } finally {
          connecting.delete(principal.tenantId);
        }
      }
      if (url.pathname === '/api/fleet/buses' && req.method === 'GET')
        return json(res, 200, await fleet.list(token));
      if (url.pathname === '/api/fleet/buses' && req.method === 'POST')
        return json(res, 200, await fleet.save(token, await body(req)));
      if (url.pathname === '/api/fleet/buses/remove' && req.method === 'POST')
        return json(res, 200, await fleet.remove(token, (await body(req)).id));
      if (url.pathname === '/api/fleet/mock/poll' && req.method === 'POST')
        return json(res, 200, await fleet.pollMock(token));
      if (url.pathname === '/api/fleet/vendor/poll' && req.method === 'POST')
        return json(res, 200, await fleet.pollWheelseye(token));
      if (url.pathname === '/api/fleet/wheelseye/sources' && req.method === 'GET')
        return json(res, 200, await fleet.wheelseyeSources(token));
      if (url.pathname === '/api/fleet/wheelseye/refresh' && req.method === 'POST')
        return json(res, 200, await fleet.refreshWheelseyeSources(token));
      if (url.pathname === '/api/fleet/wheelseye/device' && req.method === 'GET')
        return json(res, 200, await fleet.wheelseyeDevice(token, url.searchParams.get('sourceId'), url.searchParams.get('deviceId')));
      if (url.pathname === '/api/fleet/wheelseye/source' && req.method === 'GET')
        return json(res, 200, await fleet.wheelseyeSourceDiagnostics(token, url.searchParams.get('sourceId'), { live: url.searchParams.get('live') === '1' }));
      if (url.pathname === '/api/fleet/wheelseye/source/poll' && req.method === 'POST')
        return json(res, 200, await fleet.pollWheelseyeSource(token, (await body(req)).sourceId));
      if (url.pathname === '/api/fleet/wheelseye/sources' && req.method === 'POST')
        return json(res, 200, await fleet.addWheelseyeSource(token, await body(req)));
      const sourceDelete = url.pathname.match(
        /^\/api\/fleet\/wheelseye\/sources\/([a-f0-9-]{36})$/i,
      );
      if (sourceDelete && req.method === 'DELETE')
        return json(res, 200, await fleet.removeWheelseyeSource(token, sourceDelete[1]));
      if (url.pathname === '/api/fleet/telemetry' && req.method === 'GET')
        return json(res, 200, await fleet.latest(token));
      if (url.pathname === '/api/fleet/notifications' && req.method === 'GET')
        return json(res, 200, await fleet.notifications(token));
      if (url.pathname === '/api/fleet/live' && req.method === 'GET')
        return json(res, 200, await fleet.liveWheelseye(token, url.searchParams.get('busId')));
      if (url.pathname === '/api/fleet/history' && req.method === 'GET')
        return json(
          res,
          200,
          await fleet.history(
            token,
            url.searchParams.get('busId'),
            Number(url.searchParams.get('from')),
            Number(url.searchParams.get('to')),
          ),
        );
      if (url.pathname === '/api/devices' && req.method === 'GET') {
        try {
          const result = await cameras.devices(token);
          return json(res, 200, {
            ...result,
            devices: await availability.annotate(token, result.devices),
          });
        } catch (error) {
          if (error.code === 'provider-auth-required') {
            hub.closeTenant(principal.tenantId);
            void recovery.run(principal.tenantId).catch(() => {});
          }
          throw error;
        }
      }
      if (url.pathname === '/api/previews/frame' && req.method === 'GET') {
        const deviceId = url.searchParams.get('deviceId'),
          channel = Number(url.searchParams.get('channel'));
        try {
          const image = await hub.preview(token, principal, deviceId, channel);
          await availability.observe({
            viewer: tokenHash(token),
            tenantId: principal.tenantId,
            deviceId,
            channel,
            ok: true,
            observedAt: image.capturedAt,
          });
          return json(res, 200, image);
        } catch (error) {
          await availability
            .observe({
              viewer: tokenHash(token),
              tenantId: principal.tenantId,
              deviceId,
              channel,
              ok: false,
              code: error.code,
            })
            .catch(() => {});
          throw error;
        }
      }
      const viewer = hub.viewer(token, principal);
      if (url.pathname === '/api/live/events' && req.method === 'GET')
        return viewer.subscribe(res, { separateAudio: true });
      if (url.pathname === '/api/live/audio-events' && req.method === 'GET')
        return viewer.subscribeAudioEvents(res);
      if (url.pathname === '/api/live/status' && req.method === 'GET')
        return json(
          res,
          200,
          url.searchParams.has('all')
            ? viewer.states()
            : viewer.slot(tileId(url.searchParams.get('slot') ?? 0)).live?.status() || {
                state: 'stopped',
              },
        );
      if (url.pathname === '/api/live/start' && req.method === 'POST')
        return json(res, 200, await hub.start(token, principal, await body(req)));
      if (url.pathname === '/api/live/stop-all' && req.method === 'POST') {
        viewer.stopAll();
        return json(res, 200, { state: 'stopped' });
      }
      if (url.pathname === '/api/live/stop' && req.method === 'POST') {
        viewer.stop(tileId((await body(req)).slot));
        return json(res, 200, { state: 'stopped' });
      }
      if (url.pathname === '/api/live/stop-slots' && req.method === 'POST') {
        const input = await body(req);
        if (!Array.isArray(input.slots) || input.slots.length > 32)
          throw new HttpError('Choose valid camera tiles.');
        const ids = input.slots.map(tileId);
        for (const id of ids) viewer.stop(id);
        return json(res, 200, { state: 'stopped' });
      }
      if (url.pathname === '/api/live/audio-focus' && req.method === 'POST') {
        const input = await body(req);
        if (!Array.isArray(input.slots) || input.slots.length > 5)
          throw new HttpError('Choose up to five audio feeds.');
        viewer.focusAudio(input.slots.map(tileId));
        return json(res, 200, { slots: input.slots });
      }
      if (url.pathname.startsWith('/api/live/talk/'))
        throw new HttpError('Browser microphone forwarding is not available in this build.', 409);
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      const known = [
        HttpError,
        AccessError,
        RecordingError,
        HikError,
        PortalError,
        LiveError,
        DesktopSdkError,
      ].some((Type) => error instanceof Type);
      const status =
        error.code === '23505'
          ? 409
          : error.code === '42501' || error.code === '23503'
            ? 403
            : known
              ? error.status || 502
              : 500;
      const message =
        error.code === '23505'
          ? 'This account or record already exists.'
          : error.code === '42501' || error.code === '23503'
            ? 'This action is unavailable in your workspace.'
            : known
              ? error.message
              : 'The workspace could not complete this request. Try again.';
      const code =
        known && typeof error.code === 'string'
          ? error.code
          : !known && status >= 500
            ? 'server-error'
            : undefined;
      if (
        status >= 500 &&
        !req.url.startsWith('/api/platform/health') &&
        !(error instanceof LiveError)
      ) {
        if (error instanceof RecordingError && status === 507)
          void health
            .report('storage:disk', { code: 'disk-space', severity: 'critical' })
            .catch(() => {});
        else {
          const provider = error instanceof HikError || error instanceof PortalError;
          const component = req.url.startsWith('/api/devices')
            ? 'Device discovery'
            : req.url.startsWith('/api/recordings')
              ? req.method === 'POST' && req.url === '/api/recordings'
                ? 'Recording upload'
                : 'Recording management'
              : req.url.startsWith('/api/live')
                ? 'Live playback'
                : req.url.startsWith('/api/preferences')
                  ? 'Viewer settings'
                  : req.url.startsWith('/api/team')
                    ? 'Team management'
                    : req.url.startsWith('/api/platform')
                      ? 'Platform administration'
                      : req.url.startsWith('/api/connect')
                        ? 'Camera account'
                        : 'API request';
          void health
            .report(
              `${provider ? 'http:provider' : 'http:server'}:${healthTenant || 'global'}:${component}`,
              {
                tenantId: healthTenant,
                code: provider
                  ? ['provider-unavailable', 'provider-timeout'].includes(error.code)
                    ? 'provider-unavailable'
                    : 'provider-response-error'
                  : 'server-request-failed',
                details: { httpStatus: status, component },
              },
            )
            .catch(() => {});
        }
      }
      json(res, status, { error: message, ...(code ? { code } : {}) });
    }
  });
  const reap = setInterval(() => {
    void hub
      .reap()
      .then(() => health.taskRecovered('session-checks'))
      .catch(() => health.taskFailed('session-checks'));
    for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
  }, 5000);
  reap.unref();
  const cleanup = setInterval(() => {
    void storage
      .cleanup()
      .then(() => health.taskRecovered('recording-cleanup'))
      .catch(() => health.taskFailed('recording-cleanup'));
  }, 60000);
  cleanup.unref();
  const recoveryTimer = setInterval(() => {
    void recovery
      .tick()
      .then(() => health.taskRecovered('account-recovery'))
      .catch(() => health.taskFailed('account-recovery'));
  }, 30000);
  recoveryTimer.unref();
  const healthTimer = setInterval(() => {
    void health.sample().catch(() => {});
  }, 30000);
  healthTimer.unref();
  server.on('close', () => {
    clearInterval(reap);
    clearInterval(cleanup);
    clearInterval(recoveryTimer);
    clearInterval(healthTimer);
    clearInterval(wheelseyeRetention);
    wheelseyePoll?.();
    void recovery.stop();
    hub.close();
  });
  return { server, auth, cameras, workspaces, hub, recovery, health };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32') throw new Error('Windows runtime required.');
    const config = await runtimeConfig(),
      db = await new Database(config.databaseUrl).connect(),
      cipher = await ProviderCipher.open(config.dataDirectory, db),
      storage = await new TenantStorage(config.dataDirectory, db).open();
    const { server, recovery, health } = createSaas({
      db,
      cipher,
      storage,
      publicOrigin: process.env.PUBLIC_ORIGIN || null,
      frontendOrigins: frontendOriginsFromEnv(process.env.FRONTEND_ORIGINS),
      cookieSameSite: process.env.COOKIE_SAME_SITE || 'Strict',
    });
    server.on('close', () => {
      void recovery
        .stop()
        .then(() => health.drain())
        .then(() => db.close());
    });
    server.on('error', () => {
      console.error('The local SaaS server could not start. Check its port and database.');
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () =>
      console.log(`RGU Windows API: http://localhost:${config.port}`),
    );
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.on(signal, () => {
        server.close();
        server.closeAllConnections();
      });
  } catch {
    console.error(
      'Windows backend could not initialize. Run the local database setup and check the configuration/key.',
    );
    process.exitCode = 1;
  }
}
