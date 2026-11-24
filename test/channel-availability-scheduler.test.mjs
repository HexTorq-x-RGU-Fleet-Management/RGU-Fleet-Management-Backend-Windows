import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_CHECK_INTERVAL_MS, ChannelAvailabilityScheduler } from '../lib/workspace-ui.mjs';

test('camera availability is checked at most every five minutes with bounded concurrency', async () => {
  let now = 1_000_000,
    active = 0,
    maximum = 0;
  const observations = [];
  const scheduler = new ChannelAvailabilityScheduler(
    { observe: async (event) => observations.push(event) },
    { now: () => now, concurrency: 2 },
  );
  const input = {
    token: 'a'.repeat(64),
    principal: { tenantId: 'tenant' },
    devices: [
      { id: 'online', status: 'online', channels: [{ number: 1 }, { number: 2 }] },
      { id: 'offline', status: 'offline', channels: [{ number: 1 }] },
    ],
    preview: async (deviceId, channel) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (channel === 2)
        throw Object.assign(new Error('unavailable'), { code: 'channel-unavailable' });
      return { capturedAt: now, deviceId };
    },
  };
  await scheduler.schedule(input);
  assert.equal(observations.length, 2);
  assert.equal(maximum, 2);
  assert.equal(observations.filter((event) => event.ok).length, 1);
  assert.equal(observations.filter((event) => !event.ok).length, 1);
  assert.equal(scheduler.schedule(input), null);
  now += CHANNEL_CHECK_INTERVAL_MS;
  await scheduler.schedule(input);
  assert.equal(observations.length, 4);
});
