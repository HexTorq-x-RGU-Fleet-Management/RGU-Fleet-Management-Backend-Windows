import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { RecordingStore } from './recordings.mjs';
import { canAccessCamera } from './access.mjs';
import { tokenHash } from './auth.mjs';
import { auditDetails } from './audit.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class TenantStorage {
  constructor(directory, db) {
    this.directory = path.resolve(directory, 'tenants');
    this.db = db;
    this.stores = new Map();
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const item of await readdir(this.directory, { withFileTypes: true }))
      if (item.isDirectory() && uuid.test(item.name)) await this.store(item.name);
    return this;
  }
  store(id) {
    if (!uuid.test(id || '')) throw new Error('Invalid workspace storage scope.');
    let store = this.stores.get(id);
    if (!store) {
      store = new RecordingStore(path.join(this.directory, id, 'recordings'), {
        onPrune: async (phase, clip, reason) => {
          const action = {
            requested: 'recording.cleanup_requested',
            completed: 'recording.cleaned',
            failed: 'recording.cleanup_failed',
          }[phase];
          await this.db.pool.query('SELECT cam.audit_recording_cleanup($1,$2,$3,$4)', [
            id,
            clip.id,
            action,
            auditDetails({
              targetName: clip.name,
              recorderName: clip.recorderName,
              cameraName: clip.cameraName,
              reason,
            }),
          ]);
        },
      }).open();
      this.stores.set(id, store);
      store.catch(() => this.stores.delete(id));
    }
    return store;
  }
  async cleanup() {
    for (const store of this.stores.values()) await (await store).cleanup();
  }
  async permissions(token, clips) {
    return this.db.session(tokenHash(token), async (client, user) => {
      const grants = (
        await client.query(
          'SELECT user_id,tenant_id,device_id,channels,can_view,can_download,can_record FROM cam.grants WHERE tenant_id=$1 AND user_id=$2',
          [user.tenantId, user.id],
        )
      ).rows.map((g) => ({
        tenantId: g.tenant_id,
        userId: g.user_id,
        deviceId: g.device_id,
        channels: g.channels,
        view: g.can_view,
        download: g.can_download,
        record: g.can_record,
      }));
      return clips.map((clip) => ({
        clip,
        view: canAccessCamera(
          user,
          { tenantId: user.tenantId, deviceId: clip.deviceId, channel: clip.channel },
          'view',
          grants,
        ),
        download: canAccessCamera(
          user,
          { tenantId: user.tenantId, deviceId: clip.deviceId, channel: clip.channel },
          'download',
          grants,
        ),
        remove: user.role === 'admin',
      }));
    });
  }
  async list(token, user) {
    const result = await (await this.store(user.tenantId)).list();
    const permissions = await this.permissions(token, result.clips);
    return {
      clips: permissions
        .filter((item) => item.view)
        .map((item) => ({ ...item.clip, canDownload: item.download, canDelete: item.remove })),
      storage: user.role === 'admin' ? result.storage : null,
    };
  }
}
