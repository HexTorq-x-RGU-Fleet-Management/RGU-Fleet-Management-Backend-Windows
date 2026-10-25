import { providerConnectionId, providerIdentity } from './provider-state.mjs';
import { randomBytes, createHash, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(derive);
export class AccountError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}
export const sessionHash = token => createHash('sha256').update(token).digest('hex');
const sessionAge = 30 * 24 * 3600000;
function passwordValid(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128)
    throw new AccountError('Choose a viewer password between 12 and 128 characters.');
}
async function passwordHash(password, salt) {
  return (await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })).toString('hex');
}
export class Accounts {
  constructor(vault, state) { this.vault = vault; this.state = state; this.queue = Promise.resolve(); }
  static async open(vault) {
    await vault.open();
    const state = await vault.load() || { version: 1, owner: null, sessions: [], provider: null };
    if (state.version !== 1 || !Array.isArray(state.sessions)) throw new AccountError('The account store has an unsupported format.', 503);
    return new Accounts(vault, state);
  }
  transact(change) {
    const work = this.queue.then(async () => {
      const next = structuredClone(this.state), result = await change(next);
      await this.vault.save(next); this.state = next; return result;
    });
    this.queue = work.catch(() => {}); return work;
  }
  get setupRequired() { return !this.state.owner; }
  authorize(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = sessionHash(token), now = Date.now();
    return this.state.sessions.find(session => session.hash === hash && session.expires > now) || null;
  }
  async setup(username, password) {
    if (typeof username !== 'string' || !/^[A-Za-z0-9@._-]{3,80}$/.test(username)) throw new AccountError('Use 3–80 letters, numbers, @, dots, underscores or hyphens for the viewer username.');
    passwordValid(password);
    const salt = randomBytes(16).toString('hex'), hash = await passwordHash(password, salt);
    return this.transact(state => {
      if (state.owner) throw new AccountError('This viewer already has an owner. Sign in.', 409);
      state.owner = { username, salt, hash }; return this.issue(state);
    });
  }
  issue(state) {
    const token = randomBytes(32).toString('hex'), now = Date.now();
    state.sessions = state.sessions.filter(session => session.expires > now).slice(-19);
    state.sessions.push({ hash: sessionHash(token), expires: now + sessionAge });
    return token;
  }
  async login(username, password) {
    if (typeof password !== 'string' || password.length > 128) throw new AccountError('Username or password is incorrect.', 401);
    const owner = this.state.owner;
    const hash = await passwordHash(password, owner?.salt || '00000000000000000000000000000000');
    if (!owner || username !== owner.username || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(owner.hash, 'hex')))
      throw new AccountError('Username or password is incorrect.', 401);
    return this.transact(state => {
      if (state.owner.hash !== owner.hash) throw new AccountError('Credentials changed. Sign in again.', 401);
      return this.issue(state);
    });
  }
  async logout(token) { const hash = sessionHash(token); return this.transact(state => { state.sessions = state.sessions.filter(session => session.hash !== hash); }); }
  async changePassword(token, oldPassword, newPassword) {
    if (!this.authorize(token)) throw new AccountError('Sign in to the viewer first.', 401);
    passwordValid(newPassword);
    const owner = this.state.owner;
    if (typeof oldPassword !== 'string' || oldPassword.length > 128 ||
      await passwordHash(oldPassword, owner.salt) !== owner.hash) throw new AccountError('Current password is incorrect.', 401);
    const salt = randomBytes(16).toString('hex'), hash = await passwordHash(newPassword, salt);
    return this.transact(state => {
      if (!this.authorize(token) || state.owner.hash !== owner.hash) throw new AccountError('Sign in again before changing the password.', 401);
      state.owner = { username: owner.username, salt, hash }; state.sessions = [];
      return this.issue(state);
    });
  }
  provider() { return structuredClone(this.state.provider); }
  saveProvider(provider) { return this.transact(state => { state.provider = structuredClone(provider); }); }
  switchProvider(provider) {
    return this.transact(state => {
      const before = providerIdentity(state.provider), after = providerIdentity(provider);
      const owner = state.preferencesOwner || before;
      const saved = new Map(Object.entries(state.providerPreferences || {}));
      if (owner) { saved.delete(owner); saved.set(owner, structuredClone(state.preferences || {})); }
      if (!after || after !== owner) state.preferences = after ? structuredClone(saved.get(after) || {}) : {};
      state.preferencesOwner = after;
      state.providerPreferences = Object.fromEntries([...saved].slice(-20));
      state.provider = structuredClone(provider);
    });
  }
  updateProvider(expected, change) {
    return this.transact(state => {
      if (providerConnectionId(state.provider) !== expected) throw new AccountError('The camera account changed. Refresh and try again.', 409, 'account-changed');
      state.provider = change(structuredClone(state.provider)); return structuredClone(state.provider);
    });
  }
  preferences() { return structuredClone(this.state.preferences || {}); }
  savePreferences(preferences, connectionId) { return this.transact(state => { if (connectionId && (providerConnectionId(state.provider) || 'none') !== connectionId) throw new AccountError('The camera account changed. Refresh and try again.', 409, 'account-changed'); state.preferences = structuredClone(preferences); state.preferencesOwner = providerIdentity(state.provider); }); }
}
