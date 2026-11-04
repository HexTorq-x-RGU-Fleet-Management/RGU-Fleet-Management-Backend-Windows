#!/usr/bin/env node

/**
 * Per-vehicle WheelsEye verification runner.
 *
 * It deliberately fetches GPS, fuel, combined data, fuel history/analytics and
 * GPS path history as separate calls inside a vehicle loop. It prints summaries
 * only; credentials, tokens and complete provider payloads are never printed.
 */
import WheelsEyePortal from '../lib/wheelseye-portal.mjs';

const username = process.env.WHEELSEYE_TEST_USERNAME;
const password = process.env.WHEELSEYE_TEST_PASSWORD;
const now = Math.floor(Date.now() / 1000);
const from = Number(process.env.WHEELSEYE_TEST_FROM || now - 86_400);
const to = Number(process.env.WHEELSEYE_TEST_TO || now);

if (!username || !password) {
  console.error('Missing WHEELSEYE_TEST_USERNAME or WHEELSEYE_TEST_PASSWORD.');
  process.exit(2);
}

const client = new WheelsEyePortal(username, password);
const failures = [];

async function call(label, operation, summary) {
  try {
    const value = await operation();
    console.log(`[PASS] ${label}: ${summary(value)}`);
    return value;
  } catch (error) {
    failures.push(label);
    console.error(
      `[FAIL] ${label}: ${error.code || error.name || 'request-failed'} (HTTP ${error.status || 'n/a'})`,
    );
    return null;
  }
}

try {
  const directory = await call(
    'all vehicles list',
    () => client.getAllVehiclesList({ size: 100 }),
    (value) => `records=${value?.data?.list?.length || 0}`,
  );
  const records = directory?.data?.list || [];
  const vehicleIds = records.map((item) => Number(item.vehicleId)).filter(Number.isInteger);

  if (!vehicleIds.length) {
    failures.push('vehicle enumeration');
    console.error('[STOP] No vehicle IDs were returned; per-vehicle calls were not attempted.');
  } else {
    console.log(
      `\nTesting ${vehicleIds.length} vehicle(s), history ${new Date(from * 1000).toISOString()} to ${new Date(to * 1000).toISOString()}\n`,
    );

    for (const vehicleId of vehicleIds) {
      const vehicle = records.find((item) => Number(item.vehicleId) === vehicleId);
      const label = vehicle?.vehicleNumber
        ? `${vehicle.vehicleNumber} (${vehicleId})`
        : String(vehicleId);
      console.log(`--- ${label} ---`);
      await call(
        `${label} GPS`,
        () => client.getVehicleLive(vehicleId),
        (value) =>
          `lat=${value?.latitude ?? 'n/a'} lon=${value?.longitude ?? 'n/a'} speed=${value?.speed ?? 'n/a'}`,
      );
      await call(
        `${label} fuel`,
        () => client.getVehicleFuel(vehicleId),
        (value) => `present=${Boolean(value)}`,
      );
      await call(
        `${label} combined latest`,
        () => client.getVehicleLatest(vehicleId),
        (value) => `gps=${Boolean(value?.gps)} fuel=${Boolean(value?.fuel)}`,
      );
      await call(
        `${label} fuel filling history`,
        () => client.getFuelEvents(vehicleId, { type: 'FUELING', from, to }),
        (value) => `events=${value?.data?.eventCardList?.length || 0}`,
      );
      await call(
        `${label} fuel theft history`,
        () => client.getFuelEvents(vehicleId, { type: 'THEFT', from, to }),
        (value) => `events=${value?.data?.eventCardList?.length || 0}`,
      );
      await call(
        `${label} fuel analytics`,
        () => client.getFuelAnalytics(vehicleId, { from, to }),
        (value) => `responseKeys=${value?.data ? Object.keys(value.data).length : 0}`,
      );
      await call(
        `${label} GPS path history`,
        () => client.getVehiclePath(vehicleId, { from, to }),
        (value) =>
          `responseKeys=${value && typeof value === 'object' ? Object.keys(value).length : 0}`,
      );
    }

    await call(
      'all GPS list',
      () => client.getGpsList(vehicleIds),
      (value) => `vehicles=${Object.keys(value?.data || {}).length}`,
    );
    await call(
      'all fuel list',
      () => client.getAllFuelList(),
      (value) => `records=${value?.data?.length || 0}`,
    );
    await call(
      'all vehicles with GPS and fuel',
      () => client.getAllVehiclesLatest(),
      (value) => `vehicles=${value?.vehicles?.length || 0}`,
    );
  }
} finally {
  client.clearSession();
  console.log(`[PASS] session cleared: authenticated=${client.sessionStatus().authenticated}`);
}

if (failures.length) {
  console.error(`\nCompleted with ${failures.length} failure(s).`);
  process.exitCode = 1;
} else {
  console.log('\nAll per-vehicle and history calls completed successfully.');
}
