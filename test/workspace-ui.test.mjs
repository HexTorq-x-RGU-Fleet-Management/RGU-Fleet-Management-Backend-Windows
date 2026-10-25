import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresFixture } from './helpers.mjs';
import { WorkspaceUi, ChannelAvailability, cleanUi } from '../lib/workspace-ui.mjs';
import { Cameras } from '../lib/cameras.mjs';
import { tokenHash } from '../lib/auth.mjs';
test('workspace preferences are validated, persisted and isolated; actual channel observations never become invented online states', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t),
    password = 'workspace-ui-test-password-123';
  const root = await auth.bootstrap({ email: 'root@ui.test', fullName: 'Root', password });
  for (const name of ['alpha', 'beta'])
    await auth.signup({ email: name + '@ui.test', fullName: name, workspaceName: name, password });
  for (const w of (await workspaces.platform(root.token)).workspaces)
    await workspaces.decide(root.token, w.id, 'approve');
  const alpha = await auth.login({ email: 'alpha@ui.test', password }),
    beta = await auth.login({ email: 'beta@ui.test', password });
  const ui = new WorkspaceUi(db),
    health = new ChannelAvailability(db);
  await ui.preferences(alpha.token, {
    settings: { theme: 'light', token: 'not-saved' },
    favorites: ['only-alpha'],
    role: 'superadmin',
  });
  assert.equal((await ui.preferences(alpha.token)).settings.theme, 'light');
  assert.equal((await ui.preferences(beta.token)).settings.theme, 'dark');
  assert.deepEqual((await ui.preferences(beta.token)).favorites, []);
  assert.equal((await ui.preferences(alpha.token)).role, undefined);
  assert.equal((await ui.preferences(alpha.token)).settings.token, undefined);
  assert.equal((await ui.preferences(root.token)).settings.theme, 'dark');
  assert.throws(() => cleanUi({ settings: { quality: 'fake' } }));
  const cameras = new Cameras(db, cipher, {
    personal: async () => ({
      credentials: {
        sessionId: 'private-fixture-token',
        accountUserId: 'fixture-account',
        origin: 'https://iindia.hik-connect.com',
      },
    }),
    hik: {
      devices: async () => [
        {
          id: 'camera',
          name: 'Test',
          status: 'online',
          channels: [
            { number: 1, name: 'One' },
            { number: 2, name: 'Two' },
          ],
        },
      ],
      sharing: async () => ({ devices: [] }),
    },
  });
  await cameras.connect(alpha.token, { account: 'test', password });
  const inventory = (await cameras.devices(alpha.token)).devices;
  assert.equal((await cameras.devices(alpha.token)).playbackReady, false);
  assert.equal((await health.annotate(alpha.token, inventory))[0].channels[0].health, 'unknown');
  await health.observe({
    viewer: tokenHash(alpha.token),
    tenantId: alpha.principal.tenantId,
    deviceId: 'camera',
    channel: 1,
    ok: true,
  });
  let rows = await health.annotate(alpha.token, inventory);
  assert.equal(rows[0].channels[0].health, 'working');
  assert.equal(rows[0].channels[1].health, 'unknown');
  assert.equal((await health.annotate(beta.token, inventory))[0].channels[0].health, 'unknown');
  await health.observe({
    viewer: tokenHash(alpha.token),
    tenantId: alpha.principal.tenantId,
    deviceId: 'camera',
    channel: 1,
    ok: false,
    code: 'playback-auth-required',
  });
  assert.equal((await health.annotate(alpha.token, inventory))[0].channels[0].health, 'unknown');
  await cameras.connect(alpha.token, { account: 'test', password });
  rows = await health.annotate(alpha.token, inventory);
  assert.equal(rows[0].channels[0].health, 'unknown');
});
