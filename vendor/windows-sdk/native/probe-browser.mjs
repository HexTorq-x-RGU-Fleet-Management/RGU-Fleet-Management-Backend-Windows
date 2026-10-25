import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBrowserSession } from '../lib/browser-session.mjs';

try {
  const credentials = await readBrowserSession();
  if (credentials.origin !== 'https://iindia.hik-connect.com') throw new Error('Unsupported region');
  const serial = process.argv[2];
  if (!serial || !/^[A-Za-z0-9-]{1,64}$/.test(serial)) throw new Error('Supply the permitted device serial');
  const child = spawn('python', [fileURLToPath(new URL('./probe.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const timer = setTimeout(() => { child.kill(); console.log(JSON.stringify({ stage: 'probe-timeout' })); }, 40000);
  let output = '';
  child.stdout.on('data', chunk => {
    output += chunk.toString();
    const lines = output.split('\n'); output = lines.pop();
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        // Native libraries also write to stdout; only our structured probe
        // events may reach the console. Native diagnostics are discarded.
        if (typeof value.stage === 'string' && /^[a-z-]+$/.test(value.stage)) console.log(JSON.stringify(value));
      } catch {}
    }
  });
  // Native loader failures may include unsafe paths or request material.
  child.stderr.resume();
  child.on('error', () => { clearTimeout(timer); console.log(JSON.stringify({ stage: 'python-unavailable' })); process.exitCode = 1; });
  child.on('close', code => { clearTimeout(timer); if (code) process.exitCode = 1; });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ accessToken: credentials.sdkAccessToken || credentials.sessionId, serial, play: process.argv.includes('--play'), decode: process.argv.includes('--decode'), streamType: process.argv.includes('--hd') ? 1 : 2 }) + '\n');
} catch {
  console.log(JSON.stringify({ stage: 'browser-session-unavailable', detail: 'Open the signed-in India Hik-Connect portal and check the Chrome approval prompt.' }));
  process.exitCode = 1;
}
