// Only the read-only routes actually observed on the authenticated portal.
export const origin = 'https://www.hik-connect.com';
import { isPortalOrigin } from './portal-origin.mjs';
export class HikError extends Error {
  constructor(message, status = 502, code = 'provider-response-error') { super(message); this.status = status; this.code = code; }
}
export function unwrap(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HikError('Hik-Connect returned an unexpected response.', 502, 'provider-response-error');
  if (result.meta && Number(result.meta.code) !== 200) { const code = Number(result.meta.code); if (code === 401) throw new HikError('Hik-Connect sign-in expired. Sign in again.', 401, 'provider-auth-required'); if (code === 403) throw new HikError('Hik-Connect denied this request. Check camera sharing permissions.', 403, 'provider-access-denied'); throw new HikError('Hik-Connect could not complete the request. Try again later.', 502, 'provider-response-error'); }
  const body = result.meta ? result.data : result;
  if (!body || body.success === false || (body.resultCode !== undefined && String(body.resultCode) !== '0'))
    throw new HikError('Hik-Connect returned an unsuccessful response. Your saved account has been kept.', 502, 'provider-response-error');
  return body;
}
export function normalizeDevices(records, source) {
  return records.map((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new HikError('Device response contains an unrecognized record. Capture the connected DVR list to update the mapping.');
    // Non-empty records have not yet been captured for this account. Mapping
    // is conservative; no channel number or stream URL is fabricated.
    const serial = record.deviceSerial || record.serialNo || record.serialNumber;
    return { id: typeof serial === 'string' ? serial : `${source}-${index}`,
      name: record.deviceName || record.deviceAlias || record.alias || 'Hikvision device',
      serial: typeof serial === 'string' ? serial : null,
      source, mappingPending: !serial, channelsReady: false, playbackReady: false };
  });
}
export function createHikClient({ request = fetch } = {}) {
  async function get(session, path, form) {
    const accountOrigin = session.origin || origin;
    if (!isPortalOrigin(accountOrigin)) throw new HikError('Unsupported Hik-Connect regional server. Reconnect the official browser tab.');
    let response;
    try {
      response = await request(accountOrigin + path, { signal: AbortSignal.timeout(15000), redirect: 'error',
        ...(form ? { method: 'POST', body: new URLSearchParams(form).toString() } : {}),
        headers: { Accept: 'application/json', sessionId: session.sessionId, clientType: '48', clientSource: '0',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
          Cookie: 'HC_sessionId=' + encodeURIComponent(session.sessionId), Referer: accountOrigin + '/views/main/index.html' } });
    } catch (error) { throw new HikError('The viewer server could not reach Hik-Connect. Try again later.', 502, ['TimeoutError', 'AbortError'].includes(error.name) ? 'provider-timeout' : 'provider-unavailable'); }
    if (response.status === 401) throw new HikError('Your Hik-Connect sign-in expired. Sign in again.', 401, 'provider-auth-required');
    if (response.status === 403) throw new HikError('Hik-Connect denied this request. Check camera sharing permissions.', 403, 'provider-access-denied');
    if (!response.ok) throw new HikError('Hik-Connect returned a service error. Try again later.', 502, 'provider-unavailable');
    let result; try { result = await response.json(); } catch { throw new HikError('Hik-Connect returned an unexpected response.', 502, 'provider-response-error'); }
    return unwrap(result);
  }
  return {
    async devices(session) {
      const devices = []; const seen = new Set(); const limit = 10;
      for (let offset = 0; offset < 1000; offset += limit) {
        const body = await get(session, `/v3/hcweb/devices/list?limit=${limit}&offset=${offset}`);
        if (!Array.isArray(body.data)) throw new HikError('Device response needs a schema update. The portal did not return the observed list format.');
        if (!body.data.length) return devices;
        const normalized = normalizeDevices(body.data, 'owned');
        let added = 0;
        for (const [index, device] of normalized.entries()) {
          const fingerprint = device.serial || JSON.stringify(body.data[index]);
          if (!seen.has(fingerprint)) { seen.add(fingerprint); devices.push(device); added++; }
        }
        if (body.data.length < limit) return devices;
        if (!added) throw new HikError('Hik-Connect repeated a device page. Discovery stopped to avoid returning an incomplete list.');
      }
      throw new HikError('Device discovery reached its page limit. Narrow the account or extend pagination support.');
    },
    async sharing(session) {
      const body = await get(session, '/v3/hcweb/share/domains');
      if (body.data === null || (Array.isArray(body.data) && !body.data.length)) return { state: 'empty', mappingPending: false };
      if (Array.isArray(body.data)) {
        const recognized = body.data.filter(record => record && typeof record.subSerial === 'string' && typeof record.devDomain === 'string');
        const devices = await Promise.all(recognized.map(async record => {
          const device = { id: `shared-${record.shareId || record.subSerial}`, name: record.devDomain,
          serial: record.subSerial, source: 'shared', status: record.status === 1 ? 'online' : record.status === 2 ? 'offline' : 'unknown',
          mappingPending: false, channelsReady: false, playbackReady: false };
          if (!record.shareId) return device;
          try {
            // This POST is the portal's observed read-only "Sharing details" request.
            const detail = await get(session, '/v3/hcweb/share/accept/device', { deviceId: String(record.shareId) });
            const shared = detail.shareDevice;
            if (shared?.subSerial !== record.subSerial || !Array.isArray(shared.shareCameras)) return device;
            const valid = shared.shareCameras.filter(camera => Number.isInteger(camera.channelNo) && camera.channelNo > 0 && typeof camera.cameraName === 'string');
            device.name = typeof shared.devName === 'string' ? shared.devName : device.name;
            device.channels = valid.map(camera => ({ number: camera.channelNo, name: camera.cameraName, playbackReady: false }));
            device.channelsReady = valid.length === shared.shareCameras.length;
          } catch (error) {
            if (error.status === 401) throw error;
            device.channelError = 'Channel details are temporarily unavailable. Refresh to retry.';
          }
          return device;
        }));
        return { state: 'records-found', mappingPending: recognized.length !== body.data.length, devices };
      }
      return { state: 'records-found', mappingPending: true };
    }
  };
}
