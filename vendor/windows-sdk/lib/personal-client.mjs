// Experimental personal-portal protocol, observed in the official login bundle.
// No Windows SDK, Chrome dependency, developer key, or imported v1 module.
import { constants, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';

export const origins = Object.freeze(['https://iindia.hik-connect.com', 'https://www.hik-connect.com']);
export class PortalError extends Error {
  constructor(message, { code, status } = {}) {
    super(message); this.name = 'PortalError'; this.code = code; this.status = status;
  }
}
function checkedOrigin(origin) {
  if (!origins.includes(origin)) throw new PortalError('Only the observed India and global portal origins are allowed.');
  return origin;
}
export function parsePublicKey(value) {
  if (typeof value !== 'string' || value.length > 20000) throw new PortalError('The public-key response has an unrecognized format.');
  try {
    // JSEncrypt accepts a PEM key or a base64 SPKI public key.
    const pem = value.includes('-----BEGIN ') ? value : `-----BEGIN PUBLIC KEY-----\n${value}\n-----END PUBLIC KEY-----`;
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 1024)
      throw new Error('Unsupported key');
    return key;
  } catch { throw new PortalError('The server did not supply a supported RSA public key.'); }
}
export function encryptPortalPassword(password, key, now = Date.now()) {
  if (typeof password !== 'string' || !password || password.length > 4096 || !Number.isFinite(now) || now < 1000)
    throw new PortalError('A password and valid system time are required.');
  // Protocol compatibility only: this reproduces the observed portal envelope.
  // MD5 is not used here as an application password-storage scheme.
  const digest = createHash('md5').update(password, 'utf8').digest('hex');
  const payload = Buffer.from(`${digest},${Math.floor(now / 1000)}`, 'utf8');
  try { return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, payload).toString('base64'); }
  catch { throw new PortalError('Could not construct the portal password envelope.'); }
}

export class PersonalClient {
  constructor({ origin = origins[0], featureCode = randomBytes(16).toString('hex'), request = fetch } = {}) {
    this.origin = checkedOrigin(origin);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(featureCode)) throw new PortalError('Invalid client feature code.');
    this.featureCode = featureCode; this.request = request; this.sessionId = null;
  }
  async call(path, { form, authenticated = false } = {}) {
    if (authenticated && !this.sessionId) throw new PortalError('Sign in before querying devices.');
    let response;
    try {
      response = await this.request(this.origin + path, {
        method: form ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: {
          Accept: 'application/json', clientType: '48', clientSource: '0', customno: '1000002',
          featureCode: this.featureCode, Referer: this.origin + '/views/login/index.html',
          ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', appId: 'Hik-Connect-Portal' } : {}),
          ...(authenticated ? { sessionId: this.sessionId, Cookie: 'HC_sessionId=' + encodeURIComponent(this.sessionId) } : {})
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {})
      });
    } catch { throw new PortalError('Portal request failed. Check connectivity; no automatic login retry was made.'); }
    if (!response.ok) {
      if (authenticated && [401, 403].includes(response.status)) this.sessionId = null;
      throw new PortalError('The portal returned an HTTP error.', { status: response.status });
    }
    try { return await response.json(); }
    catch { throw new PortalError('The portal returned an unexpected response format.'); }
  }
  async publicKey() {
    const body = await this.call('/v3/users/publickey');
    // Observed portal code reads publicKey directly; tolerate a data wrapper only
    // where it actually contains that same field, without guessing other names.
    return parsePublicKey(body.publicKey ?? body.data?.publicKey);
  }
  async login({ account, password, imageCode = '' }) {
    this.sessionId = null;
    if (typeof account !== 'string' || !account.trim() || account.length > 320 || /[\r\n]/.test(account))
      throw new PortalError('A valid account identifier is required.');
    if (typeof imageCode !== 'string' || imageCode.length > 128) throw new PortalError('Invalid verification code.');
    const encrypted = encryptPortalPassword(password, await this.publicKey());
    const body = await this.call('/v3/users/login/v6', { form: {
      account: account.trim(), password: encrypted, imageCode,
      checkSign: 'true', cuName: Buffer.from('Chrome').toString('base64'), featureCode: this.featureCode
    } });
    const code = Number(body.meta?.code);
    if (code === 1100) {
      const domain = body.loginArea?.webDomain;
      const target = typeof domain === 'string' ? `https://${domain}` : null;
      return { state: 'region-required', origin: origins.includes(target) ? target : null, code };
    }
    if (code !== 200) throw new PortalError('Hik-Connect did not accept this sign-in. Check your ID and password. If Hik-Connect requests verification, complete it on the official Hik-Connect sign-in page.', { code: Number.isFinite(code) ? code : undefined });
    const token = body.loginSession?.sessionId;
    if (typeof token !== 'string' || !token || token.length > 16000 || /[\r\n;]/.test(token))
      throw new PortalError('Login returned an unrecognized session format.');
    this.sessionId = token;
    const user = body.loginUser || {};
    this.account = { accountUserId: user.userId === undefined ? '' : String(user.userId),
      user: { username: user.username || account.trim(), email: user.email || '', country: body.loginArea?.areaName || '' } };
    return { state: 'signed-in', origin: this.origin };
  }
  async sharedSummary() {
    const body = await this.call('/v3/hcweb/share/domains', { authenticated: true });
    const code = body.meta?.code;
    if (code !== undefined && Number(code) !== 200) {
      if (Number(code) === 401) this.sessionId = null;
      throw new PortalError('The portal rejected shared-device discovery.', { code: Number(code) });
    }
    const records = body.meta ? body.data?.data ?? body.data : body.data;
    if (!Array.isArray(records)) throw new PortalError('The shared-device list needs a schema update.');
    // No serial numbers, account identifiers or credentials in CLI output.
    return { sharedDevices: records.length,
      online: records.filter(record => record?.status === 1).length,
      offline: records.filter(record => record?.status === 2).length };
  }
  close() { this.sessionId = null; }
}

// Follow only an explicit, allowlisted regional redirect; rejected credentials
// are never retried automatically.
export async function signInPersonal(input, { Client = PersonalClient } = {}) {
  let origin = input.origin || origins[0];
  for (let route = 0; route < 2; route++) {
    const client = new Client({ origin });
    try {
      const result = await client.login(input);
      if (result.state === 'region-required' && route === 0 && origins.includes(result.origin) && result.origin !== origin) { origin = result.origin; continue; }
      if (result.state !== 'signed-in') return result;
      return { credentials: { sessionId: client.sessionId, origin: client.origin, ...client.account } };
    } finally { client.close(); }
  }
}
