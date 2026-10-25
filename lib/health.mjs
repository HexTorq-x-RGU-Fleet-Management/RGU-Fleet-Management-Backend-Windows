import { createHash, randomUUID } from 'node:crypto';
import { statfs } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { tokenHash } from './auth.mjs';
import { canApproveAdmins, requireAccess } from './access.mjs';
import { HttpError } from './database.mjs';
export const healthCodes = {
  'stream-interrupted': ['stream', 'warning', 'Live stream interrupted'],
  'stream-timeout': ['stream', 'warning', 'Camera video timed out'],
  'decode-failed': ['stream', 'warning', 'Camera stream could not be decoded'],
  'sdk-start-failed': ['stream', 'warning', 'Camera playback failed to start'],
  'playback-rejected': ['stream', 'warning', 'Camera rejected playback'],
  'receiver-unavailable': ['stream', 'critical', 'Video receiver unavailable'],
  'playback-auth-required': ['stream', 'warning', 'Playback authorization needs attention'],
  'recorder-offline': ['stream', 'warning', 'Requested recorder is offline'],
  'encrypted-stream': ['stream', 'warning', 'Camera encryption setup required'],
  'storage-usage': ['storage', 'warning', 'Recording storage is nearly full'],
  'disk-space': ['storage', 'warning', 'Server recording disk is low on space'],
  'storage-check-failed': ['storage', 'warning', 'Recording storage could not be checked'],
  'server-request-failed': ['server', 'critical', 'Server request failed'],
  'server-task-failed': ['server', 'critical', 'A background server task failed'],
  'provider-unavailable': ['server', 'warning', 'Camera cloud service is unavailable'],
  'provider-response-error': ['server', 'warning', 'Camera cloud response needs attention'],
};
export const healthKey = (value) => createHash('sha256').update(value).digest('hex');
const numericDetails = (input) => ({
  ...Object.fromEntries(
    ['usedBytes', 'maxBytes', 'freeBytes', 'usedPercent', 'httpStatus']
      .filter((k) => Number.isFinite(input?.[k]) && input[k] >= 0)
      .map((k) => [k, input[k]]),
  ),
  ...([
    'Device discovery',
    'Recording upload',
    'Recording management',
    'Live playback',
    'Viewer settings',
    'Team management',
    'Platform administration',
    'Camera account',
    'API request',
  ].includes(input?.component)
    ? { component: input.component }
    : {}),
});
const streamResource = (e) =>
  `stream:${e.tenantId}:${e.viewer}:${e.slot}:${e.deviceId}:${e.channel}`;
