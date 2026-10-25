export function slotNumber(value = 0) {
  const number = typeof value === 'string' && /^\d{1,2}$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(number) || number < 0 || number > 31) throw new Error('Invalid camera stream slot.');
  return number;
}
export class Viewer {
  constructor() { this.slots = new Map(); this.events = new Set(); this.audioEvents = new Set(); this.legacyAudio = new Set(); this.audioSlots = new Set(); }
  slot(id = 0) {
    if (!this.slots.has(id)) this.slots.set(id, { id, live: null, starting: false, generation: 0 });
    return this.slots.get(id);
  }
  states() { return [...this.slots.values()].map(slot => ({ slot: slot.id, ...(slot.live?.status() || { state: slot.starting ? 'connecting' : 'stopped' }) })); }
  send(res, type, value) { if (!res.destroyed && !res.writableEnded && res.writableLength < 2_000_000) { try { res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); } catch { res.destroy(); } } }
  attach(slot) {
    const live = slot.live;
    if (this.events.size && !slot.unwatch && slot.live?.watchFrames) slot.unwatch = slot.live.watchFrames(frame => {
      this.onFrame?.(slot, live);
      for (const res of this.events) {
        if (frame.h264 && res.writableLength >= 2_000_000) { res.destroy(); continue; }
        this.send(res, 'frame', { slot: slot.id, deviceId: live.deviceId, channel: live.channel, quality: live.quality, ...frame });
      }
    });
    if ((this.legacyAudio.size || this.audioEvents.size) && this.audioSlots.has(slot.id) && !slot.unlisten && slot.live?.watchAudio) slot.unlisten = slot.live.watchAudio(packet => {
      for (const res of [...this.legacyAudio, ...this.audioEvents]) this.send(res, 'audio', { slot: slot.id, deviceId: live.deviceId, channel: live.channel, ...packet });
    });
  }
  focusAudio(ids) {
    this.audioSlots = new Set(ids);
    for (const slot of this.slots.values()) {
      if (!this.audioSlots.has(slot.id)) { slot.unlisten?.(); slot.unlisten = null; }
      this.attach(slot);
    }
  }
  releaseAudio() {
    if (!this.legacyAudio.size && !this.audioEvents.size) for (const slot of this.slots.values()) { slot.unlisten?.(); slot.unlisten = null; }
  }
  subscribeAudioEvents(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, private', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1000\n\n'); this.audioEvents.add(res);
    res.on('error', () => res.destroy());
    for (const slot of this.slots.values()) this.attach(slot);
    const timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n'); }, 15000); timer.unref();
    res.on('close', () => { clearInterval(timer); this.audioEvents.delete(res); this.releaseAudio(); });
  }
  subscribe(res, { separateAudio = false } = {}) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, private', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n'); this.events.add(res);
    if (!separateAudio) this.legacyAudio.add(res);
    res.on('error', () => res.destroy());
    this.send(res, 'states', this.states());
    for (const slot of this.slots.values()) this.attach(slot);
    const timer = setInterval(() => this.send(res, 'states', this.states()), 1000);
    timer.unref();
    res.on('close', () => {
      clearInterval(timer); this.events.delete(res);
      this.legacyAudio.delete(res);
      if (!this.events.size) for (const slot of this.slots.values()) { slot.unwatch?.(); slot.unwatch = null; }
      this.releaseAudio();
    });
  }
  stop(id) {
    const slot = this.slot(id); slot.generation++; slot.unwatch?.(); slot.unwatch = null;
    slot.unlisten?.(); slot.unlisten = null;
    slot.live?.stop(); slot.live = null;
  }
  stopAll() { for (const id of this.slots.keys()) this.stop(id); }
  close() { this.stopAll(); for (const res of [...this.events, ...this.audioEvents]) res.end(); this.events.clear(); this.audioEvents.clear(); this.legacyAudio.clear(); }
}
