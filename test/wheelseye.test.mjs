import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWheelseyeEnvelope } from '../lib/wheelseye.mjs';
test('normalizes WheelsEye current location without inventing fuel data', () => {
  const value = normalizeWheelseyeEnvelope({
    success: true,
    serverTime: 1793096698,
    data: {
      list: [
        {
          vehicleNumber: 'TN99Z5641',
          deviceNumber: '867542081420195',
          vendorCode: 'WE9292385',
          latitude: 10.93,
          longitude: 76.97,
          speed: 0,
          dttimeInEpoch: 1793096691,
          ignition: false,
          chargeOn: true,
        },
      ],
    },
  });
  assert.equal(value.data.vehicles[0].deviceId, '867542081420195');
  assert.equal(value.data.vehicles[0].gpsTime, 1793096691);
  assert.equal(value.data.vehicles[0].fuelData, null);
  assert.equal(value.data.vehicles[0].chargeOn, true);
});
