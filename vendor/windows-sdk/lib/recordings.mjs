import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, open, readdir, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const MB = 1024 ** 2, GB = 1024 ** 3, DAY = 86400000;
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export class RecordingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export class RecordingStore {
  constructor(directory, { now = Date.now, maxBytes = 5 * GB, reserveBytes = 256 * MB } = {}) {
    this.directory = path.resolve(directory); this.now = now; this.reserveBytes = reserveBytes;
    this.index = { version: 1, settings: { retentionDays: 7, maxBytes }, clips: [] };
    this.queue = Promise.resolve(); this.lastCleanupAt = null;
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(path.join(this.directory, 'index.json'), 'utf8');
      if (text.length > 16 * MB) throw new Error();
      const value = JSON.parse(text);
      if (value.version !== 1 || !Array.isArray(value.clips) || ![1, 7, 30, 90].includes(value.settings?.retentionDays) || !Number.isSafeInteger(value.settings?.maxBytes) || value.settings.maxBytes < 1) throw new Error();
      if (value.clips.some(clip => !validId(clip.id) || !['webm', 'mp4'].includes(clip.extension) || !Number.isSafeInteger(clip.size) || clip.size < 1 || !Number.isFinite(clip.createdAt))) throw new Error();
      if (new Set(value.clips.map(clip => clip.id)).size !== value.clips.length) throw new Error();
      this.index = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new RecordingError('Recording storage metadata could not be read. Existing files were preserved.', 503);
    }
    // Only this store's abandoned temporary files are removed, never directories.
    for (const name of await readdir(this.directory)) if (/^(?:upload|index)-[a-f0-9-]{36}\.part$/i.test(name)) await unlink(path.join(this.directory, name)).catch(() => {});
    await this.cleanup(); return this;
  }
  serial(work) { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result; }
  file(clip) {
    if (!validId(clip.id) || !['webm', 'mp4'].includes(clip.extension)) throw new RecordingError('Recording not found.', 404);
    return path.join(this.directory, `${clip.id}.${clip.extension}`);
  }
  async commit() {
    const temporary = path.join(this.directory, `index-${randomUUID()}.part`);
    try { await writeFile(temporary, JSON.stringify(this.index), { mode: 0o600, flag: 'wx' }); await rename(temporary, path.join(this.directory, 'index.json')); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async freeDiskBytes() { try { const disk = await statfs(this.directory); return Number(disk.bavail) * Number(disk.bsize); } catch { return null; } }
  publicClip(clip) {
    return { id: clip.id, cameraName: clip.cameraName, recorderName: clip.recorderName, createdAt: clip.createdAt, size: clip.size,
      duration: clip.duration, audio: clip.audio, name: clip.name, expiresAt: clip.createdAt + this.index.settings.retentionDays * DAY,
      url: `/api/recordings/${clip.id}/video`, downloadUrl: `/api/recordings/${clip.id}/video?download=1` };
  }
  async summary() {
    const usedBytes = this.index.clips.reduce((sum, clip) => sum + clip.size, 0);
    return { ...this.index.settings, usedBytes, clipCount: this.index.clips.length, availableBytes: Math.max(0, this.index.settings.maxBytes - usedBytes),
      freeDiskBytes: await this.freeDiskBytes(), lastCleanupAt: this.lastCleanupAt, cleanupIntervalSeconds: 60, maxClipBytes: 128 * MB };
  }
  async prune(extraBytes = 0) {
    const now = this.now(), deadline = now - this.index.settings.retentionDays * DAY;
    const ordered = [...this.index.clips].sort((a, b) => a.createdAt - b.createdAt), removed = [];
    let total = ordered.reduce((sum, clip) => sum + clip.size, 0);
    for (const clip of ordered) if (clip.createdAt <= deadline || total + extraBytes > this.index.settings.maxBytes) { removed.push(clip); total -= clip.size; }
    if (removed.length) {
      const old = this.index.clips; this.index.clips = old.filter(clip => !removed.includes(clip));
      try { await this.commit(); } catch (error) { this.index.clips = old; throw error; }
      for (const clip of removed) await unlink(this.file(clip)).catch(error => { if (error.code !== 'ENOENT') throw new RecordingError('A recording could not be removed from storage.', 503); });
    }
    this.lastCleanupAt = now; return removed.length;
  }
  cleanup() { return this.serial(() => this.prune()); }
  list() { return this.serial(async () => { await this.prune(); return { clips: this.index.clips.map(clip => this.publicClip(clip)), storage: await this.summary() }; }); }
  settings(input) {
    return this.serial(async () => {
      if (![1, 7, 30, 90].includes(input.retentionDays) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 256 * MB || input.maxBytes > 1024 * GB) throw new RecordingError('Choose a retention period and a storage limit from 0.25 to 1024 GB.');
      const old = this.index.settings; this.index.settings = { retentionDays: input.retentionDays, maxBytes: input.maxBytes };
      try { await this.commit(); } catch (error) { this.index.settings = old; throw error; }
      const removed = await this.prune(); return { storage: await this.summary(), removed };
    });
  }
  ingest(stream, { id = randomUUID(), type, metadata = {}, contentLength } = {}) {
    return this.serial(async () => {
      if (!validId(id)) throw new RecordingError('Invalid recording identifier.');
      const extension = type?.split(';')[0] === 'video/webm' ? 'webm' : type?.split(';')[0] === 'video/mp4' ? 'mp4' : null;
      if (!extension) throw new RecordingError('Only WebM or MP4 camera recordings are supported.', 415);
      const maximum = Math.min(128 * MB, this.index.settings.maxBytes);
      if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maximum)) throw new RecordingError('The recording exceeds the clip or storage limit.', 413);
      const label = value => typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f]/.test(value);
      if (!label(metadata.cameraName) || !label(metadata.recorderName) || !Number.isFinite(metadata.duration) || metadata.duration < 0 || metadata.duration > 16 * 60000 || typeof metadata.audio !== 'boolean') throw new RecordingError('Invalid recording details.');
      const duplicate = this.index.clips.find(clip => clip.id === id);
      const diskFree = await this.freeDiskBytes();
      if (!duplicate && diskFree !== null && diskFree - (contentLength || maximum) < this.reserveBytes) throw new RecordingError('The recording server is low on disk space. Download and remove clips or free disk space.', 507);
      const temporary = path.join(this.directory, `upload-${id}.part`);
      let file, size = 0, signature = Buffer.alloc(0), finalFile, committed = false;
      try {
        if (!duplicate) file = await open(temporary, 'wx', 0o600);
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > maximum) throw new RecordingError('The recording exceeds the clip or storage limit.', 413);
          if (signature.length < 16) signature = Buffer.concat([signature, chunk.subarray(0, 16 - signature.length)]);
          if (file) await file.writeFile(chunk);
        }
        if (contentLength !== undefined && size !== contentLength) throw new RecordingError('The recording upload was interrupted. Retry saving the clip.');
        if (duplicate) return { clip: this.publicClip(duplicate), storage: await this.summary(), removed: 0 };
        if (size < 12 || (extension === 'webm' ? signature.readUInt32BE(0) !== 0x1a45dfa3 : signature.toString('ascii', 4, 8) !== 'ftyp')) throw new RecordingError('This upload is not a supported video recording.');
        await file.sync(); await file.close(); file = null;
        const createdAt = this.now(), safeName = metadata.cameraName.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 70) || 'camera';
        const clip = { id, extension, size, createdAt, duration: Math.round(metadata.duration), audio: metadata.audio, cameraName: metadata.cameraName, recorderName: metadata.recorderName,
          name: `camera-${safeName}-${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}.${extension}` };
        const removed = await this.prune(size); finalFile = this.file(clip); await rename(temporary, finalFile);
        this.index.clips.push(clip);
        try { await this.commit(); committed = true; } catch (error) { this.index.clips.pop(); throw error; }
        return { clip: this.publicClip(clip), storage: await this.summary(), removed };
      } catch (error) {
        if (error instanceof RecordingError) throw error;
        throw new RecordingError('The recording could not be saved. Keep this tab open and retry, or download the clip.', 503);
      } finally {
        await file?.close().catch(() => {}); await unlink(temporary).catch(() => {});
        if (finalFile && !committed) await unlink(finalFile).catch(() => {});
      }
    });
  }
  remove(id) {
    return this.serial(async () => {
      const clip = this.index.clips.find(clip => clip.id === id);
      if (!clip) throw new RecordingError('Recording not found.', 404);
      const old = this.index.clips; this.index.clips = old.filter(item => item !== clip);
      try { await this.commit(); } catch (error) { this.index.clips = old; throw error; }
      await unlink(this.file(clip)).catch(error => { if (error.code !== 'ENOENT') throw new RecordingError('The recording could not be deleted from disk.', 503); });
      return { storage: await this.summary() };
    });
  }
  async serve(req, res, id, download = false) {
    await this.cleanup(); const clip = this.index.clips.find(clip => clip.id === id);
    if (!clip) throw new RecordingError('This recording was deleted or its retention period has expired.', 404);
    const headers = { 'Content-Type': `video/${clip.extension}`, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="recording.${clip.extension}"; filename*=UTF-8''${encodeURIComponent(clip.name)}` };
    let start = 0, end = clip.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, clip.size - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), clip.size - 1) : clip.size - 1;
      } else start = -1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= clip.size || end < start) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${clip.size}` }); res.end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${clip.size}`;
    }
    let file; try { file = await open(this.file(clip), 'r'); } catch { throw new RecordingError('The recording file is no longer available.', 404); }
    headers['Content-Length'] = end - start + 1; res.writeHead(status, headers);
    if (req.method === 'HEAD') { await file.close(); res.end(); return; }
    const stream = createReadStream(this.file(clip), { fd: file.fd, autoClose: false, start, end });
    const close = () => { stream.destroy(); void file.close().catch(() => {}); };
    stream.on('error', () => { res.destroy(); close(); }); stream.on('end', close); res.on('close', close); stream.pipe(res);
  }
}
