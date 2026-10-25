import { randomUUID, createHash } from 'node:crypto';
import { tokenHash } from './auth.mjs';
import { HttpError } from './database.mjs';
import { requireAccess, canManageTenant, canAccessCamera } from './access.mjs';
import { createHikClient, HikError } from '../vendor/windows-sdk/lib/hik-connect.mjs';
import { signInPersonal } from '../vendor/windows-sdk/lib/personal-client.mjs';
import {
  installedDesktopToken,
  validateSdkAccess,
} from '../vendor/windows-sdk/lib/desktop-sdk.mjs';
import { sdkReady, providerStatus, providerVersion, expiryHint } from './provider-state.mjs';
import { cleanPreferences } from '../vendor/windows-sdk/lib/preferences.mjs';
import { writeAudit } from './audit.mjs';

export class Cameras {
  constructor(
    db,
    cipher,
    {
      hik = createHikClient(),
      personal = signInPersonal,
      desktopToken = installedDesktopToken,
      verifySdk = validateSdkAccess,
    } = {},
  ) {
    Object.assign(this, { db, cipher, hik, personal, desktopToken, verifySdk });
  }
  async adminProvider(token) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canManageTenant(principal, principal.tenantId));
      const row = (
        await client.query('SELECT payload FROM cam.providers WHERE tenant_id=$1', [
          principal.tenantId,
        ])
      ).rows[0];
      return {
        principal,
        provider: row ? this.cipher.open(row.payload, principal.tenantId) : null,
      };
    });
  }
  async status(token) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      let provider = null,
        noAssignments = false;
      if (principal.role === 'admin') {
        const row = (
          await client.query('SELECT payload FROM cam.providers WHERE tenant_id=$1', [
            principal.tenantId,
          ])
        ).rows[0];
        if (row) provider = this.cipher.open(row.payload, principal.tenantId);
      } else if (principal.role === 'member') {
        const devices = await this.deviceRows(client, principal);
        const device = devices.find((device) => device.channels.length);
        noAssignments = !device;
        if (device) {
          const row = (
            await client.query('SELECT cam.media_provider($1,$2) AS payload', [
              device.id,
              device.channels[0].number,
            ])
          ).rows[0];
          if (row?.payload) provider = this.cipher.open(row.payload, principal.tenantId);
        }
      } else throw new HttpError('Camera access belongs to a workspace.', 403, 'access-denied');
      const status = providerStatus(provider);
      if (principal.role === 'member') {
        status.user = null;
        status.accountId = status.accountId ? principal.tenantId : null;
      }
      return {
        ...status,
        noAssignments,
        canManage: principal.role === 'admin',
        maxStreams: 16,
        talkSource: null,
        playbackRecovery:
          process.platform === 'win32' && principal.role === 'admin'
            ? 'installed-client'
            : 'external-authorization',
      };
    });
  }
  async saveProvider(token, provider, previous) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canManageTenant(principal, principal.tenantId));
      const current = (
        await client.query('SELECT payload FROM cam.providers WHERE tenant_id=$1 FOR UPDATE', [
          principal.tenantId,
        ])
      ).rows[0];
      const present = current ? this.cipher.open(current.payload, principal.tenantId) : null;
      if (providerVersion(present) !== providerVersion(previous))
        throw new HttpError('The camera account changed. Try again.', 409, 'account-changed');
      const changed = Boolean(
        present?.accountUserId && present.accountUserId !== provider?.accountUserId,
      );
      if (changed) {
        await client.query('DELETE FROM cam.grants WHERE tenant_id=$1', [principal.tenantId]);
        const members = await client.query(
          "SELECT id FROM cam.users WHERE tenant_id=$1 AND role='member'",
          [principal.tenantId],
        );
        for (const member of members.rows)
          await client.query('SELECT cam.revoke_user($1)', [member.id]);
      }
      const key = provider?.accountUserId
        ? createHash('sha256').update(provider.accountUserId).digest('hex')
        : '';
      if (provider) {
        provider.credentialVersion = randomUUID();
        await client.query(
          'INSERT INTO cam.providers(tenant_id,payload,account_key) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET payload=excluded.payload,account_key=excluded.account_key,updated_at=now()',
          [principal.tenantId, this.cipher.seal(provider, principal.tenantId), key],
        );
      } else
        await client.query('DELETE FROM cam.providers WHERE tenant_id=$1', [principal.tenantId]);
      await client.query('UPDATE cam.devices SET available=false WHERE tenant_id=$1', [
        principal.tenantId,
      ]);
      await writeAudit(client, {
        tenantId: principal.tenantId,
        actorId: principal.id,
        action: provider ? 'provider.connected' : 'provider.disconnected',
        details: {
          targetName:
            (provider || present)?.user?.email ||
            (provider || present)?.user?.username ||
            'Hik-Connect account',
          reason:
            changed && provider
              ? 'Account switched'
              : provider
                ? 'Connection saved'
                : 'Connection removed',
        },
      });
      return { tenantId: principal.tenantId, changed };
    });
  }
  async connect(token, input) {
    const { provider: previous } = await this.adminProvider(token);
    const result = await this.personal(input),
      credentials = result.credentials;
    if (
      !credentials?.sessionId ||
      !['https://iindia.hik-connect.com', 'https://www.hik-connect.com'].includes(
        credentials.origin,
      )
    )
      throw new HttpError('Hik-Connect sign-in could not be completed.', 502);
    const retained =
      previous?.accountUserId &&
      previous.accountUserId === credentials.accountUserId &&
      sdkReady(previous)
        ? {
            sdkAccessToken: previous.sdkAccessToken,
            sdkExpiresAt: previous.sdkExpiresAt,
            sdkSource: previous.sdkSource,
            sdkValidatedAt: previous.sdkValidatedAt,
          }
        : {};
    const same = previous?.accountUserId && previous.accountUserId === credentials.accountUserId;
    if (!credentials.accountUserId)
      throw new HttpError('Hik-Connect did not identify the signed-in account. Try again.', 502);
    const provider = {
      ...retained,
      sessionId: credentials.sessionId,
      origin: credentials.origin,
      accountUserId: credentials.accountUserId,
      user: credentials.user || {},
      connectionRevision: same ? previous.connectionRevision : randomUUID(),
      connectedAt: Date.now(),
      needsReconnect: false,
      webExpiresAt: credentials.webExpiresAt || expiryHint(credentials.sessionId),
      recovery: {
        webEnabled: input.automaticReconnect === true,
        playbackEnabled: process.platform === 'win32' && input.automaticPlayback === true,
        ...(input.automaticReconnect === true
          ? {
              secret: {
                account: input.account,
                password: input.password,
                origin: credentials.origin,
              },
            }
          : {}),
        web: {},
        playback: {},
      },
      ...(credentials.sdkAccessToken
        ? { sdkAccessToken: credentials.sdkAccessToken, sdkExpiresAt: credentials.sdkExpiresAt }
        : {}),
    };
    return this.saveProvider(token, provider, previous);
  }
  async desktop(token) {
    const { provider } = await this.adminProvider(token);
    if (!provider?.sessionId || provider.needsReconnect)
      throw new HttpError('Reconnect Hik-Connect first.', 409, 'provider-auth-required');
    const sharing = await this.hik.sharing(provider),
      device = sharing.devices?.find((device) => device.channels?.length);
    if (!device)
      throw new HttpError('A shared recorder channel is required to check playback access.', 409);
    const sdkAccessToken = await this.desktopToken(),
      result = await this.verifySdk(sdkAccessToken, device, device.channels[0].number);
    return this.saveProvider(
      token,
      {
        ...provider,
        sdkAccessToken,
        sdkSource: 'installed-client',
        sdkExpiresAt: null,
        sdkValidatedAt: result.validatedAt,
        playbackNeedsReconnect: false,
      },
      provider,
    );
  }
  async deviceRows(client, principal) {
    const rows = await client.query(
      'SELECT data,checked_at FROM cam.devices WHERE tenant_id=$1 AND available ORDER BY device_id',
      [principal.tenantId],
    );
    const grants =
      principal.role === 'member'
        ? (
            await client.query(
              'SELECT device_id,channels,can_view,can_record,can_download FROM cam.grants WHERE tenant_id=$1 AND user_id=$2 AND can_view',
              [principal.tenantId, principal.id],
            )
          ).rows
        : [];
    return rows.rows.map((row) => {
      const device = row.data,
        grant = grants.find((grant) => grant.device_id === device.id);
      const channels = (device.channels || [])
        .filter(
          (channel) =>
            principal.role === 'admin' ||
            (grant && (grant.channels === null || grant.channels.includes(channel.number))),
        )
        .map((channel) => ({
          number: channel.number,
          name: channel.name,
          canRecord: principal.role === 'admin' || grant?.can_record === true,
          canDownload: principal.role === 'admin' || grant?.can_download === true,
        }));
      return {
        id: device.id,
        name: device.name,
        status: device.status || 'unknown',
        source: device.source,
        channels,
        checkedAt: row.checked_at,
      };
    });
  }
  async markWebExpired(token, previous) {
    return this.db.session(tokenHash(token), async (client, user) => {
      requireAccess(canManageTenant(user, user.tenantId));
      const current = (
        await client.query('SELECT payload FROM cam.providers WHERE tenant_id=$1 FOR UPDATE', [
          user.tenantId,
        ])
      ).rows[0];
      if (!current) return;
      const provider = this.cipher.open(current.payload, user.tenantId);
      if (providerVersion(provider) !== providerVersion(previous)) return;
      if (provider.needsReconnect) return;
      provider.needsReconnect = true;
      provider.credentialVersion = randomUUID();
      await client.query(
        'UPDATE cam.providers SET payload=$1,updated_at=now() WHERE tenant_id=$2',
        [this.cipher.seal(provider, user.tenantId), user.tenantId],
      );
    });
  }
  async disableRecovery(token) {
    return this.db.session(tokenHash(token), async (client, user) => {
      requireAccess(canManageTenant(user, user.tenantId));
      const current = (
        await client.query('SELECT payload FROM cam.providers WHERE tenant_id=$1 FOR UPDATE', [
          user.tenantId,
        ])
      ).rows[0];
      if (!current) return;
      const provider = this.cipher.open(current.payload, user.tenantId);
      provider.recovery = { webEnabled: false, playbackEnabled: false };
      provider.credentialVersion = randomUUID();
      await client.query(
        'UPDATE cam.providers SET payload=$1,updated_at=now() WHERE tenant_id=$2',
        [this.cipher.seal(provider, user.tenantId), user.tenantId],
      );
      await client.query('INSERT INTO cam.audit(tenant_id,actor_id,action) VALUES($1,$2,$3)', [
        user.tenantId,
        user.id,
        'provider.recovery_disabled',
      ]);
    });
  }
  async devices(token, refresh = true) {
    const principal = await this.db.session(tokenHash(token), async (_client, user) => user);
    if (principal.role === 'admin' && refresh) {
      const { provider } = await this.adminProvider(token);
      if (!provider?.sessionId || provider.needsReconnect)
        throw new HttpError('Reconnect your Hik-Connect account.', 409, 'provider-auth-required');
      let devices;
      try {
        const [owned, shared] = await Promise.all([
          this.hik.devices(provider),
          this.hik.sharing(provider),
        ]);
        devices = [...owned, ...(shared.devices || [])];
      } catch (error) {
        if (error instanceof HikError && error.status === 401) {
          await this.markWebExpired(token, provider);
          throw new HttpError(
            'Hik-Connect sign-in expired. Reconnect your account.',
            409,
            'provider-auth-required',
          );
        }
        throw error;
      }
      await this.db.session(tokenHash(token), async (client, user) => {
        const current = (
          await client.query('SELECT payload FROM cam.providers WHERE tenant_id=$1', [
            user.tenantId,
          ])
        ).rows[0];
        if (
          !current ||
          providerVersion(this.cipher.open(current.payload, user.tenantId)) !==
            providerVersion(provider)
        )
          throw new HttpError(
            'The camera account changed. Refresh and try again.',
            409,
            'account-changed',
          );
        await client.query('UPDATE cam.devices SET available=false WHERE tenant_id=$1', [
          user.tenantId,
        ]);
        for (const device of devices)
          await client.query(
            'INSERT INTO cam.devices(tenant_id,device_id,data) VALUES($1,$2,$3) ON CONFLICT(tenant_id,device_id) DO UPDATE SET data=excluded.data,available=true,checked_at=now()',
            [user.tenantId, device.id, device],
          );
      });
    }
    return this.db.session(tokenHash(token), async (client, user) => {
      const devices = await this.deviceRows(client, user);
      return {
        devices,
        checkedAt: devices.reduce(
          (latest, device) =>
            new Date(device.checkedAt) > new Date(latest) ? device.checkedAt : latest,
          new Date(0),
        ),
        sharing: { state: 'workspace' },
        playbackReady: true,
      };
    });
  }
  async media(token, deviceId, channel, permission = 'view', { providerRequired = true } = {}) {
    return this.mediaByHash(tokenHash(token), deviceId, channel, permission, { providerRequired });
  }
  async mediaByHash(
    hash,
    deviceId,
    channel,
    permission = 'view',
    { providerRequired = true } = {},
  ) {
    return this.db.session(hash, async (client, user) => {
      const row = (
        await client.query(
          'SELECT data,available FROM cam.devices WHERE tenant_id=$1 AND device_id=$2',
          [user.tenantId, deviceId],
        )
      ).rows[0];
      if (
        !row ||
        (providerRequired && !row.available) ||
        !row?.data.channels?.some((item) => item.number === channel)
      )
        throw new HttpError('This camera channel is unavailable.', 403, 'channel-unavailable');
      const grants = (
        await client.query(
          'SELECT user_id,tenant_id,device_id,channels,can_view,can_record,can_download FROM cam.grants WHERE tenant_id=$1 AND user_id=$2',
          [user.tenantId, user.id],
        )
      ).rows.map((grant) => ({
        userId: grant.user_id,
        tenantId: grant.tenant_id,
        deviceId: grant.device_id,
        channels: grant.channels,
        view: grant.can_view,
        record: grant.can_record,
        download: grant.can_download,
      }));
      requireAccess(
        canAccessCamera(user, { tenantId: user.tenantId, deviceId, channel }, permission, grants),
      );
      if (!providerRequired) return { principal: user, device: row.data };
      const sealed = (
        await client.query('SELECT cam.media_provider($1,$2) AS payload', [deviceId, channel])
      ).rows[0]?.payload;
      if (!sealed)
        throw new HttpError(
          'The workspace admin must connect Hik-Connect.',
          409,
          'provider-auth-required',
        );
      const provider = this.cipher.open(sealed, user.tenantId);
      if (provider.needsReconnect)
        throw new HttpError(
          'Your workspace admin must reconnect Hik-Connect.',
          409,
          'provider-auth-required',
        );
      return { principal: user, device: row.data, provider };
    });
  }
  async preferences(token, input) {
    return this.db.session(tokenHash(token), async (client, user) => {
      const key = (await client.query('SELECT cam.provider_account_key() AS key')).rows[0].key;
      if (input !== undefined) {
        let value;
        try {
          value = cleanPreferences(input);
        } catch {
          throw new HttpError(
            'Choose valid saved layouts and camera settings.',
            400,
            'invalid-preferences',
          );
        }
        await client.query(
          'INSERT INTO cam.preferences(tenant_id,user_id,account_key,data) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,user_id,account_key) DO UPDATE SET data=excluded.data',
          [user.tenantId, user.id, key, value],
        );
        return value;
      }
      return (
        (
          await client.query(
            'SELECT data FROM cam.preferences WHERE tenant_id=$1 AND user_id=$2 AND account_key=$3',
            [user.tenantId, user.id, key],
          )
        ).rows[0]?.data || {}
      );
    });
  }
}
