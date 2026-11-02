import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Search a DVR range through the same isolated SDK receiver used for live playback. */
export function searchRecordings(credentials, device, channel, startTime, stopTime, { runner = spawn, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = runner(process.env.HIK_PYTHON || 'python', [fileURLToPath(new URL('../native/probe.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const recordings = []; let buffer = ''; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); try { child.stdin.end(); } catch {} if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(new Error('The recorder did not finish its recording search.')); }, timeout);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) { let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.stage === 'record-file') recordings.push({ startTime: event.startTime || event.beginTime || startTime, stopTime: event.endTime || stopTime, fileName: event.fileName || null, size: Number.isFinite(event.size) ? event.size : null, recordType: event.recordType || null });
        if (event.stage === 'record-search-end') finish(null, recordings);
        if (event.stage === 'start-search' && event.result !== 0) finish(new Error('The recorder rejected the recording search.'));
      }
    });
    child.on('error', error => finish(error));
    child.on('close', code => { if (!settled) finish(code === 0 ? null : new Error('The recording search receiver stopped.')); });
    child.stdin.write(JSON.stringify({ accessToken: credentials.sdkAccessToken || credentials.sessionId, serial: device.serial, channel, startTime, stopTime, search: true }) + '\n');
  });
}
