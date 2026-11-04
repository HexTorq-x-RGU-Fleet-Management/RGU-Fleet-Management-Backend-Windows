#!/usr/bin/env node

/**
 * Manual end-to-end checker for lib/wheelseye-portal.mjs.
 *
 * Credentials are supplied only at runtime:
 *   PowerShell:
 *     $env:WHEELSEYE_TEST_USERNAME = '...'
 *     $env:WHEELSEYE_TEST_PASSWORD = '...'
 *     $env:WHEELSEYE_TEST_VEHICLE_ID = '4444455'   # optional
 *     node tools/test-wheelseye-portal.mjs
 *
 * This script prints summaries only. It never prints credentials, cookies,
 * provider tokens, complete provider payloads, addresses or vehicle lists.
 */
import WheelsEyePortal from '../lib/wheelseye-portal.mjs';

const username = process.env.WHEELSEYE_TEST_USERNAME;
const password = process.env.WHEELSEYE_TEST_PASSWORD;
const configuredVehicleId = process.env.WHEELSEYE_TEST_VEHICLE_ID;
const now = Math.floor(Date.now() / 1000);
const from = Number(process.env.WHEELSEYE_TEST_FROM || now - 86_400);
const to = Number(process.env.WHEELSEYE_TEST_TO || now);

if (!username || !password) {
  console.error('Missing WHEELSEYE_TEST_USERNAME or WHEELSEYE_TEST_PASSWORD.');
  console.error('Set them only in the current shell, then run this script again.');
  process.exit(2);
}

const client = new WheelsEyePortal(username, password);
const failures = [];

async function check(name, operation, summarize = summarizeValue) {
  try {
    const value = await operation();
    console.log(`[PASS] ${name}: ${summarize(value)}`);
    return value;
  } catch (error) {
    failures.push(name);
    console.error(
      `[FAIL] ${name}: ${error.code || error.name || 'request-failed'} (HTTP ${error.status || 'n/a'})`,
    );
    return null;
  }
}

const login = await check(
  'login()',
  () => client.login(),
  (value) => `authenticated=${Boolean(value?.authenticated)}`,
);
await check(
  'sessionStatus()',
  () => client.sessionStatus(),
  (value) => `authenticated=${Boolean(value?.authenticated)}`,
);

const directory = await check(
  'getVehiclesList()',
  () => client.getVehiclesList({ page: 0, size: 100 }),
  summarizeProviderPage,
);
const allDirectory = await check(
  'getAllVehiclesList()',
  () => client.getAllVehiclesList(),
  summarizeProviderPage,
);
const vehicleRecords = allDirectory?.data?.list || directory?.data?.list || [];
const vehicleIds = vehicleRecords
  .map((vehicle) => Number(vehicle.vehicleId))
  .filter(Number.isInteger);
const vehicleId = Number(configuredVehicleId || vehicleIds[0]);

if (!Number.isInteger(vehicleId)) {
  console.error(
    '[STOP] No provider vehicleId was returned; GPS, fuel and history calls were not attempted.',
  );
  process.exitCode = 1;
} else {
  const ids = vehicleIds.length ? vehicleIds : [vehicleId];
  await check('getGpsList(vehicleIds)', () => client.getGpsList(ids), summarizeDynamic);
  await check('getVehicleLive(vehicleId)', () => client.getVehicleLive(vehicleId), summarizeObject);
  await check('getFuelList()', () => client.getFuelList(), summarizeProviderPage);
  await check('getAllFuelList()', () => client.getAllFuelList(), summarizeFuelList);
  await check('getVehicleFuel(vehicleId)', () => client.getVehicleFuel(vehicleId), summarizeObject);
  await check(
    'getVehicleLatest(vehicleId)',
    () => client.getVehicleLatest(vehicleId),
    summarizeLatest,
  );
  await check('getAllVehiclesLatest()', () => client.getAllVehiclesLatest(), summarizeFleet);
  await check(
    'getFuelEvents(FUELING)',
    () => client.getFuelEvents(vehicleId, { type: 'FUELING', from, to }),
    summarizeEvents,
  );
  await check(
    'getFuelEvents(THEFT)',
    () => client.getFuelEvents(vehicleId, { type: 'THEFT', from, to }),
    summarizeEvents,
  );
  await check(
    'getFuelAnalytics()',
    () => client.getFuelAnalytics(vehicleId, { from, to }),
    summarizeObject,
  );
  await check(
    'getVehiclePath()',
    () => client.getVehiclePath(vehicleId, { from, to }),
    summarizeObject,
  );
}

client.clearSession();
const cleared = client.sessionStatus();
console.log(`[PASS] clearSession(): authenticated=${Boolean(cleared.authenticated)}`);

if (failures.length) {
  console.error(`\nCompleted with ${failures.length} failed call(s): ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nAll WheelsEye portal class calls completed successfully.');
}

function summarizeProviderPage(value) {
  const data = value?.data;
  const count = Array.isArray(data?.list)
    ? data.list.length
    : Array.isArray(data)
      ? data.length
      : 0;
  return `success=${Boolean(value?.success)} records=${count}`;
}

function summarizeFuelList(value) {
  return `success=${Boolean(value?.success)} records=${Array.isArray(value?.data) ? value.data.length : 0}`;
}

function summarizeDynamic(value) {
  return `success=${Boolean(value?.success)} vehicles=${value?.data && typeof value.data === 'object' ? Object.keys(value.data).length : 0}`;
}

function summarizeEvents(value) {
  const events = value?.data?.eventCardList;
  return `success=${Boolean(value?.success)} events=${Array.isArray(events) ? events.length : 0}`;
}

function summarizeLatest(value) {
  return `vehicleId=${value?.vehicleId} gps=${Boolean(value?.gps)} fuel=${Boolean(value?.fuel)}`;
}

function summarizeFleet(value) {
  return `vehicles=${Array.isArray(value?.vehicles) ? value.vehicles.length : 0} gps=${value?.vehicles?.filter((item) => item.gps).length || 0} fuel=${value?.vehicles?.filter((item) => item.fuel).length || 0}`;
}

function summarizeObject(value) {
  return value && typeof value === 'object'
    ? `responseKeys=${Object.keys(value).length}`
    : `response=${typeof value}`;
}

function summarizeValue(value) {
  return value && typeof value === 'object'
    ? `responseKeys=${Object.keys(value).length}`
    : `response=${typeof value}`;
}