export class HealthMonitor {
  constructor(
    db,
    {
      storage,
      hub,
      now = Date.now,
      disk = async (directory) => {
        const d = await statfs(directory);
        return Number(d.bavail) * Number(d.bsize);
      },
      clock = () => process.hrtime.bigint(),
    } = {},
  ) {
    Object.assign(this, { db, storage, hub, now, disk, clock });
    this.pending = new Set();
    this.fallback = new Map();
    this.resolutions = new Map();
    this.persistenceRetryAt = 0;
    this.storageReadings = [];
    this.lastSampleAt = null;
    this.sampling = null;
    this.lastCpu = process.cpuUsage();
    this.lastCpuTime = this.clock();
    this.cpuPercent = null;
    this.resources = new Map();
  }
  enqueue(key, work) {
    const job = (this.resources.get(key) || Promise.resolve()).catch(() => {}).then(work);
    this.resources.set(key, job);
    this.pending.add(job);
    const done = () => {
      this.pending.delete(job);
      if (this.resources.get(key) === job) this.resources.delete(key);
    };
    job.then(done, done);
    return job;
  }
  async report(
    resource,
    { code, tenantId = null, recorderName = null, channel = null, severity, details = {} } = {},
  ) {
    code = Object.hasOwn(healthCodes, code) ? code : 'server-request-failed';
    const [kind, defaultSeverity] = healthCodes[code];
    const event = {
      id: randomUUID(),
      key: healthKey(resource),
      tenantId,
      code,
      kind,
      severity:
        severity === 'critical' ? 'critical' : severity === 'warning' ? 'warning' : defaultSeverity,
      recorderName:
        typeof recorderName === 'string'
          ? recorderName.replace(/[\x00-\x1f]/g, ' ').slice(0, 200)
          : null,
      channel: Number.isInteger(channel) ? channel : null,
      details: numericDetails(details),
    };
    return this.enqueue(event.key, () => this.persist(event));
  }
  async persist(event) {
    if (this.persistenceRetryAt <= this.now())
      try {
        await this.db.pool.query('SELECT cam.health_report($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
          event.id,
          event.key,
          event.tenantId,
          event.kind,
          event.severity,
          event.code,
          event.recorderName,
          event.channel,
          event.details,
        ]);
        this.fallback.delete(event.key);
        this.resolutions.delete(event.key);
        this.persistenceRetryAt = 0;
        return true;
      } catch {
        this.persistenceRetryAt = this.now() + 30000;
      }
    if (this.fallback.size >= 200 && !this.fallback.has(event.key))
      this.fallback.delete(this.fallback.keys().next().value);
    this.fallback.set(event.key, event);
    this.resolutions.delete(event.key);
    return false;
  }
  async persistResolution(key, reason) {
    this.fallback.delete(key);
    if (this.persistenceRetryAt <= this.now())
      try {
        await this.db.pool.query('SELECT cam.health_resolve($1,$2)', [key, reason]);
        this.resolutions.delete(key);
        this.persistenceRetryAt = 0;
        return true;
      } catch {
        this.persistenceRetryAt = this.now() + 30000;
      }
    if (this.resolutions.size >= 200 && !this.resolutions.has(key))
      this.resolutions.delete(this.resolutions.keys().next().value);
    this.resolutions.set(key, reason);
    return false;
  }
  async resolve(resource, reason = 'recovered') {
    const key = healthKey(resource);
    return this.enqueue(key, () =>
      this.persistResolution(
        key,
        ['recovered', 'playback-stopped', 'storage-recovered', 'task-recovered'].includes(reason)
          ? reason
          : 'recovered',
      ),
    );
  }
  observeStream(event) {
    const resource = streamResource(event);
    return event.ok
      ? this.resolve(resource, event.stopped ? 'playback-stopped' : 'recovered')
      : this.report(resource, event);
  }
  async taskFailed(name) {
    return this.report('task:' + name, { code: 'server-task-failed' });
  }
  async taskRecovered(name) {
    return this.resolve('task:' + name, 'task-recovered');
  }
  async sample() {
    if (this.sampling) return this.sampling;
    this.sampling = this.takeSample().finally(() => (this.sampling = null));
    return this.sampling;
  }
  async takeSample() {
    const at = this.now(),
      cpu = process.cpuUsage(),
      stamp = this.clock(),
      elapsed = Number(stamp - this.lastCpuTime) / 1000;
    if (elapsed > 0)
      this.cpuPercent = Math.max(
        0,
        Math.min(
          100,
          ((cpu.user - this.lastCpu.user + cpu.system - this.lastCpu.system) /
            elapsed /
            availableParallelism()) *
            100,
        ),
      );
    this.lastCpu = cpu;
    this.lastCpuTime = stamp;
    for (const event of [...this.fallback.values()]) {
      if (
        !(await this.enqueue(event.key, () =>
          this.fallback.get(event.key) === event ? this.persist(event) : true,
        ))
      )
        break;
    }
    for (const [key, reason] of [...this.resolutions]) {
      if (
        !(await this.enqueue(key, () =>
          this.resolutions.get(key) === reason ? this.persistResolution(key, reason) : true,
        ))
      )
        break;
    }
    try {
      const free = await this.disk(this.storage.directory);
      if (!Number.isFinite(free) || free < 0) throw Error('Storage unavailable');
      this.freeBytes = free;
      if (free < 2 * 1024 ** 3)
        await this.report('storage:disk', {
          code: 'disk-space',
          severity: free < 512 * 1024 ** 2 ? 'critical' : 'warning',
          details: { freeBytes: free },
        });
      else if (free >= 2.5 * 1024 ** 3) await this.resolve('storage:disk', 'storage-recovered');
      await this.resolve('storage:check', 'recovered');
    } catch {
      this.freeBytes = null;
      await this.report('storage:check', { code: 'storage-check-failed' });
    }
    const readings = [];
    for (const [tenantId, promise] of this.storage.stores)
      try {
        const store = await promise,
          summary = await store.summary(),
          percent = summary.maxBytes > 0 ? (summary.usedBytes / summary.maxBytes) * 100 : 0;
        readings.push({
          tenantId,
          usedBytes: summary.usedBytes,
          maxBytes: summary.maxBytes,
          usedPercent: percent,
        });
        if (percent >= 90)
          await this.report('storage:workspace:' + tenantId, {
            code: 'storage-usage',
            tenantId,
            severity: percent >= 98 ? 'critical' : 'warning',
            details: {
              usedBytes: summary.usedBytes,
              maxBytes: summary.maxBytes,
              usedPercent: percent,
            },
          });
        else if (percent < 85)
          await this.resolve('storage:workspace:' + tenantId, 'storage-recovered');
        await this.resolve('storage:check:' + tenantId, 'recovered');
      } catch {
        await this.report('storage:check:' + tenantId, { code: 'storage-check-failed', tenantId });
      }
    this.storageReadings = readings;
    this.lastSampleAt = at;
  }
  async snapshot(token, params = new URLSearchParams()) {
    // Authenticate before disk reads or global metrics. No ordinary workspace API
    // can invoke this scan or receive its results.
    const principal = await this.db.session(tokenHash(token), async (_c, u) => {
      requireAccess(canApproveAdmins(u));
      return u;
    });
    this.persistenceRetryAt = 0;
    if (
      this.fallback.size ||
      this.resolutions.size ||
      params.get('fresh') === '1' ||
      !this.lastSampleAt ||
      this.now() - this.lastSampleAt > 30000
    )
      await this.sample();
    await Promise.allSettled([...this.pending]);
    return this.db.session(tokenHash(token), async (client, user) => {
      requireAccess(canApproveAdmins(user));
      const state = params.get('state') || 'active',
        kind = params.get('kind') || '';
      if (
        !['active', 'resolved', 'all'].includes(state) ||
        (kind && !['stream', 'storage', 'server'].includes(kind))
      )
        throw new HttpError('Choose valid health filters.');
      const values = [],
        where = [];
      if (state !== 'all')
        where.push('h.resolved_at IS ' + (state === 'active' ? 'NULL' : 'NOT NULL'));
      if (kind) {
        values.push(kind);
        where.push('h.kind=$1');
      }
      const result = await client.query(
        `SELECT h.*,t.name AS workspace_name,u.full_name AS acknowledged_name FROM cam.health_alerts h LEFT JOIN cam.tenants t ON t.id=h.tenant_id LEFT JOIN cam.users u ON u.id=h.acknowledged_by ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (h.resolved_at IS NULL) DESC,(h.severity='critical') DESC,h.last_seen DESC LIMIT 100`,
        values,
      );
      const counts = (
        await client.query(
          "SELECT count(*) FILTER(WHERE resolved_at IS NULL) AS active,count(*) FILTER(WHERE resolved_at IS NULL AND severity='critical') AS critical,count(*) FILTER(WHERE resolved_at IS NULL AND acknowledged_at IS NULL) AS unacknowledged FROM cam.health_alerts",
        )
      ).rows[0];
      const workspaces = (await client.query('SELECT id,name FROM cam.tenants')).rows;
      let live = 0,
        failed = 0;
      for (const entry of this.hub.viewers.values())
        for (const slot of entry.viewer.slots.values()) {
          if (slot.live?.state === 'playing') live++;
          if (slot.live?.state === 'failed') failed++;
        }
      const memory = process.memoryUsage();
      return {
        sampledAt: this.lastSampleAt,
        checkedAt: this.now(),
        persistenceAvailable: this.fallback.size === 0 && this.resolutions.size === 0,
        counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])),
        metrics: {
          uptimeSeconds: process.uptime(),
          nodeRssBytes: memory.rss,
          nodeHeapBytes: memory.heapUsed,
          nodeCpuPercent: this.cpuPercent,
          liveStreams: live,
          failedStreams: failed,
          freeDiskBytes: this.freeBytes ?? null,
        },
        storage: this.storageReadings.map((r) => ({
          ...r,
          workspace: workspaces.find((w) => w.id === r.tenantId)?.name || 'Workspace',
        })),
        alerts: result.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          severity: r.severity,
          title: healthCodes[r.code]?.[2] || 'Server needs attention',
          workspace: r.workspace_name || 'Server',
          recorder: r.recorder_name,
          channel: r.channel,
          details: numericDetails(r.details),
          observations: r.occurrences,
          firstSeen: r.first_seen,
          lastSeen: r.last_seen,
          resolvedAt: r.resolved_at,
          resolution: r.resolution,
          acknowledgedAt: r.acknowledged_at,
          acknowledgedBy: r.acknowledged_name,
        })),
      };
    });
  }
  async acknowledge(token, id) {
    return this.db.session(tokenHash(token), async (client, user) => {
      requireAccess(canApproveAdmins(user));
      const result = await client.query(
        'UPDATE cam.health_alerts SET acknowledged_at=now(),acknowledged_by=$1 WHERE id=$2 AND resolved_at IS NULL RETURNING id',
        [user.id, id],
      );
      if (!result.rowCount)
        throw new HttpError('Active alert not found. Refresh health monitoring.', 404);
      return { acknowledged: true };
    });
  }
  async resolveServer(token, id) {
    return this.db.session(tokenHash(token), async (client, user) => {
      requireAccess(canApproveAdmins(user));
      const result = await client.query(
        "UPDATE cam.health_alerts SET resolved_at=now(),resolution='manually-resolved',acknowledged_at=coalesce(acknowledged_at,now()),acknowledged_by=coalesce(acknowledged_by,$1) WHERE id=$2 AND kind='server' AND resolved_at IS NULL RETURNING id",
        [user.id, id],
      );
      if (!result.rowCount) throw new HttpError('Active server alert not found.', 404);
      return { resolved: true };
    });
  }
  async drain() {
    if (this.sampling) await this.sampling.catch(() => {});
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
