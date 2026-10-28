import { randomUUID } from 'node:crypto';
import { tokenHash } from './auth.mjs';
import { HttpError } from './database.mjs';
import { writeAudit } from './audit.mjs';
import { fetchWheelseye, readWheelseyeToken } from './wheelseye.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const distanceMeters = (aLat, aLon, bLat, bLon) => {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const text = (v, max, name, required = true) => {
  if (typeof v !== 'string' || v.trim().length > max || (required && !v.trim()))
    throw new HttpError('Enter a valid ' + name + '.');
  return v.trim();
};
export function busInput(input) {
  const nullable = (v, name) =>
    v === null || v === '' || v === undefined ? null : text(v, 256, name);
  const channels = input.favoriteChannels ?? [];
  if (
    !Array.isArray(channels) ||
    channels.length > 1024 ||
    channels.some((n) => !Number.isInteger(n) || n < 1 || n > 1024)
  )
    throw new HttpError('Choose valid camera channels.');
  return {
    busNumber: text(input.busNumber, 40, 'bus number'),
    registration: text(input.registration, 40, 'registration').toUpperCase(),
    driverName: text(input.driverName, 100, 'driver name'),
    driverPhone: text(input.driverPhone ?? '', 30, 'driver phone', false),
    routeName: text(input.routeName ?? '', 100, 'route', false),
    recorderId: nullable(input.recorderId, 'recorder'),
    telemetryDeviceId: nullable(input.telemetryDeviceId, 'telemetry device'),
    favoriteChannels: [...new Set(channels)].sort((a, b) => a - b),
  };
}
export function mockVehicle(deviceId, vehicleNumber, gpsTime) {
  const seed = [...deviceId].reduce((n, c) => n + c.charCodeAt(0), 0);
  const step = Math.floor(gpsTime / 60),
    phase = ((step % 120) + 120) % 120,
    angle = (phase / 120) * Math.PI * 2;
  const waypoints = [
    { minute: 0, latitude: 10.9925, longitude: 76.9614, address: 'Ukkadam Bus Stand, Coimbatore' },
    { minute: 35, latitude: 10.8177, longitude: 76.8647, address: 'Walayar Checkpost' },
    { minute: 70, latitude: 10.9788, longitude: 76.7355, address: 'Isha Yoga Center, Coimbatore' },
    {
      minute: 120,
      latitude: 10.9925,
      longitude: 76.9614,
      address: 'Ukkadam Bus Stand, Coimbatore',
    },
  ];
  const segment = waypoints.findIndex(
    (point, index) => phase >= point.minute && phase < waypoints[index + 1].minute,
  );
  const from = waypoints[Math.max(0, segment)],
    to = waypoints[Math.max(1, segment + 1)];
  const fraction = (phase - from.minute) / (to.minute - from.minute);
  const latitude = from.latitude + (to.latitude - from.latitude) * fraction;
  const longitude = from.longitude + (to.longitude - from.longitude) * fraction;
  const moving = phase % 30 < 24;
  return {
    vehicleNumber,
    deviceId,
    status: moving ? 'MOVING' : 'STOPPED',
    speed: moving ? Number((28 + 12 * Math.sin(angle)).toFixed(1)) : 0,
    odometer: Number((45210 + (step % 1440) * 0.15 + seed).toFixed(1)),
    gpsTime,
    location: {
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
      address: from.address + ' · simulated route',
    },
    ignition: moving,
    fuelData: {
      currentLiters: Number((140 - phase * 0.12).toFixed(1)),
      fuelPercentage: Number((((140 - phase * 0.12) / 200) * 100).toFixed(1)),
    },
  };
}
export function validateEnvelope(value) {
  if (
    value?.success !== true ||
    !Number.isInteger(value.serverTime) ||
    !Array.isArray(value.data?.vehicles) ||
    !Number.isInteger(value.data.pageNo) ||
    !Number.isInteger(value.data.totalPage) ||
    value.data.pageNo < 0 ||
    value.data.totalPage < 1 ||
    value.data.pageNo >= value.data.totalPage ||
    value.data.vehicles.length > 1000
  )
    throw new HttpError('Invalid telemetry envelope.');
  for (const v of value.data.vehicles) {
    if (
      !v ||
      typeof v.deviceId !== 'string' ||
      !v.deviceId ||
      v.deviceId.length > 256 ||
      typeof v.vehicleNumber !== 'string' ||
      !['MOVING', 'STOPPED', 'IDLE', 'OFFLINE'].includes(v.status) ||
      !Number.isInteger(v.gpsTime) ||
      v.gpsTime < 0 ||
      v.gpsTime > value.serverTime + 300 ||
      typeof v.ignition !== 'boolean' ||
      typeof v.location?.address !== 'string' ||
      ![
        v.speed,
        v.odometer,
        v.location?.latitude,
        v.location?.longitude,
        v.fuelData?.currentLiters,
        v.fuelData?.fuelPercentage,
      ].every(Number.isFinite) ||
      v.speed < 0 ||
      v.odometer < 0 ||
      Math.abs(v.location.latitude) > 90 ||
      Math.abs(v.location.longitude) > 180 ||
      v.fuelData.currentLiters < 0 ||
      v.fuelData.fuelPercentage < 0 ||
      v.fuelData.fuelPercentage > 100
    )
      throw new HttpError('Invalid telemetry vehicle.');
  }
  return value;
}
const shape = (row) => ({
  id: row.id,
  busNumber: row.bus_number,
  registration: row.registration,
  driverName: row.driver_name,
  driverPhone: row.driver_phone,
  routeName: row.route_name,
  recorderId: row.recorder_id,
  telemetryDeviceId: row.telemetry_device_id,
  favoriteChannels: row.favorite_channels,
});
export class Fleet {
  constructor(db, cipher = null) {
    this.db = db;
    this.cipher = cipher;
  }
  parseWheelseyeSource(input) {
    let url;
    try {
      url = new URL(input.url);
    } catch {
      throw new HttpError('Enter a valid WheelsEye URL.');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'api.wheelseye.com' ||
      url.pathname !== '/currentLoc'
    )
      throw new HttpError('Use the official WheelsEye currentLoc URL.');
    const accessToken = url.searchParams.get('accessToken');
    if (!accessToken || accessToken.length > 2048)
      throw new HttpError('The WheelsEye URL must contain an accessToken.');
    return {
      endpointUrl: `${url.origin}${url.pathname}`,
      accessToken,
      label:
        String(input.label || '')
          .trim()
          .slice(0, 100) || 'WheelsEye account',
    };
  }
  async wheelseyeSources(token) {
    return this.db.session(tokenHash(token), async (client, p) => {
      if (p.role !== 'admin')
        throw new HttpError('Only workspace admins can manage telemetry sources.', 403);
      const rows = (
        await client.query(
          'SELECT id,label,device_cache,enabled,poll_interval_seconds,last_polled_at,last_success_at,last_error FROM cam.wheelseye_sources WHERE tenant_id=$1 ORDER BY created_at',
          [p.tenantId],
        )
      ).rows;
      return {
        sources: rows.map((r) => ({
          id: r.id,
          label: r.label,
          devices: r.device_cache || [],
          enabled: r.enabled,
          pollIntervalSeconds: r.poll_interval_seconds,
          lastPolledAt: r.last_polled_at,
          lastSuccessAt: r.last_success_at,
          lastError: r.last_error,
        })),
      };
    });
  }
  async wheelseyeDevice(token, sourceId, deviceId, { fetchImpl = fetch } = {}) {
    if (!uuid.test(sourceId) || typeof deviceId !== 'string' || !deviceId.trim())
      throw new HttpError('Choose a valid WheelsEye device.', 400);
    const config = await this.db.session(tokenHash(token), async (client, p) => {
      if (p.role !== 'admin') throw new HttpError('Only workspace admins can inspect devices.', 403);
      const row = (await client.query(
        'SELECT id,payload FROM cam.wheelseye_sources WHERE id=$1 AND tenant_id=$2 AND enabled',
        [sourceId, p.tenantId],
      )).rows[0];
      if (!row) throw new HttpError('WheelsEye source is not available.', 404);
      const logs = (await client.query(
        `SELECT payload,received_at FROM cam.wheelseye_location_logs
         WHERE tenant_id=$1 AND source_id=$2 AND device_number=$3
         ORDER BY gps_time DESC LIMIT 120`,
        [p.tenantId, sourceId, deviceId.trim()],
      )).rows;
      return { payload: row.payload, tenantId: p.tenantId, logs };
    });
    const opened = this.cipher.open(config.payload, config.tenantId);
    const envelope = await fetchWheelseye({ accessToken: opened.accessToken, fetchImpl });
    const vehicle = envelope.data.vehicles.find((item) => String(item.deviceId) === deviceId.trim());
    if (!vehicle) throw new HttpError('The device was not returned by WheelsEye.', 502, 'telemetry-device-missing');
    return { vehicle, samples: config.logs.map((row) => ({ vehicle: row.payload, receivedAt: row.received_at })), fetchedAt: Date.now() };
  }
  async addWheelseyeSource(token, input) {
    if (!this.cipher) throw new Error('Provider encryption is not available.');
    const source = this.parseWheelseyeSource(input);
    const principal = await this.db.session(tokenHash(token), async (_c, p) => p);
    if (principal.role !== 'admin')
      throw new HttpError('Only workspace admins can manage telemetry sources.', 403);
    const payload = this.cipher.seal({ accessToken: source.accessToken }, principal.tenantId);
    return this.db.session(tokenHash(token), async (client, p) => {
      const id = randomUUID();
      const row = (
        await client.query(
          `INSERT INTO cam.wheelseye_sources(id,tenant_id,label,endpoint_url,payload,device_cache) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,label,device_cache,enabled,poll_interval_seconds,last_polled_at,last_success_at,last_error`,
          [id, p.tenantId, source.label, source.endpointUrl, payload, JSON.stringify([])],
        )
      ).rows[0];
      return {
        source: {
          id: row.id,
          label: row.label,
          devices: [],
          enabled: row.enabled,
          pollIntervalSeconds: row.poll_interval_seconds,
          lastPolledAt: row.last_polled_at,
          lastSuccessAt: row.last_success_at,
          lastError: row.last_error,
        },
        fetched: 0,
        discoveryPending: true,
      };
    });
  }
  async removeWheelseyeSource(token, id) {
    return this.db.session(tokenHash(token), async (client, p) => {
      if (p.role !== 'admin')
        throw new HttpError('Only workspace admins can manage telemetry sources.', 403);
      const result = await client.query(
        'DELETE FROM cam.wheelseye_sources WHERE id=$1 AND tenant_id=$2',
        [id, p.tenantId],
      );
      if (!result.rowCount) throw new HttpError('Telemetry source not found.', 404);
      return { removed: true };
    });
  }
  async refreshWheelseyeSources(token) {
    const principal = await this.db.session(tokenHash(token), async (_client, p) => p);
    if (principal.role !== 'admin') throw new HttpError('Only workspace admins can refresh WheelsEye.', 403);
    await this.pollWheelseyeSources();
    return this.wheelseyeSources(token);
  }
  async storeWheelseye(envelope, { tenantId, adminUserId }) {
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT set_config('cam.tenant_id',$1,true), set_config('cam.user_id',$2,true), set_config('cam.role','admin',true)",
        [tenantId, adminUserId],
      );
      const admin = (
        await client.query(
          "SELECT id FROM cam.users WHERE id=$1 AND tenant_id=$2 AND role='admin' AND status='active'",
          [adminUserId, tenantId],
        )
      ).rows[0];
      if (!admin) throw new Error('WHEELSEYE_ADMIN_USER_ID is not an active workspace admin.');
      const buses = (
        await client.query('SELECT * FROM cam.buses WHERE telemetry_device_id IS NOT NULL')
      ).rows;
      let stored = 0;
      const unmatched = [];
      for (const vehicle of envelope.data.vehicles) {
        const bus = buses.find((row) =>
          [row.telemetry_device_id, row.bus_number, row.registration].some(
            (key) =>
              key && [vehicle.deviceId, vehicle.vendorCode, vehicle.vehicleNumber].includes(key),
          ),
        );
        if (!bus) {
          unmatched.push(vehicle.vehicleNumber);
          continue;
        }
        await client.query(
          `INSERT INTO cam.telemetry(tenant_id,bus_id,device_id,gps_time,source,payload)
          VALUES($1,$2,$3,$4,'vendor',$5::jsonb) ON CONFLICT DO NOTHING`,
          [tenantId, bus.id, bus.telemetry_device_id, vehicle.gpsTime, JSON.stringify(vehicle)],
        );
        stored++;
      }
      return { stored, unmatched };
    });
  }
  async pollWheelseyeSources() {
    if (!this.cipher) return;
    const candidates = (await this.db.pool.query('SELECT * FROM cam.wheelseye_candidates()')).rows;
    for (const candidate of candidates) {
      try {
        const config = this.cipher.open(candidate.payload, candidate.tenant_id);
        const envelope = await fetchWheelseye({ accessToken: config.accessToken });
        await this.db.transaction(async (client) => {
          await client.query(
            "SELECT set_config('cam.tenant_id',$1,true),set_config('cam.role','admin',true)",
            [candidate.tenant_id],
          );
          const admin = (
            await client.query(
              'SELECT cam.wheelseye_admin($1) AS id',
              [candidate.tenant_id],
            )
          ).rows[0];
          if (!admin) throw new Error('No active workspace admin is available.');
          await client.query("SELECT set_config('cam.user_id',$1,true)", [admin.id]);
          for (const vehicle of envelope.data.vehicles) {
            await client.query(
              `INSERT INTO cam.wheelseye_devices(tenant_id,source_id,device_number,vehicle_number,vendor_code,vendor_name,vehicle_type,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(tenant_id,source_id,device_number) DO UPDATE SET vehicle_number=excluded.vehicle_number,vendor_code=excluded.vendor_code,vendor_name=excluded.vendor_name,vehicle_type=excluded.vehicle_type,data=excluded.data,last_seen_at=now()`,
              [
                candidate.tenant_id,
                candidate.id,
                vehicle.deviceId,
                vehicle.vehicleNumber,
                vehicle.vendorCode,
                vehicle.vendorName,
                vehicle.vehicleType,
                JSON.stringify(vehicle),
              ],
            );
            await client.query(
              `INSERT INTO cam.wheelseye_location_logs(tenant_id,source_id,device_number,gps_time,latitude,longitude,speed,ignition,angle,charge_on,accurate,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT DO NOTHING`,
              [
                candidate.tenant_id,
                candidate.id,
                vehicle.deviceId,
                vehicle.gpsTime,
                vehicle.location.latitude,
                vehicle.location.longitude,
                vehicle.speed,
                vehicle.ignition,
                vehicle.angle || 0,
                vehicle.chargeOn,
                vehicle.accurate,
                JSON.stringify(vehicle),
              ],
            );
            const previous = (
              await client.query(
                'SELECT latitude,longitude FROM cam.wheelseye_location_segments WHERE tenant_id=$1 AND device_number=$2 ORDER BY segment_start DESC LIMIT 1',
                [candidate.tenant_id, vehicle.deviceId],
              )
            ).rows[0];
            if (!previous || distanceMeters(previous.latitude, previous.longitude, vehicle.location.latitude, vehicle.location.longitude) > 10) {
              await client.query(
                `INSERT INTO cam.wheelseye_location_segments(tenant_id,device_number,provider_gps_time,segment_start,latitude,longitude,speed,ignition,fuel_litres,address,source_id,payload_hash)
                 VALUES($1,$2,$3,to_timestamp($3::double precision),$4,$5,$6,$7,$8,$9,$10,md5($11::text)) ON CONFLICT DO NOTHING`,
                [
                  candidate.tenant_id,
                  vehicle.deviceId,
                  vehicle.gpsTime,
                  vehicle.location.latitude,
                  vehicle.location.longitude,
                  vehicle.speed,
                  vehicle.ignition,
                  vehicle.fuelData?.currentLiters ?? null,
                  vehicle.location.address || null,
                  candidate.id,
                  JSON.stringify(vehicle),
                ],
              );
            }
          }
        });
        await this.db.pool.query('SELECT cam.wheelseye_mark($1,true,NULL)', [candidate.id]);
      } catch (error) {
        await this.db.pool
          .query('SELECT cam.wheelseye_mark($1,false,$2)', [candidate.id, error.message])
          .catch(() => {});
      }
    }
  }
  startWheelseyePolling({ intervalMs = 60000 } = {}) {
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await this.pollWheelseyeSources();
      } catch (error) {
        console.error(`[wheelseye] poll failed: ${error.message}`);
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
  async list(token) {
    return this.db.session(tokenHash(token), async (client, p) => {
      const rows = (await client.query('SELECT * FROM cam.buses ORDER BY bus_number')).rows;
      const grants =
        p.role === 'member'
          ? (
              await client.query(
                'SELECT device_id,channels FROM cam.grants WHERE user_id=$1 AND can_view',
                [p.id],
              )
            ).rows
          : [];
      return {
        buses: rows.map((row) => {
          const bus = shape(row),
            channels = grants.find((g) => g.device_id === bus.recorderId)?.channels;
          if (p.role === 'member' && channels)
            bus.favoriteChannels = bus.favoriteChannels.filter((n) => channels.includes(n));
          return bus;
        }),
      };
    });
  }
  async save(token, input) {
    const data = busInput(input),
      id = input.id ?? randomUUID();
    if (!uuid.test(id)) throw new HttpError('Invalid bus ID.');
    return this.db.session(tokenHash(token), async (client, p) => {
      if (p.role !== 'admin')
        throw new HttpError('Only workspace admins can configure buses.', 403);
      await client.query('SELECT id FROM cam.tenants WHERE id=$1 FOR UPDATE', [p.tenantId]);
      if (input.id && !(await client.query('SELECT id FROM cam.buses WHERE id=$1', [id])).rowCount)
        throw new HttpError('Bus not found.', 404);
      if (data.recorderId) {
        const device = (
          await client.query('SELECT data FROM cam.devices WHERE device_id=$1 AND available', [
            data.recorderId,
          ])
        ).rows[0]?.data;
        if (!device) throw new HttpError('Import this recorder into your workspace first.');
        if (data.favoriteChannels.some((n) => !device.channels?.some((c) => c.number === n)))
          throw new HttpError('Choose channels from the mapped recorder.');
      } else if (data.favoriteChannels.length)
        throw new HttpError('Map a recorder before selecting cameras.');
      const conflict = await client.query(
        'SELECT id FROM cam.buses WHERE id<>$1 AND (lower(bus_number)=lower($2) OR lower(registration)=lower($3) OR recorder_id=$4 OR telemetry_device_id=$5)',
        [id, data.busNumber, data.registration, data.recorderId, data.telemetryDeviceId],
      );
      if (conflict.rowCount)
        throw new HttpError(
          'Bus number, registration, recorder or telemetry device is already assigned.',
          409,
          'mapping-conflict',
        );
      const row = (
        await client.query(
          `INSERT INTO cam.buses(id,tenant_id,bus_number,registration,driver_name,driver_phone,route_name,recorder_id,telemetry_device_id,favorite_channels)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET bus_number=excluded.bus_number,registration=excluded.registration,
      driver_name=excluded.driver_name,driver_phone=excluded.driver_phone,route_name=excluded.route_name,recorder_id=excluded.recorder_id,
      telemetry_device_id=excluded.telemetry_device_id,favorite_channels=excluded.favorite_channels,updated_at=now() RETURNING *`,
          [
            id,
            p.tenantId,
            data.busNumber,
            data.registration,
            data.driverName,
            data.driverPhone,
            data.routeName,
            data.recorderId,
            data.telemetryDeviceId,
            data.favoriteChannels,
          ],
        )
      ).rows[0];
      await writeAudit(client, {
        tenantId: p.tenantId,
        actorId: p.id,
        action: input.id ? 'fleet.bus_updated' : 'fleet.bus_created',
        targetId: id,
      });
      return { bus: shape(row) };
    });
  }
  async remove(token, id) {
    if (!uuid.test(id)) throw new HttpError('Invalid bus ID.');
    return this.db.session(tokenHash(token), async (client, p) => {
      if (p.role !== 'admin') throw new HttpError('Only workspace admins can remove buses.', 403);
      if (!(await client.query('DELETE FROM cam.buses WHERE id=$1', [id])).rowCount)
        throw new HttpError('Bus not found.', 404);
      await writeAudit(client, {
        tenantId: p.tenantId,
        actorId: p.id,
        action: 'fleet.bus_deleted',
        targetId: id,
      });
      return { removed: true };
    });
  }
  async pollMock(token) {
    return this.db.session(tokenHash(token), async (client, p) => {
      if (p.role !== 'admin')
        throw new HttpError('Only workspace admins can poll the mock provider.', 403);
      const buses = (
        await client.query('SELECT * FROM cam.buses WHERE telemetry_device_id IS NOT NULL')
      ).rows;
      const now = Math.floor(Date.now() / 60000) * 60,
        vehicles = [];
      for (const bus of buses) {
        const samples = Array.from({ length: 121 }, (_, i) =>
          mockVehicle(bus.telemetry_device_id, bus.registration, now - (120 - i) * 60),
        );
        await client.query(
          `INSERT INTO cam.telemetry(tenant_id,bus_id,device_id,gps_time,source,payload)
        SELECT $1,$2,$3,(item->>'gpsTime')::bigint,'mock',item FROM jsonb_array_elements($4::jsonb) item
        ON CONFLICT DO NOTHING`,
          [p.tenantId, bus.id, bus.telemetry_device_id, JSON.stringify(samples)],
        );
        vehicles.push(samples.at(-1));
      }
      // Mock retention is bounded; real vendor retention will be configured separately.
      await client.query("DELETE FROM cam.telemetry WHERE source='mock' AND gps_time<$1", [
        now - 86400,
      ]);
      return {
        message: 'Ok',
        success: true,
        serverTime: now,
        data: { pageNo: 0, totalPage: 1, vehicles },
        source: 'mock',
      };
    });
  }
  async pollWheelseye(token, { fetchImpl = fetch } = {}) {
    const principal = await this.db.session(tokenHash(token), async (_client, p) => p);
    if (principal.role !== 'admin')
      throw new HttpError('Only workspace admins can poll WheelsEye.', 403);
    const envelope = await fetchWheelseye({ accessToken: await readWheelseyeToken(), fetchImpl });
    return this.db.session(tokenHash(token), async (client, p) => {
      const buses = (
        await client.query('SELECT * FROM cam.buses WHERE telemetry_device_id IS NOT NULL')
      ).rows;
      const matched = [],
        unmatched = [];
      for (const vehicle of envelope.data.vehicles) {
        const bus = buses.find((row) =>
          [row.telemetry_device_id, row.bus_number, row.registration].some(
            (key) =>
              key && [vehicle.deviceId, vehicle.vendorCode, vehicle.vehicleNumber].includes(key),
          ),
        );
        if (!bus) {
          unmatched.push(vehicle.vehicleNumber);
          continue;
        }
        await client.query(
          `INSERT INTO cam.telemetry(tenant_id,bus_id,device_id,gps_time,source,payload)
          VALUES($1,$2,$3,$4,'vendor',$5::jsonb) ON CONFLICT DO NOTHING`,
          [p.tenantId, bus.id, bus.telemetry_device_id, vehicle.gpsTime, JSON.stringify(vehicle)],
        );
        matched.push(vehicle.vehicleNumber);
      }
      return {
        ...envelope,
        source: 'vendor',
        provider: 'WHEELSEYE',
        stored: matched.length,
        unmatched,
      };
    });
  }
  async liveWheelseye(token, busId, { fetchImpl = fetch } = {}) {
    if (!uuid.test(busId)) throw new HttpError('Choose a valid bus.', 400);
    const config = await this.db.session(tokenHash(token), async (client, principal) => {
      const bus = (await client.query('SELECT telemetry_device_id FROM cam.buses WHERE id=$1', [busId])).rows[0];
      if (!bus?.telemetry_device_id) throw new HttpError('Map a WheelsEye device to this bus first.', 409, 'telemetry-device-required');
      const source = (await client.query('SELECT * FROM cam.wheelseye_source_for_device($1,$2)', [principal.tenantId, bus.telemetry_device_id])).rows[0];
      if (!source) throw new HttpError('The mapped WheelsEye device is not available from an active source.', 409, 'telemetry-source-unavailable');
      return { deviceId: bus.telemetry_device_id, payload: source.payload, sourceId: source.source_id, tenantId: principal.tenantId };
    });
    const opened = this.cipher.open(config.payload, config.tenantId);
    const envelope = await fetchWheelseye({ accessToken: opened.accessToken, fetchImpl });
    const vehicle = envelope.data.vehicles.find((item) => item.deviceId === config.deviceId);
    if (!vehicle) throw new HttpError('The mapped device was not returned by WheelsEye.', 502, 'telemetry-device-missing');
    return { vehicle, source: 'vendor', fetchedAt: Date.now(), provider: 'WHEELSEYE' };
  }
  async latest(token) {
    return this.db.session(tokenHash(token), async (client) => {
      const rows = (
        await client.query(`WITH samples AS (SELECT t.tenant_id,t.bus_id,t.device_id,t.gps_time,t.payload,t.source FROM cam.telemetry t UNION ALL SELECT l.tenant_id,b.id,l.device_number,l.gps_time,l.payload,'vendor' FROM cam.wheelseye_location_logs l JOIN cam.buses b ON b.tenant_id=l.tenant_id AND b.telemetry_device_id=l.device_number)
        SELECT DISTINCT ON (b.id) s.payload,s.source FROM cam.buses b JOIN samples s ON s.tenant_id=b.tenant_id AND s.bus_id=b.id AND s.device_id=b.telemetry_device_id ORDER BY b.id,s.gps_time DESC LIMIT 1000`)
      ).rows;
      return {
        message: 'Ok',
        success: true,
        serverTime: Math.floor(Date.now() / 1000),
        data: { pageNo: 0, totalPage: 1, vehicles: rows.map((r) => r.payload) },
        source: rows.some((r) => r.source === 'vendor') ? 'vendor' : 'mock',
      };
    });
  }
  async history(token, id, from, to) {
    if (
      !uuid.test(id) ||
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to - from > 86400
    )
      throw new HttpError('Choose a history window of up to 24 hours using Unix seconds.');
    return this.db.session(tokenHash(token), async (client, p) => {
      const bus = (await client.query('SELECT * FROM cam.buses WHERE id=$1', [id])).rows[0];
      if (!bus) throw new HttpError('Bus not found.', 404);
      const rows = (
        await client.query(
          `SELECT payload,source,received_at FROM cam.telemetry WHERE bus_id=$1 AND device_id=$2 AND gps_time BETWEEN $3 AND $4
           UNION ALL SELECT l.payload,'vendor',l.received_at FROM cam.wheelseye_location_logs l WHERE l.tenant_id=$5 AND l.device_number=$2 AND l.gps_time BETWEEN $3 AND $4 ORDER BY received_at LIMIT 1441`,
          [id, bus.telemetry_device_id, from, to, p.tenantId],
        )
      ).rows;
      const result = shape(bus);
      if (p.role === 'member') {
        const grants = (
          await client.query(
            'SELECT channels FROM cam.grants WHERE device_id=$1 AND user_id=$2 AND can_view',
            [bus.recorder_id, p.id],
          )
        ).rows[0];
        if (grants?.channels)
          result.favoriteChannels = result.favoriteChannels.filter((n) =>
            grants.channels.includes(n),
          );
      }
      return {
        bus: result,
        samples: rows.map((r) => ({
          vehicle: r.payload,
          source: r.source,
          receivedAt: r.received_at,
        })),
        from,
        to,
      };
    });
  }
}
