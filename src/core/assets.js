// Audio assets: original file bytes (kept for saving), decoded audio, and
// waveform peaks for drawing. Missing or undecodable files stay listed as
// offline so their clips survive and can be relinked later.

import { encodeWav } from '../audio/wav.js';

const PEAK_BLOCK = 256;

export class AssetManager extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.items = new Map();
  }

  get(id) { return this.items.get(id) || null; }
  bytesMap() { const m = new Map(); for (const [id, a] of this.items) if (a.bytes) m.set(id, a.bytes); return m; }

  decodeContext() {
    if (this.engine.ctx) return this.engine.ctx;
    if (!this._tmpCtx) this._tmpCtx = new OfflineAudioContext(1, 1, 48000);
    return this._tmpCtx;
  }

  async add({ id, name, bytes, factory = false }) {
    const item = { id, name, bytes, buffer: null, peaks: null, duration: 0, sampleRate: 0, channels: 0, missing: false, factory };
    this.items.set(id, item);
    try {
      item.buffer = await this.decodeContext().decodeAudioData(bytes.slice(0));
      item.duration = item.buffer.duration; item.sampleRate = item.buffer.sampleRate; item.channels = item.buffer.numberOfChannels;
      item.peaks = computePeaks(item.buffer);
      if (this.engine.ctx) await this.engine.sendAsset(id, item.buffer);
    } catch (err) {
      item.missing = true;
      item.error = String(err && err.message || err);
    }
    this.dispatchEvent(new CustomEvent('change', { detail: id }));
    return item;
  }

  // A recorded take: keep the float audio for playback and 24-bit WAV bytes for saving.
  async addPcm({ id, name, channels, sampleRate }) {
    const bytes = encodeWav(channels, sampleRate, 24);
    const buffer = new AudioBuffer({ length: channels[0].length, numberOfChannels: channels.length, sampleRate });
    channels.forEach((d, c) => buffer.copyToChannel(d, c));
    const item = { id, name, bytes, buffer, peaks: computePeaks(buffer), duration: buffer.duration, sampleRate, channels: channels.length, missing: false, recorded: true };
    this.items.set(id, item);
    if (this.engine.ctx) await this.engine.sendAsset(id, buffer);
    this.dispatchEvent(new CustomEvent('change', { detail: id }));
    return item;
  }

  addMissing(id, name) {
    this.items.set(id, { id, name, bytes: null, buffer: null, peaks: null, duration: 0, missing: true });
  }

  meta(id) {
    const a = this.items.get(id);
    return a ? { id: a.id, name: a.name, duration: a.duration, sampleRate: a.sampleRate, channels: a.channels } : null;
  }

  // After the engine (re)starts: re-decode at the device rate and resend.
  async resyncEngine() {
    for (const a of this.items.values()) {
      if (!a.bytes) continue;
      try {
        if (!a.buffer || a.buffer.sampleRate !== this.engine.sampleRate) {
          a.buffer = await this.engine.ctx.decodeAudioData(a.bytes.slice(0));
          a.peaks = computePeaks(a.buffer);
          a.sampleRate = a.buffer.sampleRate;
          a.missing = false;
        }
        await this.engine.sendAsset(a.id, a.buffer);
      } catch { a.missing = true; }
    }
  }

  clear() { this.items.clear(); }
}

export function computePeaks(buffer) {
  const n = buffer.length, nb = Math.ceil(n / PEAK_BLOCK);
  const min = new Float32Array(nb), max = new Float32Array(nb);
  const chans = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) chans.push(buffer.getChannelData(c));
  for (let b = 0; b < nb; b++) {
    let lo = 1, hi = -1;
    const end = Math.min(n, (b + 1) * PEAK_BLOCK);
    for (let i = b * PEAK_BLOCK; i < end; i++) {
      let x = 0;
      for (const ch of chans) x += ch[i];
      x /= chans.length;
      if (x < lo) lo = x; if (x > hi) hi = x;
    }
    min[b] = lo; max[b] = hi;
  }
  return { min, max, block: PEAK_BLOCK, sampleRate: buffer.sampleRate };
}
