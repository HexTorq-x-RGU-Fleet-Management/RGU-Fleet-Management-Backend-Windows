import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { postgresFixture } from './helpers.mjs';
import { TenantStorage } from '../lib/storage.mjs';
import { createSaas } from '../server.mjs';

test('separate frontend transport preserves origin, CSRF, session and API-only boundaries', async (t) => {
  const { db, cipher } = await postgresFixture(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'rgu-http-test-'));
  const storage = await new TenantStorage(directory, db).open();
  const frontend = 'http://127.0.0.1:3107';
  const { server } = createSaas({
    db,
    cipher,
    storage,
    frontendOrigins: [frontend],
    rateLimit: 100,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const get = (route, headers = {}) =>
    fetch(base + route, { headers: { Origin: frontend, ...headers } });
  const payload = {
    fullName: 'Test Owner',
    email: 'transport@example.test',
    password: 'synthetic-owner-password-42',
  };

  const preflight = await fetch(base + '/api/auth/login', {
    method: 'OPTIONS',
    headers: {
      Origin: frontend,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'Content-Type, X-Hik-Local',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), frontend);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-hik-local/);

  const root = await get('/');
  assert.equal((await root.json()).frontend, 'separate');
  for (const file of [
    '/index.html',
    '/saas-auth.mjs',
    '/server.mjs',
    '/.env',
    '/db/schema.sql',
    '/vendor/windows-sdk/native/probe.py',
  ]) {
    assert.equal((await get(file)).status, 404, file);
  }
  assert.equal((await get('/api/team')).status, 401);
  const noHeader = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { Origin: frontend, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(noHeader.status, 403);
  const hostile = await get('/api/auth/status', { Origin: 'https://attacker.invalid' });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers.get('access-control-allow-origin'), null);
  const setup = await fetch(base + '/api/auth/setup', {
    method: 'POST',
    headers: { Origin: frontend, 'Content-Type': 'application/json', 'X-Hik-Local': '1' },
    body: JSON.stringify(payload),
  });
  assert.equal(setup.status, 200);
  assert.match(setup.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const status = await get('/api/auth/status', { Cookie: cookie });
  assert.equal((await status.json()).user.role, 'superadmin');
  assert.equal(status.headers.get('access-control-allow-origin'), frontend);
  const logout = await fetch(base + '/api/auth/logout', {
    method: 'POST',
    headers: {
      Origin: frontend,
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Hik-Local': '1',
    },
    body: '{}',
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await get('/api/platform/workspaces', { Cookie: cookie })).status, 401);
});
