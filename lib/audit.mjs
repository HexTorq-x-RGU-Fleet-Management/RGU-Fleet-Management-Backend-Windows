import { tokenHash } from './auth.mjs';
import { HttpError } from './database.mjs';
import { requireAccess } from './access.mjs';
export const auditCategories = {
  workspaces: [
    'admin.requested',
    'workspace.approve',
    'workspace.reject',
    'workspace.suspend',
    'workspace.restore',
  ],
  users: [
    'member.created',
    'member.updated',
    'member.permissions_changed',
    'member.suspended',
    'member.restored',
    'member.password_reset',
    'user.password_reset',
  ],
  accounts: [
    'provider.connected',
    'provider.disconnected',
    'provider.recovered',
    'provider.recovery_attention',
    'provider.recovery_disabled',
  ],
  recordings: [
    'recording.delete_requested',
    'recording.deleted',
    'recording.delete_failed',
    'recording.cleanup_requested',
    'recording.cleaned',
    'recording.cleanup_failed',
    'recording.policy_changed',
  ],
};
export function auditDetails(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const result = {};
  for (const key of ['targetName', 'targetEmail', 'recorderName', 'cameraName', 'reason'])
    if (typeof input[key] === 'string')
      result[key] = input[key]
        .replace(/[\x00-\x1f]/g, ' ')
        .slice(0, key === 'targetEmail' ? 320 : 200);
  if (Array.isArray(input.changes))
    result.changes = input.changes
      .filter((v) => typeof v === 'string')
      .slice(0, 24)
      .map((v) => v.replace(/[\x00-\x1f]/g, ' ').slice(0, 300));
  return result;
}
export async function writeAudit(
  client,
  { tenantId, actorId, action, targetId = null, details = {} },
) {
  if (!Object.values(auditCategories).flat().includes(action))
    throw new Error('Unknown audit action.');
  await client.query(
    'INSERT INTO cam.audit(tenant_id,actor_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)',
    [tenantId, actorId, action, targetId, auditDetails(details)],
  );
}
export class AuditLog {
  constructor(db) {
    this.db = db;
  }
  async record(token, action, targetId, details) {
    return this.db.session(tokenHash(token), (client, user) =>
      writeAudit(client, { tenantId: user.tenantId, actorId: user.id, action, targetId, details }),
    );
  }
  async list(token, params) {
    return this.db.session(tokenHash(token), async (client, user) => {
      requireAccess(['superadmin', 'admin'].includes(user.role));
      const conditions = [],
        values = [],
        add = (sql, value) => {
          values.push(value);
          conditions.push(sql.replace('?', `$${values.length}`));
        };
      // Explicit tenant predicate complements RLS. Query parameters never choose it.
      if (user.role === 'admin') add('a.tenant_id=?', user.tenantId);
      const category = params.get('category') || '';
      if (category) {
        if (!Object.hasOwn(auditCategories, category))
          throw new HttpError('Choose a valid audit category.');
        add('a.action=ANY(?::text[])', auditCategories[category]);
      }
      const q = params.get('q') || '';
      if (q.length > 160) throw new HttpError('Use a shorter audit search.');
      if (q.trim())
        add(
          "concat_ws(' ',u.full_name,u.email,t.name,target.full_name,target.email,a.details->>'targetName',a.details->>'targetEmail',a.details->>'recorderName',a.details->>'cameraName') ILIKE ? ESCAPE '\\'",
          '%' + q.trim().replace(/[\\%_]/g, '\\$&') + '%',
        );
      for (const [key, op] of [
        ['from', '>='],
        ['to', '<'],
      ])
        if (params.has(key)) {
          const value = params.get(key),
            date = new Date(value);
          if (!/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(date.getTime()))
            throw new HttpError('Choose a valid audit date range.');
          add(`a.created_at${op}?::timestamptz`, date.toISOString());
        }
      if (
        params.has('from') &&
        params.has('to') &&
        new Date(params.get('from')) >= new Date(params.get('to'))
      )
        throw new HttpError('The end date must follow the start date.');
      const before = params.get('before');
      if (before) {
        if (!/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)
          throw new HttpError('Use a valid audit page.');
        add('a.id<?::bigint', before);
      }
      const result = await client.query(
        `SELECT a.id::text,a.tenant_id,a.actor_id,a.action,a.target_id,a.details,a.created_at,t.name AS workspace_name,
        u.full_name AS actor_name,u.email AS actor_email,target.full_name AS target_name,target.email AS target_email
        FROM cam.audit a LEFT JOIN cam.tenants t ON t.id=a.tenant_id LEFT JOIN cam.users u ON u.id=a.actor_id LEFT JOIN cam.users target ON target.id=a.target_id
        ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 51`,
        values,
      );
      const rows = result.rows
        .slice(0, 50)
        .map((row) => ({
          id: row.id,
          action: row.action,
          createdAt: row.created_at,
          workspace: row.workspace_name || 'Platform',
          actor: {
            name:
              row.actor_name ||
              (row.actor_id
                ? 'Platform administrator'
                : row.action === 'admin.requested'
                  ? 'Public signup'
                  : 'System'),
            email: row.actor_email || null,
          },
          target: {
            id: row.target_id,
            name: row.details?.targetName || row.target_name || null,
            email: row.details?.targetEmail || row.target_email || null,
          },
          details: auditDetails(row.details),
        }));
      return {
        events: rows,
        nextCursor: result.rows.length > 50 ? rows.at(-1).id : null,
        scope: user.role === 'superadmin' ? 'platform' : 'workspace',
      };
    });
  }
}
