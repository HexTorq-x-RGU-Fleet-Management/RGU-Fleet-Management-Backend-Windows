// Inputs here must be trusted session/database records, never request bodies.
// HTTP handlers and database scope enforcement are implemented separately.
export class AccessError extends Error {
  constructor() {
    super('You do not have access to this action.');
    this.status = 403;
    this.code = 'access-denied';
  }
}
const active = (user) =>
  Boolean(user && typeof user.id === 'string' && user.id && user.status === 'active');
const tenantActive = (user, tenantId) =>
  active(user) &&
  typeof tenantId === 'string' &&
  Boolean(tenantId) &&
  user.tenantId === tenantId &&
  user.tenantStatus === 'active';
export const canApproveAdmins = (user) =>
  active(user) && user.role === 'superadmin' && user.tenantId == null;
export const canManageTenant = (user, tenantId) =>
  tenantActive(user, tenantId) && user.role === 'admin';
export const canConnectProvider = canManageTenant;
export const canCreateMember = canManageTenant;

export function canAccessCamera(user, camera, permission = 'view', grants = []) {
  if (
    !['view', 'download', 'record'].includes(permission) ||
    !camera ||
    typeof camera.deviceId !== 'string' ||
    !camera.deviceId ||
    !Number.isInteger(camera.channel) ||
    camera.channel < 1 ||
    !tenantActive(user, camera.tenantId)
  )
    return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'member' || typeof camera.deviceId !== 'string') return false;
  return grants.some(
    (grant) =>
      grant &&
      grant.userId === user.id &&
      grant.tenantId === user.tenantId &&
      grant.deviceId === camera.deviceId &&
      grant.view === true &&
      grant[permission] === true &&
      (grant.channels === null ||
        (Array.isArray(grant.channels) &&
          Number.isInteger(camera.channel) &&
          grant.channels.includes(camera.channel))),
  );
}

export function requireAccess(allowed) {
  if (allowed !== true) throw new AccessError();
}

export function memberGrants(actor, tenantId, member, input, permittedDevices) {
  requireAccess(canCreateMember(actor, tenantId));
  if (
    !tenantActive(member, tenantId) ||
    member.role !== 'member' ||
    !Array.isArray(input) ||
    input.length > 512 ||
    !Array.isArray(permittedDevices)
  )
    throw new AccessError();
  const devices = new Set(
    permittedDevices
      .filter((device) => device.tenantId === tenantId)
      .map((device) => device.deviceId),
  );
  return input.map((value) => {
    if (!value || typeof value.deviceId !== 'string' || !devices.has(value.deviceId))
      throw new AccessError();
    let channels = null;
    if (value.channels !== undefined && value.channels !== null) {
      if (
        !Array.isArray(value.channels) ||
        value.channels.length > 1024 ||
        value.channels.some(
          (channel) => !Number.isInteger(channel) || channel < 1 || channel > 1024,
        )
      )
        throw new AccessError();
      channels = [...new Set(value.channels)];
    }
    const view = value.view === true;
    return {
      tenantId,
      userId: member.id,
      deviceId: value.deviceId,
      channels,
      view,
      download: view && value.download === true,
      record: view && value.record === true,
    };
  });
}
