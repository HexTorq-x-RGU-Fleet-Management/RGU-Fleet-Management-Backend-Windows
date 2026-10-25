import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class VaultError extends Error {}

export function protectWindows(bytes, mode) {
  if (process.platform !== 'win32') return Promise.reject(new VaultError('This build requires Windows credential protection.'));
  const operation = mode === 'protect' ? 'Protect' : mode === 'unprotect' ? 'Unprotect' : null;
  if (!operation) return Promise.reject(new VaultError('Invalid credential protection operation.'));
  // Only fixed code is passed as an argument. Key material travels over pipes.
  const script = `Add-Type -AssemblyName System.Security; $ErrorActionPreference='Stop'; ` +
    `$inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); ` +
    `$outputBytes=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new VaultError('Windows credential protection timed out.')); }, 15000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 32768) { child.kill(); finish(new VaultError('Windows credential protection failed.')); } });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => finish(new VaultError('Windows credential protection could not start.')));
    child.on('close', code => {
      if (code !== 0 || !/^[A-Za-z0-9+/=]+$/.test(output.trim())) return finish(new VaultError('Windows could not protect or unlock this account store. Use the Windows account that created it.'));
      finish(null, Buffer.from(output.trim(), 'base64'));
    });
    child.stdin.end(bytes.toString('base64'));
  });
}

export class Vault {
  constructor(directory, { protect = protectWindows } = {}) { this.directory = path.resolve(directory); this.protect = protect; }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = path.join(this.directory, 'key.dpapi');
    let sealed;
    try { sealed = await readFile(keyPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new VaultError('Cannot read the protected account key.');
      // Never replace a missing key for an existing vault.
      try { await readFile(path.join(this.directory, 'accounts.vault')); throw new VaultError('The account-store key is missing. Restore the key and vault together.'); }
      catch (check) { if (check.code !== 'ENOENT') throw check; }
      sealed = await this.protect(randomBytes(32), 'protect');
      try { await writeFile(keyPath, sealed, { flag: 'wx', mode: 0o600 }); }
      catch (write) { if (write.code !== 'EEXIST') throw new VaultError('Cannot save the protected account key.'); sealed = await readFile(keyPath); }
    }
    this.key = await this.protect(sealed, 'unprotect');
    if (this.key.length !== 32) throw new VaultError('The account-store key is invalid.');
    return this;
  }
  async load() {
    let bytes;
    try { bytes = await readFile(path.join(this.directory, 'accounts.vault')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new VaultError('Cannot read the encrypted account store.'); }
    try {
      if (bytes.length > 2_000_000) throw new Error();
      const envelope = JSON.parse(bytes);
      if (envelope.version !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.nonce, 'base64'));
      decipher.setAAD(Buffer.from('hikvision-windows-v2:accounts:1'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]));
    } catch { throw new VaultError('The encrypted account store could not be verified. It was not reset or overwritten.'); }
  }
  async save(state) {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from('hikvision-windows-v2:accounts:1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const temporary = path.join(this.directory, `accounts.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, envelope, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path.join(this.directory, 'accounts.vault'));
    } catch { await unlink(temporary).catch(() => {}); throw new VaultError('Could not save account changes. Check storage permissions and free space.'); }
  }
}
