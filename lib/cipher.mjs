import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { protectWindows } from '../vendor/windows-sdk/lib/vault.mjs';
export class ProviderCipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
      throw new Error('A 32-byte provider encryption key is required.');
    this.key = key;
  }
  static async open(directory, db) {
    if (process.env.HIK_SAAS_MASTER_KEY)
      return new ProviderCipher(Buffer.from(process.env.HIK_SAAS_MASTER_KEY, 'base64'));
    if (process.platform !== 'win32')
      throw new Error('Configure HIK_SAAS_MASTER_KEY for this operating system.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'provider-key.dpapi');
    let key;
    try {
      key = await protectWindows(await readFile(file), 'unprotect');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await db.pool.query('SELECT cam.has_provider() AS found')).rows[0].found)
        throw new Error('Restore the existing provider encryption key before starting.');
      key = randomBytes(32);
      await writeFile(file, await protectWindows(key, 'protect'), { flag: 'wx', mode: 0o600 });
    }
    return new ProviderCipher(key);
  }
  seal(value, tenantId) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(tenantId));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(value))),
      cipher.final(),
    ]);
    return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
  }
  open(value, tenantId) {
    const bytes = Buffer.from(value);
    if (bytes.length < 29) throw new Error('Encrypted provider data is invalid.');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(tenantId));
    decipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'),
    );
  }
}
