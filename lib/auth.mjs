import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as derive,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './database.mjs';
const scrypt = promisify(derive);
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
