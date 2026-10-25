import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class LiveError extends Error { constructor(message, status = 502, code) { super(message); this.status = status; this.code = code; } }

export class NativeLive extends EventEmitter {
  constructor(credentials, device, channel, quality, { runner = spawn, delivery = 'mjpeg', previewOnly = false } = {}) {
    super();
    this.deviceId = device.id; this.deviceName = device.name; this.channel = channel; this.quality = quality;
    this.delivery = delivery;
    this.state = 'connecting'; this.clients = new Set(); this.lastFrame = null; this.lastFrameAt = 0;
    this.audioClients = new Set(); this.audioState = 'unknown'; this.lastAudioAt = 0; this.audioSamples = 0;
    this.frameObservers = new Set(); this.audioObservers = new Set(); this.talkSupported = false; this.talkState = 'stopped'; this.talkWanted = false;
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.ready.catch(() => {});
    const child = this.child = runner(process.env.HIK_PYTHON || 'python', [fileURLToPath(new URL('../native/probe.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 8_000_000) return this.fail('The video receiver exceeded its output limit.');
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.stage === 'preview' && !['failed', 'stopped'].includes(this.state)) {
          const bytes = typeof event.jpeg === 'string' && event.jpeg.length <= 400000 ? Buffer.from(event.jpeg, 'base64') : null;
          if (bytes?.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && Number.isInteger(event.width) && Number.isInteger(event.height) && event.width > 0 && event.width <= 640 && event.height > 0 && event.height <= 360) {
            this.lastPreview = { jpeg: bytes.toString('base64'), width: event.width, height: event.height, capturedAt: Date.now() };
            this.emit('preview', this.lastPreview);
          }
        }
        if (event.stage === 'camera-capabilities') this.talkSupported = event.supportTalk === true;
        if (event.stage === 'talk-result') {
          if (event.action === 'stop') {
            clearTimeout(this.talkStopTimer);
            if (event.result !== 0) { this.child.kill(); this.fail('The microphone could not stop cleanly. The camera receiver was closed.'); continue; }
          }
          if (event.result !== 0) { this.talkState = 'error'; this.talkReject?.(new LiveError('The camera could not start PC microphone talk. Check its speaker and talk permissions.', 409)); }
          else if (event.action === 'stop') this.talkState = 'stopped';
        } else if (event.stage === 'playback-event' && [16, 17, 18].includes(event.event)) {
          if (event.event === 16 && !this.talkWanted) { this.child.stdin.write('{"command":"talk-stop"}\n'); continue; }
          this.talkState = event.event === 16 ? 'talking' : event.event === 17 ? 'stopped' : 'error';
          if (event.event === 17) clearTimeout(this.talkStopTimer);
          if (event.event === 16) this.talkResolve?.();
          if (event.event === 18) this.talkReject?.(new LiveError('Two-way audio was rejected by the camera.', 409));
        } else if (event.stage === 'audio-stream') {
          this.audioState = event.available ? 'waiting' : 'unavailable';
          this.audioCodec = typeof event.codec === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(event.codec) ? event.codec : null;
        } else if (event.stage === 'audio-error') {
          this.audioState = 'error';
          this.audioError = { phase: ['decode', 'resample'].includes(event.phase) ? event.phase : null,
            kind: typeof event.kind === 'string' && /^[a-zA-Z]{1,50}$/.test(event.kind) ? event.kind : null,
            code: Number.isInteger(event.code) ? event.code : null };
        } else if (event.stage === 'audio') {
          if (['stopped', 'failed'].includes(this.state)) continue;
          if (event.sampleRate !== 16000 || !Number.isInteger(event.samples) || event.samples < 1 || event.samples > 8000 || typeof event.pcm !== 'string' || event.pcm.length > 24000) continue;
          const pcm = Buffer.from(event.pcm, 'base64');
          if (pcm.length !== event.samples * 2) continue;
          this.audioState = 'available'; this.audioError = null; this.lastAudioAt = Date.now(); this.audioSamples += event.samples;
          this.audioDecoder = event.decoder === 'hik-g711' ? 'hik-g711' : 'pyav';
          for (const observer of this.audioObservers) observer({ pcm: event.pcm, sampleRate: 16000, samples: event.samples });
          const message = `data: ${JSON.stringify({ pcm: event.pcm, sampleRate: 16000, samples: event.samples })}\n\n`;
          for (const res of this.audioClients) {
            // Disconnect slow listeners instead of playing a growing backlog.
            if (res.destroyed) { this.audioClients.delete(res); continue; }
            if (res.writableLength > 64000) { res.end(); this.audioClients.delete(res); continue; }
            res.write(message);
          }
        } else if (event.stage === 'video-stats') {
          this.videoStats = Object.fromEntries(['decodedFps','outputFps','videoKBps'].filter(key => Number.isFinite(event[key]) && event[key] >= 0 && event[key] < 1000000).map(key => [key, event[key]]));
        } else if (event.stage === 'video') {
          if (['stopped', 'failed'].includes(this.state) || this.delivery !== 'smooth') continue;
          if (typeof event.h264 !== 'string' || event.h264.length > 6_000_000 || !Number.isFinite(event.timestamp) || event.timestamp < 0 || !Number.isInteger(event.width) || !Number.isInteger(event.height) || event.width < 1 || event.height < 1 || event.width > 8192 || event.height > 8192) continue;
          this.lastFrameAt = Date.now(); this.width = event.width; this.height = event.height; this.displayWidth = event.displayWidth || event.width;
          this.codec = 'H264'; this.state = 'playing'; this.resolve(this.status());
          for (const observer of this.frameObservers) observer({ h264: event.h264, key: event.key === true, timestamp: event.timestamp,
            width: this.width, height: this.height, displayWidth: this.displayWidth, codec: 'avc1.42C028', fps: this.videoStats?.outputFps });
        } else if (event.stage === 'frame') {
          if (['stopped', 'failed'].includes(this.state)) continue;
          if (typeof event.jpeg !== 'string' || event.jpeg.length > 6_000_000) continue;
          const jpeg = Buffer.from(event.jpeg, 'base64');
          if (jpeg.length < 4 || jpeg[0] !== 255 || jpeg[1] !== 216) continue;
          if (!Number.isInteger(event.width) || !Number.isInteger(event.height)) continue;
          this.lastFrame = jpeg; this.lastFrameAt = Date.now(); this.width = event.width; this.height = event.height;
          this.displayWidth = Number.isFinite(event.displayWidth) ? event.displayWidth : event.width;
          this.codec = event.codec === 'hevc' ? 'H265' : event.codec === 'h264' ? 'H264' : 'Video'; this.state = 'playing';
          this.resolve(this.status());
          for (const observer of this.frameObservers) observer({ jpeg: event.jpeg, width: event.width, height: event.height, displayWidth: this.displayWidth });
          for (const res of this.clients) this.sendFrame(res);
        } else if (event.stage === 'playback-event' && event.event === 0) this.fail('The camera rejected playback. Check the same channel in the official app.', 'playback-rejected');
        else if (event.stage === 'camera-capabilities' && event.encrypted) this.fail('This camera requires its video encryption code. Encrypted playback is not configured yet.', 'encrypted-stream');
        else if (event.stage === 'decode-timeout') this.fail('No usable video arrived before the receiver timeout. Try SD or check this channel in the official app.', 'stream-timeout');
        else if (['probe-failed', 'media-overflow', 'decoder-ended'].includes(event.stage)) this.fail('The video receiver could not decode this stream. Try SD or check this channel in the official app.', 'decode-failed');
        else if (['initialize', 'set-session', 'start-video', 'device-details'].includes(event.stage) && event.result !== 0) this.fail('The camera receiver could not start this channel. Check the channel in the official app and retry.', event.stage === 'initialize' ? 'receiver-unavailable' : 'sdk-start-failed');
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', () => this.fail('The video receiver could not start. Check its server installation.', 'receiver-unavailable'));
    child.on('close', () => { if (!['stopped', 'failed'].includes(this.state)) this.fail('The camera connection ended. Start the channel again.'); });
    child.stdin.write(JSON.stringify({ accessToken: credentials.sdkAccessToken || credentials.sessionId, serial: device.serial, channel,
      streamType: quality === 'hd' ? 1 : 2, play: true, decode: true, stream: true, delivery, previewOnly }) + '\n');
    this.deadline = setTimeout(() => this.fail('No decoded video arrived. Try SD or check the camera in the official app.', 'stream-timeout'), 40000);
    this.ready.then(() => { clearTimeout(this.deadline); if (this.state !== 'playing') return; this.idle = setTimeout(() => { if (!this.clients.size && !this.frameObservers.size && !this.audioObservers.size) this.stop(); }, 15000); }, () => {});
    this.watchdog = setInterval(() => { if (this.state === 'playing' && Date.now() - this.lastFrameAt > 12000) this.fail('Live video stopped arriving. Start the channel again.'); }, 3000);
    this.watchdog.unref();
  }
  preview({ maxAge = 300000, timeout = 15000 } = {}) {
    if (this.lastPreview && Date.now() - this.lastPreview.capturedAt < maxAge) return Promise.resolve(this.lastPreview);
    if (['failed', 'stopped'].includes(this.state)) return Promise.reject(new LiveError('Preview is unavailable.', 409));
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); this.off('preview', frame); this.off('ended', ended); };
      const frame = value => { clean(); resolve(value); };
      const ended = () => { clean(); reject(new LiveError('Preview connection ended.', 409)); };
      const timer = setTimeout(() => { clean(); reject(new LiveError('No preview frame arrived.', 504)); }, timeout);
      this.once('preview', frame); this.once('ended', ended);
      this.child.stdin.write(JSON.stringify({ command: 'preview' }) + '\n');
    });
  }
  status() {
    return { state: this.state, deviceId: this.deviceId, deviceName: this.deviceName, channel: this.channel, quality: this.quality,
      width: this.width || null, height: this.height || null, displayWidth: this.displayWidth || null, codec: this.codec || null,
      lastFrameAt: this.lastFrameAt || null, audio: this.audioState === 'available', audioState: this.audioState,
      lastAudioAt: this.lastAudioAt || null, audioSamples: this.audioSamples, talkSupported: this.talkSupported,
      audioCodec: this.audioCodec || null, audioError: this.audioError || null,
      audioDecoder: this.audioDecoder || null,
      talkState: this.talkState, delivery: this.delivery, videoStats: this.videoStats || null, error: this.error || null, errorCode: this.errorCode || null };
  }
  watchFrames(observer) {
    clearTimeout(this.idle); this.frameObservers.add(observer);
    if (this.lastFrame) observer({ jpeg: this.lastFrame.toString('base64'), width: this.width, height: this.height, displayWidth: this.displayWidth });
    return () => { this.frameObservers.delete(observer); if (!this.clients.size && !this.frameObservers.size && !this.audioObservers.size && this.state === 'playing') this.idle = setTimeout(() => this.stop(), 3000); };
  }
  async startTalk() {
    if (this.state !== 'playing' || !this.talkSupported) throw new LiveError('This channel has not reported two-way audio support.', 409);
    if (this.talkState === 'talking') return;
    this.talkState = 'connecting'; this.talkWanted = true;
    this.talkLimit = setTimeout(() => this.stopTalk(), 30000);
    const ready = new Promise((resolve, reject) => { this.talkResolve = resolve; this.talkReject = reject; });
    const timer = setTimeout(() => this.talkReject?.(new LiveError('The camera did not confirm two-way audio.', 409)), 10000);
    this.child.stdin.write(JSON.stringify({ command: 'talk-start' }) + '\n');
    this.keepTalkAlive();
    try { await ready; } catch (error) { this.stopTalk(); throw error; }
    finally { clearTimeout(timer); this.talkResolve = null; this.talkReject = null; }
  }
  keepTalkAlive() {
    if (!['connecting', 'talking'].includes(this.talkState)) return;
    this.child.stdin.write(JSON.stringify({ command: 'talk-heartbeat' }) + '\n');
    clearTimeout(this.talkLease); this.talkLease = setTimeout(() => this.stopTalk(), 1500);
  }
  stopTalk() {
    clearTimeout(this.talkLimit);
    clearTimeout(this.talkLease);
    const active = this.talkWanted || ['connecting', 'talking'].includes(this.talkState);
    this.talkWanted = false;
    if (active) {
      this.talkState = this.state === 'playing' ? 'stopping' : 'stopped';
      clearTimeout(this.talkStopTimer);
      if (this.state === 'playing') this.talkStopTimer = setTimeout(() => { this.child.kill(); this.fail('Microphone stop was not confirmed. The receiver was closed.'); }, 2000);
      this.child.stdin.write(JSON.stringify({ command: 'talk-stop' }) + '\n');
    }
    this.talkReject?.(new LiveError('Talking stopped.', 409));
  }
  watchAudio(observer) {
    clearTimeout(this.idle); this.audioObservers.add(observer);
    return () => { this.audioObservers.delete(observer); if (!this.clients.size && !this.frameObservers.size && !this.audioObservers.size && this.state === 'playing') this.idle = setTimeout(() => this.stop(), 3000); };
  }
  sendFrame(res) {
    if (!this.lastFrame || res.destroyed || res.writableLength > 2_000_000) return;
    const header = Buffer.from(`--hikframe\r\nContent-Type: image/jpeg\r\nContent-Length: ${this.lastFrame.length}\r\n\r\n`);
    res.write(Buffer.concat([header, this.lastFrame, Buffer.from('\r\n')]));
  }
  subscribe(res) {
    if (this.delivery === 'smooth') throw new LiveError('Smooth playback uses the viewer event stream. Select Compatibility for the JPEG endpoint.', 409);
    if (this.state !== 'playing') throw new LiveError(this.error || 'Start a camera first.', 409);
    clearTimeout(this.idle);
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=hikframe', 'Cache-Control': 'no-store, private', 'X-Accel-Buffering': 'no' });
    this.clients.add(res); this.sendFrame(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size && !this.frameObservers.size && !this.audioObservers.size && this.state === 'playing') this.idle = setTimeout(() => this.stop(), 3000);
    });
  }
  subscribeAudio(res) {
    if (this.state !== 'playing') throw new LiveError(this.error || 'Start a camera first.', 409);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, private', 'X-Accel-Buffering': 'no' });
    res.write(': audio connected\n\n');
    this.audioClients.add(res);
    res.on('close', () => this.audioClients.delete(res));
  }
  fail(message, code = 'stream-interrupted') {
    if (['failed', 'stopped'].includes(this.state)) return;
    this.error = message; this.errorCode = code; this.state = 'failed'; this.reject(new LiveError(message, 502, code)); this.cleanup();
  }
  stop() {
    if (this.state === 'stopped') return;
    this.state = 'stopped'; this.reject(new LiveError('Playback was stopped.', 409)); this.cleanup();
  }
  cleanup() {
    this.emit('ended');
    clearTimeout(this.talkLimit);
    clearTimeout(this.talkStopTimer);
    this.stopTalk(); this.frameObservers.clear(); this.audioObservers.clear();
    clearTimeout(this.deadline); clearTimeout(this.idle); clearInterval(this.watchdog);
    this.child.stdin.end();
    const kill = setTimeout(() => this.child.kill(), 5000); kill.unref();
    this.child.once('close', () => clearTimeout(kill));
    for (const res of this.clients) res.end();
    for (const res of this.audioClients) res.end();
    this.audioClients.clear(); this.audioState = 'unavailable';
    this.clients.clear(); this.lastFrame = null;
  }
}
