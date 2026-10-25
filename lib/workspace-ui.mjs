import { tokenHash } from './auth.mjs';
import { HttpError } from './database.mjs';
export const defaultSettings = {
  retention: 7,
  quality: 'auto',
  fit: 'contain',
  theme: 'dark',
  rotation: 30,
  reduceMotion: false,
};
export function cleanUi(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object')
    throw new HttpError('Invalid workspace preferences.');
  const s = Object.fromEntries(
    Object.entries(defaultSettings).map(([key, value]) => [key, input.settings?.[key] ?? value]),
  );
  if (
    ![1, 7, 30, 90].includes(s.retention) ||
    !['auto', 'sd', 'hd'].includes(s.quality) ||
    !['contain', 'cover'].includes(s.fit) ||
    !['dark', 'light'].includes(s.theme) ||
    ![15, 30, 60, 120].includes(s.rotation) ||
    typeof s.reduceMotion !== 'boolean'
  )
    throw new HttpError('Invalid viewing preferences.');
  const favorites = input.favorites ?? [],
    layouts = input.layouts ?? [];
  if (
    !Array.isArray(favorites) ||
    favorites.length > 256 ||
    favorites.some((x) => typeof x !== 'string' || x.length > 256) ||
    !Array.isArray(layouts) ||
    layouts.length > 12
  )
    throw new HttpError('Too many saved layouts or favourites.');
  const cleaned = layouts.map((l) => {
    if (
      !l ||
      typeof l.id !== 'string' ||
      l.id.length > 100 ||
      typeof l.name !== 'string' ||
      !l.name.trim() ||
      l.name.length > 60 ||
      typeof l.recorder !== 'string' ||
      l.recorder.length > 256 ||
      ![1, 4, 9, 16].includes(l.grid) ||
      !['contain', 'cover', 'none'].includes(l.fit)
    )
      throw new HttpError('Invalid layout.');
    return { id: l.id, name: l.name.trim(), recorder: l.recorder, grid: l.grid, fit: l.fit };
  });
  return { settings: s, favorites: [...new Set(favorites)], layouts: cleaned };
}
export class WorkspaceUi {
  constructor(db) {
    this.db = db;
  }
  preferences(token, input) {
    return this.db.session(tokenHash(token), async (c, p) => {
      if (input !== undefined) {
        await c.query(
          "INSERT INTO cam.ui_preferences(user_id,data) VALUES($1,'{}') ON CONFLICT DO NOTHING",
          [p.id],
        );
        const old =
          (await c.query('SELECT data FROM cam.ui_preferences WHERE user_id=$1 FOR UPDATE', [p.id]))
            .rows[0]?.data ?? {};
        const data = cleanUi({
          ...old,
          ...input,
          settings: { ...old.settings, ...input.settings },
        });
        await c.query(
          'INSERT INTO cam.ui_preferences(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=now()',
          [p.id, data],
        );
        return data;
      }
      return cleanUi(
        (await c.query('SELECT data FROM cam.ui_preferences WHERE user_id=$1', [p.id])).rows[0]
          ?.data,
      );
    });
  }
}
export class ChannelAvailability {
  constructor(db) {
    this.db = db;
  }
  async observe(event) {
    if (!event.viewer || event.stopped) return;
    const observedAt = event.observedAt ?? Date.now();
    if (!Number.isFinite(observedAt) || observedAt <= 0 || observedAt > Date.now() + 1000) return;
    return this.db.session(event.viewer, async (c, p) => {
      if (p.tenantId !== event.tenantId) return;
      const state = event.ok
        ? 'working'
        : ['recorder-offline', 'channel-unavailable'].includes(event.code)
          ? 'unavailable'
          : 'unknown';
      await c.query(
        `INSERT INTO cam.channel_health(tenant_id,device_id,channel,state,code,checked_at) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(tenant_id,device_id,channel) DO UPDATE SET state=excluded.state,code=excluded.code,checked_at=excluded.checked_at
      WHERE cam.channel_health.checked_at<=excluded.checked_at`,
        [
          p.tenantId,
          event.deviceId,
          event.channel,
          state,
          event.ok ? null : String(event.code ?? 'connection-failed').slice(0, 80),
          new Date(observedAt),
        ],
      );
    });
  }
  annotate(token, devices) {
    return this.db.session(tokenHash(token), async (c) => {
      const rows = (
        await c.query(
          "SELECT device_id,channel,state,code,checked_at FROM cam.channel_health WHERE checked_at>now()-interval '5 minutes'",
        )
      ).rows;
      return devices.map((d) => ({
        ...d,
        channels: d.channels.map((ch) => {
          const known = rows.find((r) => r.device_id === d.id && r.channel === ch.number);
          return {
            ...ch,
            health: d.status === 'offline' ? 'unavailable' : (known?.state ?? 'unknown'),
            healthCode: known?.code ?? null,
            healthCheckedAt: known?.checked_at ?? null,
          };
        }),
      }));
    });
  }
}
