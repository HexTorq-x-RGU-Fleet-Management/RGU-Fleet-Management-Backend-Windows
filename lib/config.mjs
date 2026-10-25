import path from 'node:path';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { protectWindows } from '../vendor/windows-sdk/lib/vault.mjs';
export const project = fileURLToPath(new URL('../', import.meta.url));
export const privateDirectory = path.join(project, '.local');
export async function savePrivate(name, value) {
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(privateDirectory, name + '.dpapi'),
    temporary = target + '.' + randomUUID();
  const bytes = await protectWindows(Buffer.from(JSON.stringify(value)), 'protect');
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
}
export async function readPrivate(name) {
  const bytes = await readFile(path.join(privateDirectory, name + '.dpapi'));
  return JSON.parse((await protectWindows(bytes, 'unprotect')).toString('utf8'));
}
export async function runtimeConfig() {
  if (process.env.DATABASE_URL)
    return {
      databaseUrl: process.env.DATABASE_URL,
      dataDirectory: process.env.HIK_SAAS_DATA_DIR || path.join(project, 'data'),
      port: Number(process.env.PORT || 8101),
    };
  const value = await readPrivate('runtime');
  return {
    ...value,
    ...(process.env.PORT ? { port: Number(process.env.PORT) } : {}),
    ...(process.env.HIK_SAAS_DATA_DIR ? { dataDirectory: process.env.HIK_SAAS_DATA_DIR } : {}),
  };
}
