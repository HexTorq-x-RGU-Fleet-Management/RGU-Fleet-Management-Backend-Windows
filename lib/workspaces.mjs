import { randomUUID } from 'node:crypto';
import { tokenHash, hashPassword, validEmail, text } from './auth.mjs';
import { canApproveAdmins, canManageTenant, memberGrants, requireAccess } from './access.mjs';
import { HttpError } from './database.mjs';
import { writeAudit } from './audit.mjs';
const safeColumns =
  'u.id,u.tenant_id,u.email,u.full_name,u.role,u.status,u.must_change_password,u.created_at';
const mapUser = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  email: row.email,
  fullName: row.full_name,
  role: row.role,
  status: row.status,
  mustChangePassword: row.must_change_password,
  createdAt: row.created_at,
});
export class Workspaces {
  constructor(db) {
    this.db = db;
  }
  async platform(token) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canApproveAdmins(principal));
      const result = await client.query(
        `SELECT ${safeColumns},t.name AS workspace_name,t.status AS workspace_status FROM cam.users u JOIN cam.tenants t ON t.id=u.tenant_id WHERE u.role='admin' ORDER BY u.created_at DESC LIMIT 500`,
      );
      return {
        workspaces: result.rows.map((row) => ({
          ...mapUser(row),
          workspaceName: row.workspace_name,
          workspaceStatus: row.workspace_status,
        })),
      };
    });
  }
  async decide(token, id, action) {
    if (!['approve', 'reject', 'suspend', 'restore'].includes(action))
      throw new HttpError('Choose an available approval action.');
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canApproveAdmins(principal));
      const user = (
        await client.query(
          "SELECT id,tenant_id,status,full_name,email FROM cam.users WHERE id=$1 AND role='admin' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!user) throw new HttpError('Workspace request not found.', 404);
      const before = {
        approve: 'pending',
        reject: 'pending',
        suspend: 'active',
        restore: 'suspended',
      }[action];
      if (user.status !== before)
        throw new HttpError('This request changed. Refresh the list.', 409);
      const after = {
        approve: 'active',
        reject: 'rejected',
        suspend: 'suspended',
        restore: 'active',
      }[action];
      await client.query('UPDATE cam.users SET status=$1 WHERE id=$2', [after, id]);
      await client.query('UPDATE cam.tenants SET status=$1 WHERE id=$2', [after, user.tenant_id]);
      await client.query('SELECT cam.revoke_tenant($1)', [user.tenant_id]);
      await writeAudit(client, {
        tenantId: user.tenant_id,
        actorId: principal.id,
        action: 'workspace.' + action,
        targetId: id,
        details: {
          targetName: user.full_name,
          targetEmail: user.email,
          changes: [`Workspace status: ${before} -> ${after}`],
        },
      });
      return { tenantId: user.tenant_id, status: after };
    });
  }
  async platformUsers(token, tenantId) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canApproveAdmins(principal));
      const tenant = (
        await client.query('SELECT id,name,status FROM cam.tenants WHERE id=$1', [tenantId])
      ).rows[0];
      if (!tenant) throw new HttpError('Workspace not found.', 404);
      const users = await client.query(
        `SELECT ${safeColumns} FROM cam.users u WHERE u.tenant_id=$1 AND u.role IN ('admin','member') ORDER BY u.role,u.full_name,u.id`,
        [tenantId],
      );
      return { workspace: tenant, users: users.rows.map(mapUser) };
    });
  }
  async resetPlatformPassword(token, id, input) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canApproveAdmins(principal));
      const user = (
        await client.query(
          "SELECT id,tenant_id,role,status,full_name,email FROM cam.users WHERE id=$1 AND tenant_id IS NOT NULL AND role IN ('admin','member') FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!user) throw new HttpError('Workspace user not found.', 404);
      const password = await hashPassword(input.password);
      await client.query(
        'UPDATE cam.users SET password_salt=$1,password_hash=$2,must_change_password=true WHERE id=$3',
        [password.salt, password.hash, id],
      );
      await client.query('SELECT cam.revoke_user($1)', [id]);
      await writeAudit(client, {
        tenantId: user.tenant_id,
        actorId: principal.id,
        action: 'user.password_reset',
        targetId: id,
        details: {
          targetName: user.full_name,
          targetEmail: user.email,
          changes: ['Temporary password set; sessions revoked; password change required.'],
        },
      });
      return { id: user.id, status: user.status, mustChangePassword: true };
    });
  }
  async members(token) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canManageTenant(principal, principal.tenantId));
      const users = await client.query(
        `SELECT ${safeColumns} FROM cam.users u WHERE u.tenant_id=$1 AND u.role='member' ORDER BY u.created_at DESC`,
        [principal.tenantId],
      );
      const grants = await client.query(
        'SELECT user_id,device_id,channels,can_view,can_download,can_record FROM cam.grants WHERE tenant_id=$1',
        [principal.tenantId],
      );
      const devices = await client.query(
        'SELECT device_id,data,available FROM cam.devices WHERE tenant_id=$1 ORDER BY device_id',
        [principal.tenantId],
      );
      return {
        users: users.rows.map((row) => ({
          ...mapUser(row),
          grants: grants.rows
            .filter((g) => g.user_id === row.id)
            .map((g) => ({
              deviceId: g.device_id,
              channels: g.channels,
              view: g.can_view,
              download: g.can_download,
              record: g.can_record,
            })),
        })),
        devices: devices.rows.map((row) => ({
          id: row.device_id,
          name: row.data.name,
          channels: row.data.channels || [],
          available: row.available,
        })),
      };
    });
  }
  async createMember(token, input) {
    const email = validEmail(input.email),
      fullName = text(input.fullName, 'name'),
      password = await hashPassword(input.password);
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canManageTenant(principal, principal.tenantId));
      const id = randomUUID();
      await client.query(
        "INSERT INTO cam.users(id,tenant_id,email,full_name,role,status,password_salt,password_hash,must_change_password) VALUES($1,$2,$3,$4,'member','active',$5,$6,true)",
        [id, principal.tenantId, email, fullName, password.salt, password.hash],
      );
      await writeAudit(client, {
        tenantId: principal.tenantId,
        actorId: principal.id,
        action: 'member.created',
        targetId: id,
        details: { targetName: fullName, targetEmail: email },
      });
      return { id, status: 'active' };
    });
  }
  async editMember(token, id, input) {
    return this.db.session(tokenHash(token), async (client, principal) => {
      requireAccess(canManageTenant(principal, principal.tenantId));
      const row = (
        await client.query(
          "SELECT id,tenant_id,role,status,full_name,email FROM cam.users WHERE id=$1 AND tenant_id=$2 AND role='member' FOR UPDATE",
          [id, principal.tenantId],
        )
      ).rows[0];
      if (!row) throw new HttpError('Member not found.', 404);
      const details = { targetName: row.full_name, targetEmail: row.email };
      if (input.status !== undefined) {
        if (!['active', 'suspended'].includes(input.status))
          throw new HttpError('Choose active or suspended.');
        await client.query('UPDATE cam.users SET status=$1 WHERE id=$2', [input.status, id]);
        if (input.status !== row.status)
          await writeAudit(client, {
            tenantId: principal.tenantId,
            actorId: principal.id,
            action: input.status === 'suspended' ? 'member.suspended' : 'member.restored',
            targetId: id,
            details: { ...details, changes: [`Account status: ${row.status} -> ${input.status}`] },
          });
      }
      if (input.password !== undefined) {
        const password = await hashPassword(input.password);
        await client.query(
          'UPDATE cam.users SET password_salt=$1,password_hash=$2,must_change_password=true WHERE id=$3',
          [password.salt, password.hash, id],
        );
        await writeAudit(client, {
          tenantId: principal.tenantId,
          actorId: principal.id,
          action: 'member.password_reset',
          targetId: id,
          details,
        });
      }
      if (input.grants !== undefined) {
        const devices = (
          await client.query('SELECT device_id,data FROM cam.devices WHERE tenant_id=$1', [
            principal.tenantId,
          ])
        ).rows.map((d) => ({
          tenantId: principal.tenantId,
          deviceId: d.device_id,
          name: d.data.name,
        }));
        const grants = memberGrants(
          principal,
          principal.tenantId,
          { id, role: row.role, status: 'active', tenantId: row.tenant_id, tenantStatus: 'active' },
          input.grants,
          devices,
        );
        await client.query('DELETE FROM cam.grants WHERE tenant_id=$1 AND user_id=$2', [
          principal.tenantId,
          id,
        ]);
        for (const grant of grants)
          await client.query(
            'INSERT INTO cam.grants(tenant_id,user_id,device_id,channels,can_view,can_download,can_record) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              principal.tenantId,
              id,
              grant.deviceId,
              grant.channels,
              grant.view,
              grant.download,
              grant.record,
            ],
          );
        const changes = grants
          .slice(0, 20)
          .map(
            (g) =>
              `${devices.find((d) => d.deviceId === g.deviceId)?.name || 'Recorder'}: View ${g.view ? 'on' : 'off'}, Download ${g.download ? 'on' : 'off'}, Record ${g.record ? 'on' : 'off'}; ${g.channels === null ? 'all channels' : g.channels.length + ' selected channels'}`,
          );
        if (!grants.length) changes.push('All recorder permissions removed.');
        if (grants.length > 20)
          changes.push(`${grants.length - 20} additional recorder rules saved.`);
        await writeAudit(client, {
          tenantId: principal.tenantId,
          actorId: principal.id,
          action: 'member.permissions_changed',
          targetId: id,
          details: { ...details, changes },
        });
      }
      await client.query('SELECT cam.revoke_user($1)', [id]);
      if (input.status === undefined && input.password === undefined && input.grants === undefined)
        await writeAudit(client, {
          tenantId: principal.tenantId,
          actorId: principal.id,
          action: 'member.updated',
          targetId: id,
          details,
        });
      return { id, updated: true };
    });
  }
}
