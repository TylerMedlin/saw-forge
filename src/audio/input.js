// Audio input: device access, routing into the engine, draining the capture
// ring while recording, and round-trip latency measurement.

import { ST } from '../shared/layout.js';
import { PeakTrace, findOnset } from './recording.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class InputManager extends EventTarget {
  constructor(engine) {
    super();
    this.engine = engine;
    this.stream = null; this.source = null;
    this.deviceId = ''; this.label = ''; this.settings = {};
    this.readPos = 0; this.collect = null; this.timer = 0; this.dropped = 0;
    this.chunks = []; // fallback (no shared memory) chunk queue
    engine.addEventListener('inchunk', (e) => this.chunks.push(e.detail));
  }

  get enabled() { return !!(this.stream || this.direct); }
  get channels() {
    const c = this.engine.inputChannels;
    return c > 0 ? c : (this.settings.channelCount || 0);
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async listDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Input ${i + 1}`) }));
    } catch { return []; }
  }

  // Ask for the device with all voice processing off: music needs the raw signal.
  async enable(deviceId = this.deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Audio input is not available in this browser.');
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: { ideal: 0 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (err) {
      if (err && err.name === 'OverconstrainedError' && deviceId) { delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      else throw err;
    }
    this.deviceId = deviceId || '';
    this.useStream(stream);
  }

  // Also used by tests to inject a synthetic MediaStream.
  useStream(stream, label) {
    this.release(false);
    this.stream = stream;
    const tr = stream.getAudioTracks()[0];
    this.settings = tr && tr.getSettings ? tr.getSettings() : {};
    this.label = label || (tr && tr.label) || 'Audio input';
    if (tr) tr.addEventListener('ended', () => { if (this.stream === stream) { this.release(false); this.emit('ended'); } });
    this.connect();
    this.emit('change');
  }

  // Test hook: feed an AudioNode from the engine's own context straight into the input
  // (fixed, zero-latency path; no device or permission involved).
  useNode(node, label = 'Direct input') {
    this.release(false);
    this.direct = node; this.label = label; this.settings = { channelCount: 2 };
    node.connect(this.engine.node);
    this.source = node;
    this.engine.post({ type: 'input', on: true });
    this.readPos = this.engine.inputWritePos();
    this.emit('change');
  }

  connect() {
    const e = this.engine;
    if (!e.ctx || !e.node || !this.stream) return;
    try {
      this.source = e.ctx.createMediaStreamSource(this.stream);
      this.source.connect(e.node);
      e.post({ type: 'input', on: true });
      this.readPos = e.inputWritePos();
      this.chunks.length = 0;
    } catch (err) { this.emit('error', 'Could not connect the audio input: ' + (err.message || err)); }
  }
  // After the engine restarts (new AudioContext) the source node must be recreated.
  reattach() { this.source = null; this.direct = null; if (this.stream) this.connect(); }

  release(notify = true) {
    if (this.source) { try { this.source.disconnect(this.engine.node); } catch { /* ignore */ } }
    this.source = null; this.direct = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.engine.node) this.engine.post({ type: 'input', on: false });
    if (notify) this.emit('change');
  }
  disable() { this.release(true); }

  // Latency of the input path reported by the browser, if any (seconds).
  inputLatency() {
    const l = this.settings && this.settings.latency;
    return typeof l === 'number' && l > 0 && l < 1 ? l : 0;
  }
  // Round trip a performer experiences: what they hear leaves late, what they play arrives late.
  estimateRoundTrip() {
    const c = this.engine.ctx;
    return c ? (c.baseLatency || 0) + (c.outputLatency || 0) + this.inputLatency() : 0;
  }

  // ------------------------------------------------------------ capture
  beginCollect() {
    this.drainRing(false);
    this.collect = { start: this.readPos >>> 0, L: [], R: [], frames: 0, trace: new PeakTrace(512) };
    if (!this.timer) this.timer = setInterval(() => this.drain(), 40);
    return this.collect;
  }
  endCollect() {
    this.drain();
    const c = this.collect;
    this.collect = null;
    clearInterval(this.timer); this.timer = 0;
    return c;
  }
  append(L, R) {
    const c = this.collect;
    if (!c) return;
    c.L.push(L); c.R.push(R); c.frames += L.length;
    c.trace.push(L, R);
  }
  drain() { this.drainRing(true); }

  drainRing(keep) {
    const e = this.engine;
    if (e.inRing) {
      const w = Atomics.load(e.inCtl, 0) >>> 0;
      let avail = (w - this.readPos) >>> 0;
      const cap = e.inCap, safe = cap - 4096;
      if (avail > safe) {
        // the UI thread fell behind (e.g. a stalled tab): keep timing by padding the lost part with silence
        const lost = avail - safe;
        if (keep && this.collect) { this.dropped += lost; this.append(new Float32Array(lost), new Float32Array(lost)); }
        this.readPos = (this.readPos + lost) >>> 0;
        avail = safe;
      }
      if (!avail) return;
      if (keep && this.collect) {
        const L = new Float32Array(avail), R = new Float32Array(avail);
        const ring = e.inRing, mask = cap - 1, s = this.readPos & mask, first = Math.min(avail, cap - s);
        L.set(ring.subarray(s, s + first)); R.set(ring.subarray(cap + s, cap + s + first));
        if (first < avail) { L.set(ring.subarray(0, avail - first), first); R.set(ring.subarray(cap, cap + avail - first), first); }
        this.append(L, R);
      }
      this.readPos = w;
    } else {
      // message fallback: chunks arrive in order with their ring positions
      for (const ch of this.chunks) {
        const end = (ch.start + ch.L.length) >>> 0;
        if (keep && this.collect) {
          const skip = (this.readPos - ch.start) | 0;
          if (skip > 0 && skip < ch.L.length) this.append(ch.L.subarray(skip), ch.R.subarray(skip));
          else if (skip <= 0) this.append(ch.L, ch.R);
        }
        this.readPos = end;
      }
      this.chunks.length = 0;
    }
  }

  // ------------------------------------------------------------ latency measurement
  // Plays a few clicks through the output and finds them in the input. Needs
  // the output to reach the input (speakers into a mic, or a loopback cable).
  // `extraOut` lets tests route the clicks straight into a synthetic input.
  async measureLatency({ clicks = 4, extraOut = null } = {}) {
    const e = this.engine, ctx = e.ctx;
    if (!ctx || !this.enabled) throw new Error('Enable an audio input first.');
    if (this.collect) throw new Error('Stop recording before measuring latency.');
    const sr = ctx.sampleRate;
    this.beginCollect();
    await sleep(250);
    const len = Math.round(sr * 0.004);
    const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * 2500 * i) / sr) * (1 - i / len) * 0.9;
    const t0 = ctx.currentTime + 0.25, gap = 0.4, times = [];
    for (let k = 0; k < clicks; k++) {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination);
      if (extraOut) src.connect(extraOut);
      const t = t0 + k * gap; src.start(t); times.push(t);
    }
    await sleep((0.25 + clicks * gap + 0.5) * 1000);
    const c = this.endCollect();
    // engine frame -> ring position, from the last captured block
    const st = e.status, bf = st[ST.IN_BLOCK_FRAME], bp = st[ST.IN_BLOCK_POS];
    const toRel = (frame) => ((Math.round(frame - bf) + bp - c.start) | 0);
    const L = concat(c.L), R = concat(c.R);
    const x = new Float32Array(L.length);
    for (let i = 0; i < x.length; i++) x[i] = Math.abs(L[i]) > Math.abs(R[i]) ? L[i] : R[i];
    const firstRel = toRel(times[0] * sr);
    let ns = 0, nn = 0;
    for (let i = Math.max(0, firstRel - Math.round(sr * 0.2)); i < firstRel && i < x.length; i++) { ns += x[i] * x[i]; nn++; }
    const noise = Math.sqrt(ns / Math.max(1, nn));
    const lat = [];
    for (const t of times) {
      const rel = toRel(t * sr);
      if (rel < 0 || rel >= x.length) continue;
      const on = findOnset(x, rel, Math.min(x.length, rel + Math.round(sr * 0.35)), noise);
      if (on >= 0) lat.push(on - rel);
    }
    if (!lat.length) return { ok: false, detected: 0, clicks };
    lat.sort((a, b) => a - b);
    const med = lat[lat.length >> 1];
    const spread = lat[lat.length - 1] - lat[0];
    return { ok: true, frames: med, ms: (med / sr) * 1000, detected: lat.length, clicks, spreadMs: (spread / sr) * 1000 };
  }
}

function concat(list) {
  let n = 0; for (const a of list) n += a.length;
  const out = new Float32Array(n);
  let o = 0; for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}
