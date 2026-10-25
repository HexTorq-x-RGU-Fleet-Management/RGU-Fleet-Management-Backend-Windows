import { randomUUID, createHash } from 'node:crypto';
import { sdkReady, expiryHint } from './provider-state.mjs';
const MINUTE = 60000;
const allowedOrigins = ['https://iindia.hik-connect.com', 'https://www.hik-connect.com'];
const failure = (state, now, blocked = null) => ({
  ...state,
  failures: (state?.failures || 0) + 1,
  lastCheckedAt: now,
  blocked,
  nextRetryAt: blocked
    ? null
    : now + Math.min(15 * MINUTE, MINUTE * 2 ** Math.min(state?.failures || 0, 4)),
});
const healthy = (state, now, recovered = false) => ({
  ...state,
  failures: 0,
  blocked: null,
  nextRetryAt: null,
  lastCheckedAt: now,
  ...(recovered ? { lastRecoveredAt: now } : {}),
});
export class ProviderRecovery {
  constructor(
    db,
    cipher,
    cameras,
    { now = Date.now, platform = process.platform, onRecovered = () => {} } = {},
  ) {
    Object.assign(this, { db, cipher, cameras, now, platform, onRecovered });
    this.jobs = new Map();
    this.stopped = false;
  }
  async candidates(id = null) {
    return (await this.db.pool.query('SELECT * FROM cam.recovery_candidates($1)', [id])).rows;
  }
  async store(id, expected, provider, event = null) {
    const sealed = this.cipher.seal(provider, id);
    return (
      await this.db.pool.query('SELECT cam.recovery_store($1,$2,$3,$4) AS saved', [
        id,
        expected,
        sealed,
        event,
      ])
    ).rows[0].saved
      ? sealed
      : null;
  }
  run(id, options = {}) {
    if (this.stopped) return Promise.resolve(false);
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = this.perform(id, options).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
  async perform(id, { force = false, playbackCheck = false } = {}) {
    const row = (await this.candidates(id))[0];
    if (!row || this.stopped) return false;
    const p = this.cipher.open(row.payload, id),
      now = this.now();
    const r = p.recovery || { webEnabled: false, playbackEnabled: false };
    p.recovery = r;
    r.web ||= {};
    r.playback ||= {};
    const expiryDue = Boolean(
      p.webExpiresAt &&
      p.webExpiresAt <= now + MINUTE &&
      (!r.web.lastCheckedAt || r.web.lastCheckedAt < p.webExpiresAt),
    );
    const webDue = Boolean(
      p.needsReconnect ||
      (r.web.nextRetryAt && r.web.nextRetryAt <= now) ||
      expiryDue ||
      !r.web.lastCheckedAt ||
      r.web.lastCheckedAt + 5 * MINUTE <= now,
    );
    const playbackDue = Boolean(
      r.playbackEnabled &&
      (force ||
        playbackCheck ||
        !sdkReady(p) ||
        (p.sdkExpiresAt && p.sdkExpiresAt <= now + MINUTE) ||
        !r.playback.lastCheckedAt ||
        r.playback.lastCheckedAt + 5 * MINUTE <= now),
    );
    if (r.lease?.until > now || (!force && !webDue && !playbackDue)) return false;
    const webAllowed = !r.web.blocked && (!r.web.nextRetryAt || r.web.nextRetryAt <= now);
    const playbackAllowed =
      (!r.playback.nextRetryAt || r.playback.nextRetryAt <= now) &&
      (!playbackCheck || !r.playback.lastCheckedAt || r.playback.lastCheckedAt + MINUTE <= now);
    if (
      !(webAllowed && (webDue || force)) &&
      !(playbackDue && playbackAllowed && this.platform === 'win32')
    )
      return false;
    const lease = { id: randomUUID(), until: now + 4 * MINUTE };
    r.lease = lease;
    const leased = this.cipher.seal(p, id);
    const claimed = (
      await this.db.pool.query('SELECT cam.recovery_store($1,$2,$3,NULL) AS saved', [
        id,
        row.payload,
        leased,
      ])
    ).rows[0].saved;
    if (!claimed) return false;
    let sharing = null,
      discovered = null,
      recovered = false,
      attention = false,
      committed = false;
    const discover = async () => {
      const result = await Promise.all([this.cameras.hik.devices(p), this.cameras.hik.sharing(p)]);
      sharing = result[1];
      return [...result[0], ...(sharing.devices || [])];
    };
    try {
      if (webAllowed && (webDue || force)) {
        if (
          r.webEnabled &&
          r.secret &&
          p.webExpiresAt &&
          p.webExpiresAt <= now &&
          (!r.web.lastRecoveredAt || r.web.lastRecoveredAt < p.webExpiresAt)
        )
          p.needsReconnect = true;
        if (!p.needsReconnect) {
          try {
            discovered = await discover();
            r.web = healthy(r.web, now);
          } catch (error) {
            if (error.status === 401) p.needsReconnect = true;
            else {
              r.web = failure(r.web, now, error.status === 403 ? 'access-denied' : null);
              attention = Boolean(r.web.blocked);
            }
          }
        }
        if (p.needsReconnect) {
          if (r.webEnabled && r.secret && !r.web.blocked) {
            try {
              const result = await this.cameras.personal({ ...r.secret }),
                c = result?.credentials;
              if (
                !c?.sessionId ||
                !allowedOrigins.includes(c.origin) ||
                c.accountUserId !== p.accountUserId
              ) {
                r.web = failure(r.web, now, 'account-mismatch');
                attention = true;
              } else {
                p.sessionId = c.sessionId;
                p.origin = c.origin;
                p.user = c.user || p.user;
                p.webExpiresAt = c.webExpiresAt || expiryHint(c.sessionId);
                p.needsReconnect = false;
                p.credentialVersion = randomUUID();
                try {
                  discovered = await discover();
                  r.web = healthy(r.web, now, true);
                  recovered = true;
                } catch (error) {
                  p.needsReconnect = error.status === 401;
                  r.web = failure(
                    r.web,
                    now,
                    [401, 403].includes(error.status) ? 'sign-in-required' : null,
                  );
                  attention = Boolean(r.web.blocked);
                }
              }
            } catch (error) {
              // Only explicit transport failure gets an automatic retry. Any
              // credential/challenge/unknown login rejection requires user action.
              const transient =
                error.status === 429 ||
                error.status >= 500 ||
                error.code === 'provider-unavailable' ||
                error.code === 'provider-timeout' ||
                /request failed|connectivity/i.test(error.message || '');
              r.web = failure(r.web, now, transient ? null : 'sign-in-required');
              attention = !transient;
            }
          } else if (!r.webEnabled || !r.secret) {
            r.web = failure(r.web, now, 'sign-in-required');
            attention = true;
          }
        }
      }
      if (playbackDue && !p.needsReconnect && playbackAllowed && this.platform === 'win32') {
        try {
          sharing ||= await this.cameras.hik.sharing(p);
          const device = sharing.devices?.find((d) => d.channels?.length);
          if (!device) {
            r.playback = failure(r.playback, now);
            r.playback.reason = 'no-shared-channel';
          } else {
            const candidate = await this.cameras.desktopToken(),
              hash = createHash('sha256').update(candidate).digest('hex');
            if (
              candidate === p.sdkAccessToken &&
              Number.isFinite(p.sdkExpiresAt) &&
              p.sdkExpiresAt <= now
            ) {
              r.playback = {
                ...r.playback,
                blocked: 'playback-sign-in-required',
                nextRetryAt: now + MINUTE,
              };
              attention = true;
            } else if (r.playback.rejectedHash === hash && !force) {
              r.playback = { ...r.playback, nextRetryAt: now + MINUTE };
            } else {
              try {
                const checked = await this.cameras.verifySdk(
                  candidate,
                  device,
                  device.channels[0].number,
                );
                const changed = p.sdkAccessToken !== candidate || !sdkReady(p);
                const knownExpiry = candidate === p.sdkAccessToken ? p.sdkExpiresAt : null;
                p.sdkAccessToken = candidate;
                p.sdkSource = 'installed-client';
                p.sdkExpiresAt = knownExpiry ?? null;
                p.sdkValidatedAt = checked.validatedAt;
                p.playbackNeedsReconnect = false;
                if (changed) p.credentialVersion = randomUUID();
                r.playback = healthy({}, now, changed);
                recovered ||= changed;
              } catch {
                p.playbackNeedsReconnect = true;
                r.playback = failure(r.playback, now);
                r.playback.blocked = 'playback-sign-in-required';
                r.playback.rejectedHash = hash;
                attention = true;
              }
            }
          }
        } catch (error) {
          if (error.status === 401) p.needsReconnect = true;
          r.playback = failure(r.playback, now);
          r.playback.reason =
            error.status === 401 ? 'web-sign-in-required' : 'playback-sign-in-required';
        }
      }
    } finally {
      delete r.lease;
      // Compare the exact encrypted lease, not just account identity. A manual
      // disconnect, new login or disabled recovery always wins over this job.
      const saved = await this.store(
        id,
        leased,
        p,
        recovered ? 'provider.recovered' : attention ? 'provider.recovery_attention' : null,
      );
      committed = Boolean(saved);
      if (saved && discovered)
        await this.db.pool.query('SELECT cam.recovery_devices($1,$2,$3::jsonb)', [
          id,
          saved,
          JSON.stringify(discovered),
        ]);
      if (saved && recovered) this.onRecovered(id);
    }
    return recovered && committed;
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const rows = await this.candidates();
      // Bound native verification and HTTP work across tenants.
      for (let offset = 0; offset < rows.length && !this.stopped; offset += 2)
        await Promise.allSettled(
          rows.slice(offset, offset + 2).map((row) => this.run(row.tenant_id)),
        );
    } finally {
      this.ticking = false;
    }
  }
  stop() {
    this.stopped = true;
    return Promise.allSettled(this.jobs.values());
  }
}
