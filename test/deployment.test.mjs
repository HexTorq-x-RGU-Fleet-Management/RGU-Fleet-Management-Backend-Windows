import test from 'node:test';
import assert from 'node:assert/strict';
import { httpPolicy, frontendOriginsFromEnv } from '../lib/http-policy.mjs';
function response() {
  return {
    headers: {},
    setHeader(k, v) {
      this.headers[k] = v;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end() {
      this.ended = true;
    },
  };
}
test('only exact frontend origins are accepted, with HTTPS outside loopback', () => {
  for (const value of [
    '*',
    'null',
    'https://example.test/path',
    'https://example.test/',
    'http://example.test',
    'https://user:secret@example.test',
  ])
    assert.throws(() => frontendOriginsFromEnv(value));
  assert.deepEqual(frontendOriginsFromEnv(' http://127.0.0.1:3107,https://fleet.example.test '), [
    'http://127.0.0.1:3107',
    'https://fleet.example.test',
  ]);
});
test('credentialed CORS is explicit and never echoes hostile origins', () => {
  const policy = httpPolicy({ frontendOrigins: ['http://127.0.0.1:3107'] });
  const res = response();
  policy.apply(
    { headers: { origin: 'http://127.0.0.1:3107', 'sec-fetch-site': 'same-site' } },
    res,
    'http://127.0.0.1:8101',
  );
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:3107');
  assert.equal(res.headers['Access-Control-Allow-Credentials'], 'true');
  assert.equal(res.headers.Vary, 'Origin');
  for (const origin of ['https://hostile.test', 'null', 'http://127.0.0.1:3107.hostile.test'])
    assert.throws(
      () => policy.apply({ headers: { origin } }, response(), 'http://127.0.0.1:8101'),
      { status: 403 },
    );
  assert.throws(
    () =>
      policy.apply(
        { headers: { 'sec-fetch-site': 'cross-site' } },
        response(),
        'http://127.0.0.1:8101',
      ),
    { status: 403 },
  );
});
test('preflight permits only API methods and the defined request headers', () => {
  const policy = httpPolicy({ frontendOrigins: ['http://127.0.0.1:3107'] });
  const req = {
    headers: {
      origin: 'http://127.0.0.1:3107',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-hik-local',
    },
  };
  const res = response();
  policy.preflight(req, res);
  assert.equal(res.status, 204);
  assert.ok(res.ended);
  assert.throws(
    () =>
      policy.preflight(
        { headers: { ...req.headers, 'access-control-request-method': 'DELETE' } },
        response(),
      ),
    { status: 405 },
  );
  assert.throws(
    () =>
      policy.preflight(
        {
          headers: {
            ...req.headers,
            'access-control-request-headers': 'authorization,x-untrusted',
          },
        },
        response(),
      ),
    { status: 403 },
  );
});
test('cross-site cookies cannot downgrade Secure or HttpOnly requirements', () => {
  assert.throws(() => httpPolicy({ cookieSameSite: 'None' }));
  assert.throws(() => httpPolicy({ cookieSameSite: 'invalid' }));
  const policy = httpPolicy({ publicOrigin: 'https://api.example.test', cookieSameSite: 'None' });
  assert.match(policy.cookie('a'.repeat(64)), /HttpOnly; SameSite=None/);
  assert.match(policy.cookie(''), /Max-Age=0/);
  assert.match(policy.cookie('a'.repeat(64)), /; Secure$/);
});
