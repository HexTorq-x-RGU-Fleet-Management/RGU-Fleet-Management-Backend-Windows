import { open } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class DesktopSdkError extends Error { constructor(message) { super(message); this.status = 409; } }

export function desktopTokenFromLog(text) {
  let region = null, candidate = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('COpenSDKUnited::GetLoginParams')) continue;
    const key = /\bKey\s*[:=]\s*(\d+)/.exec(line)?.[1];
    const value = /\bValue\s*[:=]\s*(.*)$/.exec(line)?.[1]?.trim();
    if (key === '3') {
      region = /https:\/\/iindiaopen\.ezvizlife\.com(?=[\s"']|$)/.test(value || '') ? 'india' : null;
    }
    if (key === '5' && region === 'india') {
      const token = /^at\.[A-Za-z0-9._-]{16,1024}(?=\s|$)/.exec(value || '')?.[0];
      if (token) candidate = token;
    }
  }
  return candidate;
}

export async function installedDesktopToken({ directory = process.env.HIK_SDK_DIRECTORY || 'C:\\Program Files (x86)\\iVMS-4200 Site\\iVMS-4200 Client\\Client' } = {}) {
  let file;
  try {
    file = await open(path.join(directory, 'log/opensdk/opensdk.log'), 'r');
    const size = (await file.stat()).size, length = Math.min(size, 8_000_000);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    const token = desktopTokenFromLog(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!token) throw new Error();
    return token;
  } catch { throw new DesktopSdkError('No usable India playback sign-in was found. Sign into Hik-Connect in iVMS on this Windows computer first.'); }
  finally { await file?.close(); }
}

export function validateSdkAccess(token, device, channel, { runner = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child, complete = false, buffer = '', total = 0, details = false;
    const finish = error => {
      if (complete) return; complete = true; clearTimeout(timeout);
      error ? reject(error) : resolve({ validatedAt: Date.now() });
    };
    const timeout = setTimeout(() => { child?.kill(); finish(new DesktopSdkError('Playback authorization verification timed out. Check the iVMS sign-in and try again.')); }, 30000);
    try { child = runner(process.env.HIK_PYTHON || 'python', [fileURLToPath(new URL('../native/probe.py', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { finish(new DesktopSdkError('The Windows SDK verifier could not start. Check Python and the installed SDK.')); return; }
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      buffer += chunk;
      total += chunk.length;
      if (total > 100000) { child.kill(); finish(new DesktopSdkError('The SDK verifier returned too much data.')); return; }
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.stage === 'device-details' && event.result === 0 && event.responseBytes > 0) details = true;
      }
    });
    child.on('error', () => finish(new DesktopSdkError('The Windows SDK verifier could not start.')));
    child.on('close', code => finish(code === 0 && details ? null : new DesktopSdkError('The installed iVMS playback credential did not authorize this shared channel. Sign into the matching Hik-Connect account in iVMS again.')));
    // Read-only device authorization. No playback, logout or account changes.
    child.stdin.end(JSON.stringify({ accessToken: token, serial: device.serial, channel, play: false }) + '\n');
  });
}
