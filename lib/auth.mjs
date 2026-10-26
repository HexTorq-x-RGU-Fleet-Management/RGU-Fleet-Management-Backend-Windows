import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as derive,
  timingSafeEqual,
  createPublicKey,
  createVerify,
} from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './database.mjs';
const scrypt = promisify(derive);
const googleKeysUrl = 'https://www.googleapis.com/oauth2/v3/certs';
let googleKeys = null;
let googleKeysExpiresAt = 0;
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export function validEmail(value) {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
    throw new HttpError('Enter a valid email address.');
  return value.trim().toLowerCase();
}
export function text(value, label, max = 100) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > max ||
    /[\x00-\x1f]/.test(value)
  )
    throw new HttpError(`Enter a valid ${label}.`);
  return value.trim();
}
export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw new HttpError('Use a password between 12 and 128 characters.');
  const hash = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: hash.toString('hex') };
}
async function matches(password, user) {
  if (typeof password !== 'string' || password.length > 128) return false;
  const hash = await scrypt(
    password,
    user?.password_salt || '00000000000000000000000000000000',
    64,
    { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  );
  return Boolean(
    user &&
    /^[a-f0-9]{128}$/.test(user.password_hash) &&
    timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex')),
  );
}

function decodePart(value, label) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(`Invalid Google ${label}.`, 401, 'invalid-google-token');
  }
}

async function googleJwks() {
  if (googleKeys && googleKeysExpiresAt > Date.now()) return googleKeys;
  const response = await fetch(googleKeysUrl);
  if (!response.ok) throw new HttpError('Google sign-in is temporarily unavailable.', 503);
  const body = await response.json();
  const cache = response.headers.get('cache-control')?.match(/max-age=(\d+)/i);
  googleKeys = body.keys || [];
  googleKeysExpiresAt = Date.now() + Math.max(60, Number(cache?.[1] || 3600)) * 1000;
  return googleKeys;
}

async function verifyGoogleToken(token) {
  const audience = process.env.GOOGLE_CLIENT_ID;
  if (!audience) throw new HttpError('Google sign-in is not configured.', 503, 'google-not-configured');
  if (typeof token !== 'string' || token.length > 8192)
    throw new HttpError('Invalid Google credential.', 401, 'invalid-google-token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError('Invalid Google credential.', 401, 'invalid-google-token');
  const header = decodePart(parts[0], 'credential');
  const claims = decodePart(parts[1], 'credential');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw new HttpError('Invalid Google credential.', 401, 'invalid-google-token');
  const key = (await googleJwks()).find((candidate) => candidate.kid === header.kid);
  if (!key) {
    googleKeys = null;
    googleKeysExpiresAt = 0;
    throw new HttpError('Google credential key has expired. Try again.', 401, 'invalid-google-token');
  }
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url')))
    throw new HttpError('Invalid Google credential.', 401, 'invalid-google-token');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss))
    throw new HttpError('Invalid Google credential issuer.', 401, 'invalid-google-token');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience) || typeof claims.sub !== 'string' || !claims.sub)
    throw new HttpError('Google credential is for another application.', 401, 'invalid-google-token');
  if (!Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000))
    throw new HttpError('Google credential has expired.', 401, 'invalid-google-token');
  if (claims.email_verified !== true || typeof claims.email !== 'string')
    throw new HttpError('Google email verification is required.', 401, 'google-email-unverified');
  return { subject: claims.sub, email: validEmail(claims.email) };
}

