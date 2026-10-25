import { Viewer, slotNumber } from '../vendor/windows-sdk/lib/viewer.mjs';
import { NativeLive } from '../vendor/windows-sdk/lib/live.mjs';
import { PreviewCache } from '../vendor/windows-sdk/lib/previews.mjs';
import { sdkReady, providerConnectionId, providerVersion } from './provider-state.mjs';
import { HttpError } from './database.mjs';
import { tokenHash } from './auth.mjs';
export class MediaHub {
  constructor(
    auth,
    cameras,
    { createLive = (...args) => new NativeLive(...args), maxStreams = 32, tenantStreams = 16 } = {},
  ) {
    Object.assign(this, { auth, cameras, createLive, maxStreams, tenantStreams });
    this.viewers = new Map();
    this.caches = new Map();
    this.previews = new Set();
  }
  viewer(token, principal) {
    const key = tokenHash(token);
    let entry = this.viewers.get(key);
    if (!entry) {
      entry = { tenantId: principal.tenantId, userId: principal.id, viewer: new Viewer() };
      this.viewers.set(key, entry);
    }
    if (entry.tenantId !== principal.tenantId || entry.userId !== principal.id)
      throw new HttpError('Session workspace changed.', 401, 'viewer-auth-required');
    return entry.viewer;
  }
  closeUser(id) {
    for (const [key, entry] of this.viewers)
      if (entry.userId === id) {
        entry.viewer.close();
        this.viewers.delete(key);
      }
  }
  closeSession(token) {
    const key = tokenHash(token);
    this.viewers.get(key)?.viewer.close();
    this.viewers.delete(key);
  }
  closeTenant(id) {
    for (const [key, entry] of this.viewers)
      if (entry.tenantId === id) {
        entry.viewer.close();
        this.viewers.delete(key);
      }
    this.caches.get(id)?.clear();
    for (const live of this.previews) if (live.tenantId === id) live.stop();
  }
  close() {
    for (const entry of this.viewers.values()) entry.viewer.close();
    this.viewers.clear();
    for (const live of this.previews) live.stop();
    this.previews.clear();
  }
  async reap() {
    for (const [hash, entry] of this.viewers)
      try {
        await this.auth.db.session(hash, async () => {});
        for (const slot of entry.viewer.slots.values())
          if (slot.live && !['failed', 'stopped'].includes(slot.live.state))
            try {
              const fresh = await this.cameras.mediaByHash(
                hash,
                slot.live.deviceId,
                slot.live.channel,
              );
              if (!sdkReady(fresh.provider)) entry.viewer.stop(slot.id);
            } catch (error) {
              if ([401, 403, 409].includes(error.status)) entry.viewer.stop(slot.id);
            }
      } catch (error) {
        if (error.status === 401) {
          entry.viewer.close();
          this.viewers.delete(hash);
        }
      }
  }
  count(tenantId, exclude) {
    let count = 0;
    for (const entry of this.viewers.values())
      if (!tenantId || entry.tenantId === tenantId)
        for (const slot of entry.viewer.slots.values())
          if (
            slot !== exclude &&
            (slot.starting || (slot.live && !['failed', 'stopped'].includes(slot.live.state)))
          )
            count++;
    return (
      count + [...this.previews].filter((live) => !tenantId || live.tenantId === tenantId).length
    );
  }
  async start(token, principal, input) {
    const channel = Number(input.channel);
    if (
      typeof input.deviceId !== 'string' ||
      !Number.isInteger(channel) ||
      channel < 1 ||
      channel > 1024 ||
      !['hd', 'sd'].includes(input.quality) ||
      !['mjpeg', 'smooth'].includes(input.delivery || 'mjpeg')
    )
      throw new HttpError('Choose a valid camera, quality and playback mode.');
    let id;
    try {
      id = slotNumber(input.slot ?? 0);
    } catch {
      throw new HttpError('Invalid camera tile.');
    }
    const { device, provider } = await this.cameras.media(token, input.deviceId, channel);
    const health = {
      tenantId: principal.tenantId,
      viewer: tokenHash(token),
      slot: id,
      deviceId: device.id,
      recorderName: device.name,
      channel,
    };
    if (!sdkReady(provider)) {
      this.onStreamHealth?.({ ...health, ok: false, code: 'playback-auth-required' });
      throw new HttpError(
        'Playback authorization is missing or expired. Ask your workspace admin to reconnect.',
        409,
        'playback-auth-required',
      );
    }
    if (device.status === 'offline') {
      this.onStreamHealth?.({ ...health, ok: false, code: 'recorder-offline' });
      throw new HttpError('Hik-Connect reports this recorder offline.', 409, 'recorder-offline');
    }
    const viewer = this.viewer(token, principal),
      slot = viewer.slot(id);
    if (slot.starting) throw new HttpError('This camera tile is already connecting.', 409);
    if (
      this.count(null, slot) >= this.maxStreams ||
      this.count(principal.tenantId, slot) >= this.tenantStreams
    )
      throw new HttpError(
        'The camera connection limit is reached. Stop another camera first.',
        409,
        'stream-limit',
      );
    if (slot.live?.deviceId === device.id && slot.live?.channel === channel)
      slot.live.healthReplaced = true;
    viewer.stop(id);
    slot.starting = true;
    const generation = slot.generation;
    let reported = false;
    const failed = (error) => {
      if (reported) return;
      reported = true;
      this.onStreamHealth?.({ ...health, ok: false, code: error?.code || 'stream-interrupted' });
    };
    try {
      const live = (slot.live = this.createLive(provider, device, channel, input.quality, {
        delivery: input.delivery || 'mjpeg',
      }));
      viewer.attach(slot);
      live.on?.('ended', () => {
        if (live.state === 'failed') {
          failed({ code: live.errorCode });
          if (['sdk-start-failed', 'playback-rejected'].includes(live.errorCode))
            this.onPlaybackFailure?.(principal.tenantId);
        } else if (live.state === 'stopped' && !live.healthReplaced)
          this.onStreamHealth?.({ ...health, ok: true, stopped: true });
      });
      const result = await live.ready;
      await this.auth.principal(token);
      const fresh = await this.cameras.media(token, input.deviceId, channel);
      if (
        slot.generation !== generation ||
        providerConnectionId(fresh.provider) !== providerConnectionId(provider)
      ) {
        live.stop();
        throw new HttpError(
          'The camera account changed. Refresh and try again.',
          409,
          'account-changed',
        );
      }
      if (providerVersion(fresh.provider) !== providerVersion(provider)) {
        live.healthReplaced = true;
        live.stop();
        throw new HttpError(
          'Camera access was updated while connecting. Retrying this camera.',
          409,
          'authorization-updated',
        );
      }
      this.onStreamHealth?.({ ...health, ok: true });
      return { slot: id, ...result };
    } catch (error) {
      if (error.status !== 409 && error.status !== 401 && error.status !== 403) failed(error);
      if (['sdk-start-failed', 'playback-rejected'].includes(error.code))
        this.onPlaybackFailure?.(principal.tenantId);
      throw error;
    } finally {
      slot.starting = false;
    }
  }
  async preview(token, principal, deviceId, channel) {
    const { device, provider } = await this.cameras.media(token, deviceId, channel);
    if (!sdkReady(provider))
      throw new HttpError('Playback access must be reauthorized.', 409, 'playback-auth-required');
    if (device.status !== 'online')
      throw new HttpError('The recorder is offline.', 409, 'recorder-offline');
    let cache = this.caches.get(principal.tenantId);
    if (!cache) {
      cache = new PreviewCache();
      this.caches.set(principal.tenantId, cache);
    }
    const connection = providerConnectionId(provider);
    const image = await cache.get(`${connection}:${deviceId}:${channel}`, async () => {
      for (const entry of this.viewers.values())
        if (entry.tenantId === principal.tenantId)
          for (const slot of entry.viewer.slots.values())
            if (
              slot.live?.deviceId === deviceId &&
              slot.live?.channel === channel &&
              slot.live.state === 'playing'
            )
              return slot.live.preview();
      if (this.count() >= this.maxStreams || this.count(principal.tenantId) >= this.tenantStreams)
        throw new HttpError('Previews are waiting for a free connection.', 409, 'stream-limit');
      const live = this.createLive(provider, device, channel, 'sd', {
        previewOnly: true,
        delivery: 'mjpeg',
      });
      live.tenantId = principal.tenantId;
      this.previews.add(live);
      try {
        return await live.preview();
      } finally {
        live.stop();
        this.previews.delete(live);
      }
    });
    await this.auth.principal(token);
    const fresh = await this.cameras.media(token, deviceId, channel);
    if (providerConnectionId(fresh.provider) !== connection)
      throw new HttpError('Camera account changed.', 409, 'account-changed');
    return image;
  }
}
