import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['.git', '.local', 'node_modules', 'data', '__pycache__']);
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((e) => !ignored.has(e.name))
        .map((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)])),
    )
  ).flat();
}
let count = 0;
for (const file of await files(root)) {
  if (!file.endsWith('.mjs')) continue;
  const checked = spawnSync(process.execPath, ['--check', file], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (checked.status !== 0) throw Error(checked.stderr);
  const code = await readFile(file, 'utf8');
  for (const [, relative] of code.matchAll(
    /(?:from\s*|import\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g,
  )) {
    const target = path.resolve(path.dirname(file), relative);
    if (target !== root.replace(/[\\/]$/, '') && !target.startsWith(root))
      throw Error('Dependency escapes backend: ' + relative);
    await access(target);
  }
  count++;
}
console.log(`Checked ${count} JavaScript modules: syntax and local dependency paths pass.`);
