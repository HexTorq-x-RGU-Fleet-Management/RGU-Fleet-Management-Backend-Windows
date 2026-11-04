import { request as httpsRequest } from 'node:https';

const DEFAULT_BASE_URL = 'https://wheelseye.com';
const DEFAULT_APP_VERSION = '18.4.0';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Standalone WheelsEye portal client.
 *
 * This file is intentionally not wired into the backend routes or poller. It
 * can be imported by a future integration and initialized for any authorized
 * account with: new WheelsEyePortal(username, password).
 *
 * The temporary provider token is kept in memory only. It is never returned,
 * logged, or written to disk. A 401/403 causes one automatic re-login and retry.
 */
export class WheelsEyePortal {
  constructor(username, password, options = {}) {
    if (!String(username || '').trim()) throw new TypeError('username is required');
    if (!String(password || '')) throw new TypeError('password is required');
    this.username = String(username).trim();
    this.password = String(password);
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this.appVersion = String(options.appVersion || DEFAULT_APP_VERSION);
    this.timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl || providerFetch;
    this.token = null;
    this.cookie = null;
    this.authenticatedAt = null;
    this.loginPromise = null;
  }

  sessionStatus() {
    return {
      authenticated: Boolean(this.token),
      authenticatedAt: this.authenticatedAt,
    };
  }

  clearSession() {
    this.token = null;
    this.cookie = null;
    this.authenticatedAt = null;
  }

  async login({ force = false } = {}) {
    if (force) this.clearSession();
    if (this.token) return this.sessionStatus();
    if (!this.loginPromise) {
      this.loginPromise = this.#login().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
    return this.sessionStatus();
  }

  async #login() {
    const response = await this.#requestProvider('/shield/admin/v3/login', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; RGU-Fleet-Management/1.0)',
        origin: this.baseUrl,
        referer: `${this.baseUrl}/fo/login`,
      },
      body: JSON.stringify({ userName: this.username, password: this.password }),
    });
    const body = await readJson(response);
    if (!response.ok || body?.success === false)
      throw providerError(
        response.status,
        'WHEELSEYE_LOGIN_FAILED',
        'WheelsEye rejected the account credentials.',
      );
    const token =
      findToken(body) ||
      tokenFromCookie(response.headers.get('set-cookie')) ||
      response.headers.get('accessToken');
    if (!token)
      throw providerError(
        502,
        'WHEELSEYE_TOKEN_MISSING',
        'WheelsEye returned no access token after login.',
      );
    this.token = token;
    const setCookie = response.headers.get('set-cookie');
    this.cookie = setCookie
      ? setCookie.split(';', 1)[0]
      : `accessToken=${encodeURIComponent(token)}`;
    this.authenticatedAt = new Date().toISOString();
  }

  /** Official vehicle directory page, including all provider fields. */
  async getVehiclesList({ page = 0, size = 50 } = {}) {
    assertInteger(page, 'page', 0);
    assertInteger(size, 'size', 1);
    return this.#request(`/rest/argus/app/vehicles/static?pageNo=${page}&size=${size}`);
  }

  /** All vehicle directory pages combined into one provider-style result. */
  async getAllVehiclesList({ size = 100 } = {}) {
    assertInteger(size, 'size', 1);
    const first = await this.getVehiclesList({ page: 0, size });
    const pages = [first];
    const totalPages = Number(first?.data?.totalPages || 1);
    for (let page = 1; page < totalPages; page += 1)
      pages.push(await this.getVehiclesList({ page, size }));
    const lists = pages.map((value) => value?.data?.list || []);
    return {
      ...first,
      data: {
        ...(first.data || {}),
        pageNo: 0,
        list: lists.flat(),
      },
    };
  }

  /** Official GPS/dynamic response for the requested provider vehicle IDs. */
  async getGpsList(vehicleIds) {
    const ids = assertVehicleIds(vehicleIds);
    return this.#request('/rest/argus/app/vehicles-dynamic', {
      method: 'POST',
      body: JSON.stringify({ vehicleIds: ids }),
    });
  }

  /** Official fuel-sensor vehicle page, including all provider fields. */
  async getFuelList({ page = 0, pageSize = 100, filter = 'all' } = {}) {
    assertInteger(page, 'page', 0);
    assertInteger(pageSize, 'pageSize', 1);
    const query = new URLSearchParams({
      pageNo: String(page),
      pageSize: String(pageSize),
      filter: String(filter),
    });
    return this.#request(`/rest/saathi/fuel-sensor/vehicle?${query}`);
  }

  /** All fuel-sensor pages combined into one provider-style result. */
  async getAllFuelList({ pageSize = 100, filter = 'all' } = {}) {
    const first = await this.getFuelList({ page: 0, pageSize, filter });
    const pages = [first];
    const totalPages = Number(first?.totalPages || 1);
    for (let page = 1; page < totalPages; page += 1)
      pages.push(await this.getFuelList({ page, pageSize, filter }));
    return {
      ...first,
      data: pages.flatMap((value) => value?.data || []),
    };
  }

  async getVehicleLive(vehicleId) {
    const id = assertInteger(vehicleId, 'vehicleId', 1);
    const response = await this.getGpsList([id]);
    return response?.data?.[id] ?? null;
  }

  async getVehicleFuel(vehicleId) {
    const id = assertInteger(vehicleId, 'vehicleId', 1);
    const response = await this.getAllFuelList();
    return (response?.data || []).find((item) => Number(item.vId) === id) ?? null;
  }

  /** Latest GPS and fuel responses combined for one vehicle. */
  async getVehicleLatest(vehicleId) {
    const id = assertInteger(vehicleId, 'vehicleId', 1);
    const [gps, fuel] = await Promise.all([this.getVehicleLive(id), this.getVehicleFuel(id)]);
    return {
      vehicleId: id,
      fetchedAt: new Date().toISOString(),
      gps,
      fuel,
    };
  }

  /** Every vehicle's metadata, GPS and fuel in a single combined response. */
  async getAllVehiclesLatest() {
    const [directory, fuelResponse] = await Promise.all([
      this.getAllVehiclesList(),
      this.getAllFuelList(),
    ]);
    const vehicles = directory?.data?.list || [];
    const ids = vehicles.map((item) => Number(item.vehicleId)).filter(Number.isInteger);
    const gpsResponse = ids.length ? await this.getGpsList(ids) : { data: {} };
    const fuelById = new Map((fuelResponse?.data || []).map((item) => [Number(item.vId), item]));
    return {
      fetchedAt: new Date().toISOString(),
      totalCount: vehicles.length,
      vehicles: vehicles.map((vehicle) => ({
        ...vehicle,
        gps: gpsResponse?.data?.[vehicle.vehicleId] ?? null,
        fuel: fuelById.get(Number(vehicle.vehicleId)) ?? null,
      })),
    };
  }

  async getFuelEvents(vehicleId, { type, from, to }) {
    const id = assertInteger(vehicleId, 'vehicleId', 1);
    const eventType = String(type || '').toUpperCase();
    if (!['FUELING', 'THEFT'].includes(eventType))
      throw new TypeError('type must be FUELING or THEFT');
    const query = timeQuery({ vehicleId: id, type: eventType, fromTime: from, toTime: to });
    return this.#request(`/rest/saathi/fuel-sensor/events?${query}`);
  }

  async getFuelAnalytics(vehicleId, { from, to }) {
    const id = assertInteger(vehicleId, 'vehicleId', 1);
    const query = timeQuery({ vehicleId: id, fromTime: from, toTime: to });
    return this.#request(`/rest/saathi/fuel-sensor/analytics?${query}`);
  }

  async getVehiclePath(vehicleId, { from, to }) {
    const id = assertInteger(vehicleId, 'vehicleId', 1);
    const query = timeQuery({ vehicleId: id, fromTime: from, toTime: to });
    return this.#request(`/vehicle/getPathDetail?${query}`);
  }

  async #request(path, options = {}, retry = true) {
    await this.login();
    const response = await this.#requestProvider(path, {
      ...options,
      headers: {
        accept: 'application/json, text/plain, */*',
        'user-agent': 'Mozilla/5.0 (compatible; RGU-Fleet-Management/1.0)',
        source: 'OPERATOR_WEB',
        'x-app-version': this.appVersion,
        token: this.token,
        cookie: this.cookie,
        referer: `${this.baseUrl}/node/dashboard`,
        ...(options.body != null ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    if ((response.status === 401 || response.status === 403) && retry) {
      await this.login({ force: true });
      return this.#request(path, options, false);
    }
    const body = await readJson(response);
    if (!response.ok || body?.success === false)
      throw providerError(
        response.status,
        'WHEELSEYE_REQUEST_FAILED',
        `WheelsEye request failed with HTTP ${response.status}.`,
      );
    return body;
  }

  async #requestProvider(path, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError')
        throw providerError(504, 'WHEELSEYE_TIMEOUT', 'WheelsEye request timed out.');
      throw providerError(502, 'WHEELSEYE_UNAVAILABLE', 'WheelsEye could not be reached.');
    } finally {
      clearTimeout(timer);
    }
  }
}

function assertInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new TypeError(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function assertVehicleIds(value) {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError('vehicleIds must be a non-empty array');
  return value.map((item) => assertInteger(item, 'vehicleId', 1));
}

function timeQuery(values) {
  const fromTime = assertInteger(values.fromTime, 'from', 0);
  const toTime = assertInteger(values.toTime, 'to', 0);
  if (fromTime >= toTime) throw new TypeError('from must precede to');
  return new URLSearchParams({ ...values, fromTime: String(fromTime), toTime: String(toTime) });
}

function providerError(status, code, message) {
  const error = new Error(message);
  error.name = 'WheelsEyeProviderError';
  error.status = status || 502;
  error.code = code;
  return error;
}

function findToken(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findToken(item, depth + 1);
      if (token) return token;
    }
    return null;
  }
  for (const key of ['accessToken', 'access_token', 'token', 'authToken']) {
    if (typeof value[key] === 'string' && value[key].length >= 20) return value[key];
  }
  for (const item of Object.values(value)) {
    const token = findToken(item, depth + 1);
    if (token) return token;
  }
  return null;
}

function tokenFromCookie(header) {
  const match = String(header || '').match(/(?:^|[,;]\s*)accessToken=([^;,\s]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw providerError(
      502,
      'WHEELSEYE_INVALID_RESPONSE',
      'WheelsEye returned a non-JSON response.',
    );
  }
}

function providerFetch(input, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    const request = httpsRequest(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers,
        family: 4,
        signal: options.signal,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
            else if (value != null) headers.set(name, value);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode || 500,
              statusText: response.statusMessage,
              headers,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    if (options.body != null) request.write(options.body);
    request.end();
  });
}

export default WheelsEyePortal;
