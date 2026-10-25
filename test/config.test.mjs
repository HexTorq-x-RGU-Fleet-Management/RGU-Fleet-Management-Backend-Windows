import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeConfig } from '../lib/config.mjs';
test('explicit local/external database configuration stays out of source defaults', async () => {
  const previous = {
    url: process.env.DATABASE_URL,
    port: process.env.PORT,
    data: process.env.HIK_SAAS_DATA_DIR,
  };
  try {
    process.env.DATABASE_URL = 'postgresql://test_app@example.test/test_db';
    process.env.PORT = '8109';
    process.env.HIK_SAAS_DATA_DIR = 'C:/private/test';
    const value = await runtimeConfig();
    assert.equal(value.databaseUrl, process.env.DATABASE_URL);
    assert.equal(value.port, 8109);
    assert.equal(value.dataDirectory, 'C:/private/test');
  } finally {
    for (const [key, value] of [
      ['DATABASE_URL', previous.url],
      ['PORT', previous.port],
      ['HIK_SAAS_DATA_DIR', previous.data],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
