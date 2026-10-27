import { readFile } from 'node:fs/promises';
import { HttpError } from './database.mjs';

export const WHEELSEYE_URL = 'https://api.wheelseye.com/currentLoc';
const finite = (value, fallback = null) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;
export function normalizeWheelseyeEnvelope(input) {
  const data = input?.data?.list ? input.data : input;
  if (input?.success !== true || !Array.isArray(data?.list))
    throw new HttpError(
      'Invalid WheelsEye telemetry response.',
      502,
      'telemetry-provider-response',
    );
  const serverTime = finite(input.serverTime ?? data.serverTime);
  if (!Number.isInteger(serverTime) || serverTime < 0)
    throw new HttpError(
      'WheelsEye returned an invalid server time.',
      502,
      'telemetry-provider-response',
    );
  const vehicles = data.list.map((item) => {
    const rawTime = finite(item.dttimeInEpoch ?? item.createdDate);
    const gpsTime =
      rawTime != null && rawTime > 10_000_000_000 ? Math.floor(rawTime / 1000) : rawTime;
    if (!gpsTime || !item.vehicleNumber || !item.deviceNumber)
      throw new HttpError(
        'WheelsEye returned an incomplete vehicle record.',
        502,
        'telemetry-provider-response',
      );
    return {
      vehicleNumber: String(item.vehicleNumber),
      deviceId: String(item.deviceNumber),
      vendorCode: item.vendorCode ? String(item.vendorCode) : null,
      status: ['MOVING', 'STOPPED', 'IDLE', 'OFFLINE'].includes(item.status)
        ? item.status
        : item.ignition
          ? 'MOVING'
          : 'STOPPED',
      speed: Math.max(0, finite(item.speed, 0)),
      odometer: Math.max(0, finite(item.odometer, 0)),
      gpsTime: Math.floor(gpsTime),
      location: {
        latitude: finite(item.latitude, 0),
        longitude: finite(item.longitude, 0),
        address: typeof item.address === 'string' ? item.address : '',
      },
      ignition: Boolean(item.ignition),
      fuelData: null,
      chargeOn: item.chargeOn == null ? null : Boolean(item.chargeOn),
      provider: 'WHEELSEYE',
    };
  });
  return { message: 'Ok', success: true, serverTime, data: { pageNo: 0, totalPage: 1, vehicles } };
}
export async function fetchWheelseye({
  apiUrl = WHEELSEYE_URL,
  accessToken,
  fetchImpl = fetch,
} = {}) {
  if (!accessToken) throw new Error('WHEELSEYE_ACCESS_TOKEN_FILE is not configured.');
  const url = new URL(apiUrl);
  url.searchParams.set('accessToken', accessToken.trim());
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(15000),
    headers: { accept: 'application/json' },
  });
  if (!response.ok)
    throw new HttpError(
      `WheelsEye responded with HTTP ${response.status}.`,
      502,
      'telemetry-provider-response',
    );
  return normalizeWheelseyeEnvelope(await response.json());
}
export async function readWheelseyeToken(file = process.env.WHEELSEYE_ACCESS_TOKEN_FILE) {
  if (!file) throw new Error('WHEELSEYE_ACCESS_TOKEN_FILE is not configured.');
  return (await readFile(file, 'utf8')).trim();
}
