import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Fleet, busInput, mockVehicle, validateEnvelope } from '../lib/fleet.mjs';
import { tokenHash } from '../lib/auth.mjs';
import { postgresFixture } from './helpers.mjs';
import { TenantStorage } from '../lib/storage.mjs';
import { createSaas } from '../server.mjs';

const data = {
  busNumber: 'RGU 01',
  registration: 'tn 37 test 01',
  driverName: 'Test Driver',
  driverPhone: '',
  routeName: 'Test route',
  recorderId: 'recorder-1',
  telemetryDeviceId: 'WE-001',
  favoriteChannels: [1, 2],
};
test('fleet inputs and vendor envelope reject malformed data and preserve Unix seconds', () => {
  assert.equal(busInput(data).registration, 'TN 37 TEST 01');
  assert.throws(() => busInput({ ...data, favoriteChannels: [0] }));
  assert.throws(() => busInput({ ...data, busNumber: '' }));
  const envelope = {
    message: 'Ok',
    success: true,
    serverTime: 1782384210,
    data: { pageNo: 0, totalPage: 1, vehicles: [mockVehicle('WE-001', 'TN01', 1782384210)] },
  };
  assert.equal(validateEnvelope(envelope).data.vehicles[0].gpsTime, 1782384210);
  assert.throws(() => validateEnvelope({ ...envelope, success: false }));
  assert.throws(() =>
    validateEnvelope({
      ...envelope,
      data: {
        ...envelope.data,
        vehicles: [{ ...envelope.data.vehicles[0], gpsTime: 1782384210000 }],
      },
    }),
  );
  assert.throws(() =>
    validateEnvelope({
      ...envelope,
      data: {
        ...envelope.data,
        vehicles: [
          { ...envelope.data.vehicles[0], fuelData: { currentLiters: 10, fuelPercentage: 101 } },
        ],
      },
    }),
  );
});
test('fleet HTTP CRUD, PostgreSQL RLS, mappings, mock history and member permissions', async (t) => {
  const { db, auth, workspaces, cipher } = await postgresFixture(t),
    password = 'fleet-test-password-123';
  const root = await auth.bootstrap({ email: 'root@example.test', fullName: 'Root', password });
  for (const name of ['alpha', 'beta'])
    await auth.signup({
      email: name + '@example.test',
      fullName: name,
      workspaceName: name,
      password,
    });
  for (const w of (await workspaces.platform(root.token)).workspaces)
    await workspaces.decide(root.token, w.id, 'approve');
  const alpha = await auth.login({ email: 'alpha@example.test', password }),
    beta = await auth.login({ email: 'beta@example.test', password });
  for (const actor of [alpha, beta])
    await db.session(tokenHash(actor.token), async (c, p) => {
      await c.query(
        "INSERT INTO cam.devices(tenant_id,device_id,data) VALUES($1,'recorder-1',$2)",
        [
          p.tenantId,
          JSON.stringify({ id: 'recorder-1', channels: [{ number: 1 }, { number: 2 }] }),
        ],
      );
    });
  const directory = await mkdtemp(path.join(tmpdir(), 'fleet-test-')),
    storage = await new TenantStorage(directory, db).open();
  const { server } = createSaas({ db, auth, workspaces, cipher, storage });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (route, token, input) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: 'hik_saas=' + token,
        'Content-Type': 'application/json',
        'X-Hik-Local': '1',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const created = await call('/api/fleet/buses', alpha.token, data);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const bus = created.body.bus;
  assert.equal((await call('/api/fleet/buses', beta.token)).body.buses.length, 0);
  assert.equal((await call('/api/fleet/buses', beta.token, { ...data, id: bus.id })).status, 404);
  assert.equal(
    (
      await call('/api/fleet/buses', alpha.token, {
        ...data,
        busNumber: 'RGU 02',
        registration: 'TEST02',
      })
    ).status,
    409,
  );
  assert.equal(
    (await call('/api/fleet/buses', alpha.token, { ...data, id: bus.id, favoriteChannels: [3] }))
      .status,
    400,
  );
  assert.equal((await call('/api/fleet/buses', beta.token, data)).status, 200); // same external IDs in a separate tenant
  const polled = await call('/api/fleet/mock/poll', alpha.token, {});
  assert.equal(polled.body.source, 'mock');
  validateEnvelope(polled.body);
  const latest = await call('/api/fleet/telemetry', alpha.token);
  assert.equal(latest.body.data.vehicles[0].deviceId, 'WE-001');
  assert.equal((await call('/api/fleet/telemetry', beta.token)).body.data.vehicles.length, 0);
  const now = polled.body.serverTime,
    route = '/api/fleet/history?busId=' + bus.id + '&from=' + (now - 7200) + '&to=' + now;
  assert.equal((await call(route, alpha.token)).body.samples.length, 121);
  await call('/api/fleet/mock/poll', alpha.token, {});
  assert.equal((await call(route, alpha.token)).body.samples.length, 121); // idempotent snapshot insertion
  assert.equal((await call(route, beta.token)).status, 404);
  assert.equal(
    (await call(route.replace('from=' + (now - 7200), 'from=0'), alpha.token)).status,
    400,
  );
  const member = await workspaces.createMember(alpha.token, {
    fullName: 'Member',
    email: 'member@example.test',
    password,
  });
  let login = await auth.login({ email: 'member@example.test', password });
  const renewed = await auth.changePassword(login.token, {
    currentPassword: password,
    newPassword: password + '-renewed',
  });
  login = { ...login, token: renewed.token };
  assert.equal((await call('/api/fleet/buses', login.token)).body.buses.length, 0);
  await db.session(tokenHash(alpha.token), async (c, p) => {
    await c.query(
      "INSERT INTO cam.grants(tenant_id,user_id,device_id,can_view,channels) VALUES($1,$2,'recorder-1',true,ARRAY[1])",
      [p.tenantId, login.principal.id],
    );
  });
  assert.equal((await call('/api/fleet/buses', login.token)).body.buses.length, 1);
  assert.deepEqual(
    (await call('/api/fleet/buses', login.token)).body.buses[0].favoriteChannels,
    [1],
  );
  assert.deepEqual((await call(route, login.token)).body.bus.favoriteChannels, [1]);
  assert.equal((await call('/api/fleet/buses', login.token, { ...data, id: bus.id })).status, 403);
  assert.equal((await call('/api/fleet/mock/poll', login.token, {})).status, 403);
  assert.equal((await call('/api/fleet/buses/remove', login.token, { id: bus.id })).status, 403);
  const changed = await call('/api/fleet/buses', alpha.token, {
    ...data,
    id: bus.id,
    telemetryDeviceId: 'WE-NEW',
  });
  assert.equal(changed.status, 200);
  assert.equal((await call(route, alpha.token)).body.samples.length, 0);
  assert.equal((await call('/api/fleet/buses/remove', alpha.token, { id: bus.id })).status, 200);
  assert.equal((await call(route, alpha.token)).status, 404);
  assert.equal((await call('/api/fleet/buses', beta.token)).body.buses.length, 1);
  void member;
});
