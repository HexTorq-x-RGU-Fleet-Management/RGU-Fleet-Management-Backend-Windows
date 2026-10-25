import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canApproveAdmins,
  canManageTenant,
  canConnectProvider,
  canCreateMember,
  canAccessCamera,
  memberGrants,
  requireAccess,
} from '../lib/access.mjs';

const admin = {
  id: 'admin-a',
  role: 'admin',
  status: 'active',
  tenantStatus: 'active',
  tenantId: 'tenant-a',
};
const member = { ...admin, id: 'member-a', role: 'member' };
const root = { id: 'root', role: 'superadmin', status: 'active', tenantId: null };
const camera = { tenantId: 'tenant-a', deviceId: 'recorder-1', channel: 1 };
const grant = {
  tenantId: 'tenant-a',
  userId: 'member-a',
  deviceId: 'recorder-1',
  channels: null,
  view: true,
  download: false,
  record: false,
};

test('only an active platform superadmin can approve admin requests', () => {
  assert.equal(canApproveAdmins(root), true);
  for (const user of [
    admin,
    member,
    null,
    { ...root, status: 'pending' },
    { ...root, tenantId: 'tenant-a' },
  ])
    assert.equal(canApproveAdmins(user), false);
});
test('admins manage provider connections and members in their own workspace only', () => {
  for (const action of [canManageTenant, canConnectProvider, canCreateMember]) {
    assert.equal(action(admin, 'tenant-a'), true);
    assert.equal(action(admin, 'tenant-b'), false);
    assert.equal(action(member, 'tenant-a'), false);
    assert.equal(action(root, 'tenant-a'), false);
  }
});
test('pending and suspended users or workspaces cannot access cameras', () => {
  for (const status of ['pending', 'suspended', 'rejected', undefined])
    assert.equal(canAccessCamera({ ...admin, status }, camera), false);
  for (const tenantStatus of ['pending', 'suspended', 'rejected', undefined])
    assert.equal(canAccessCamera({ ...admin, tenantStatus }, camera), false);
});
test('workspace admins have camera permissions locally but never across workspaces', () => {
  for (const permission of ['view', 'download', 'record']) {
    assert.equal(canAccessCamera(admin, camera, permission), true);
    assert.equal(canAccessCamera(admin, { ...camera, tenantId: 'tenant-b' }, permission), false);
    assert.equal(canAccessCamera(root, camera, permission), false);
  }
});
test('members need matching user, workspace, recorder and requested capability', () => {
  assert.equal(canAccessCamera(member, camera, 'view', [grant]), true);
  assert.equal(canAccessCamera(member, camera, 'download', [grant]), false);
  assert.equal(canAccessCamera(member, camera, 'record', [grant]), false);
  for (const wrong of [
    { ...grant, tenantId: 'tenant-b' },
    { ...grant, userId: 'another-user' },
    { ...grant, deviceId: 'another-recorder' },
  ])
    assert.equal(canAccessCamera(member, camera, 'view', [wrong]), false);
  assert.equal(
    canAccessCamera(member, camera, 'download', [{ ...grant, view: false, download: true }]),
    false,
  );
});
test('channel restrictions are enforced and unknown roles/capabilities fail closed', () => {
  assert.equal(canAccessCamera(member, camera, 'view', [{ ...grant, channels: [1] }]), true);
  assert.equal(
    canAccessCamera(member, { ...camera, channel: 2 }, 'view', [{ ...grant, channels: [1] }]),
    false,
  );
  assert.equal(canAccessCamera({ ...member, role: 'unexpected' }, camera, 'view', [grant]), false);
  assert.equal(canAccessCamera(admin, camera, 'manage-tenant'), false);
  assert.throws(() => requireAccess('true'));
});
test('member grant edits derive scope from the admin instead of trusting client tenant or role fields', () => {
  const result = memberGrants(
    admin,
    'tenant-a',
    member,
    [{ ...grant, tenantId: 'tenant-b', userId: 'another-user', role: 'admin', channels: [1, 1] }],
    [camera],
  );
  assert.equal(result[0].tenantId, 'tenant-a');
  assert.equal(result[0].userId, 'member-a');
  assert.equal(result[0].role, undefined);
  assert.deepEqual(result[0].channels, [1]);
  assert.throws(() =>
    memberGrants(admin, 'tenant-a', { ...member, tenantId: 'tenant-b' }, [grant], [camera]),
  );
  assert.throws(() => memberGrants(admin, 'tenant-b', member, [grant], [camera]));
  assert.throws(() => memberGrants(member, 'tenant-a', member, [grant], [camera]));
  assert.throws(() =>
    memberGrants(admin, 'tenant-a', member, [{ ...grant, deviceId: 'another-recorder' }], [camera]),
  );
});