function googleCredential(input) {
  return input?.credential || input?.idToken || input?.token;
}
export class Auth {
  constructor(db) {
    this.db = db;
  }
  async setupRequired() {
    return !(await this.db.pool.query('SELECT cam.root_exists() AS configured')).rows[0].configured;
  }
  async bootstrap(input) {
    const email = validEmail(input.email),
      fullName = text(input.fullName, 'name'),
      password = await hashPassword(input.password),
      id = randomUUID();
    await this.db.pool.query('SELECT cam.bootstrap_root($1,$2,$3,$4,$5)', [
      id,
      email,
      fullName,
      password.salt,
      password.hash,
    ]);
    return this.login(input);
  }
  async signup(input) {
    if (await this.setupRequired())
      throw new HttpError('The platform administrator must finish setup first.', 503);
    const email = validEmail(input.email),
      fullName = text(input.fullName, 'name'),
      name = text(input.workspaceName, 'workspace name'),
      password = await hashPassword(input.password);
    await this.db.pool.query('SELECT cam.request_admin($1,$2,$3,$4,$5,$6,$7)', [
      randomUUID(),
      randomUUID(),
      email,
      fullName,
      name,
      password.salt,
      password.hash,
    ]);
    return {
      status: 'pending',
      message:
        'Your workspace request is waiting for platform approval. You can sign in after it is approved.',
    };
  }
  async login(input) {
    const email = validEmail(input.email),
      user = (await this.db.pool.query('SELECT * FROM cam.login_record($1)', [email])).rows[0];
    if (!(await matches(input.password, user)))
      throw new HttpError('Email or password is incorrect.', 401, 'invalid-credentials');
    if (user.status === 'pending')
      throw new HttpError(
        'Your workspace request is waiting for superadmin approval.',
        403,
        'approval-pending',
      );
    if (user.status !== 'active')
      throw new HttpError(
        user.status === 'rejected'
          ? 'This workspace request was not approved.'
          : 'This account is suspended. Contact your administrator.',
        403,
        'account-inactive',
      );
    const token = randomBytes(32).toString('hex');
    try {
      await this.db.pool.query('SELECT cam.issue_session($1,$2,$3)', [
        user.id,
        tokenHash(token),
        user.auth_version,
      ]);
    } catch (error) {
      if (error.code === '42501')
        throw new HttpError(
          'This workspace is suspended. Contact the platform administrator.',
          403,
          'account-inactive',
        );
      throw error;
    }
    return { token, principal: await this.principal(token) };
  }
  async linkGoogle(token, input) {
    const principal = await this.principal(token);
    const google = await verifyGoogleToken(googleCredential(input));
    if (google.email !== principal.email)
      throw new HttpError('Use the Google account with the same approved RGU email.', 409, 'google-email-mismatch');
    try {
      await this.db.pool.query('UPDATE cam.users SET google_subject=$1 WHERE id=$2', [google.subject, principal.id]);
    } catch (error) {
      if (error.code === '23505') throw new HttpError('That Google account is already linked.', 409, 'google-already-linked');
      throw error;
    }
    return { linked: true };
  }
  async googleLogin(input) {
    const google = await verifyGoogleToken(googleCredential(input));
    const user = (await this.db.pool.query('SELECT * FROM cam.google_login_record($1)', [google.subject])).rows[0];
    if (!user) throw new HttpError('Link Google from your approved RGU account first.', 403, 'google-not-linked');
    if (user.status !== 'active') throw new HttpError('This account is not active.', 403, 'account-inactive');
    const token = randomBytes(32).toString('hex');
    await this.db.pool.query('SELECT cam.issue_session($1,$2,$3)', [user.id, tokenHash(token), user.auth_version]);
    return { token, principal: await this.principal(token) };
  }
  principal(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
      throw new HttpError('Sign in to your workspace.', 401, 'viewer-auth-required');
    return this.db.session(tokenHash(token), async (_client, user) => user);
  }
  logout(token) {
    return this.db.pool.query('SELECT cam.end_session($1)', [tokenHash(token)]);
  }
  async changePassword(token, input) {
    const user = await this.principal(token),
      current = (await this.db.pool.query('SELECT * FROM cam.login_record($1)', [user.email]))
        .rows[0];
    if (!(await matches(input.currentPassword, current)))
      throw new HttpError('Current password is incorrect.', 400);
    const next = await hashPassword(input.newPassword);
    await this.db.session(tokenHash(token), async (client, principal) => {
      if (principal.authVersion !== current.auth_version)
        throw new HttpError('Your account changed. Sign in again.', 401, 'viewer-auth-required');
      await client.query(
        'UPDATE cam.users SET password_salt=$1,password_hash=$2,must_change_password=false WHERE id=$3',
        [next.salt, next.hash, user.id],
      );
      await client.query('SELECT cam.revoke_user($1)', [user.id]);
    });
    return this.login({ email: user.email, password: input.newPassword });
  }
}
