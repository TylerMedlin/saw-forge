// Main-thread side of the pedalboard audio graph:
//   guitar input (getUserMedia) ─► pre worklet (gate, pedals before amp, amp)
//     ─► cabinet (ConvolverNode, crossfaded with a bypass path) ─► post worklet
//     (pedals after amp, output stage) ─► speakers
// Nothing is audible until start() is called from a click, and monitoring
// never resumes by itself after a reload.

import { cabBuffer, loadUserIR } from './cab.js';
import { PEDALS } from '../shared/defs.js';

export const WORKLET_URL = new URL('./pedalboard-processor.js', import.meta.url).href;

export class PedalEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null; this.pre = null; this.post = null; this.stream = null; this.source = null;
    this.meters = { inPeak: 0, inClip: false, gate: 1, gr: {}, outL: 0, outR: 0, lim: 1, loadPre: null, loadPost: null, protect: false };
    this.userIR = null; this.cabKey = '';
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  get running() { return !!(this.ctx && this.ctx.state === 'running'); }

  async start({ outputDeviceId } = {}) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
      const ctx = this.ctx;
      const opt = (section) => ({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete', processorOptions: { section } });
      this.pre = new AudioWorkletNode(ctx, 'sf-pedalboard', opt('pre'));
      this.post = new AudioWorkletNode(ctx, 'sf-pedalboard', opt('post'));
      this.cab = new ConvolverNode(ctx, { disableNormalization: true, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
      this.cabWet = new GainNode(ctx, { gain: 1 }); this.cabDry = new GainNode(ctx, { gain: 0 });
      this.pre.connect(this.cab).connect(this.cabWet).connect(this.post);
      this.pre.connect(this.cabDry).connect(this.post);
      this.post.connect(ctx.destination);
      for (const [node, which] of [[this.pre, 'pre'], [this.post, 'post']]) node.port.onmessage = (e) => this.onWorklet(which, e.data);
      ctx.addEventListener('statechange', () => this.emit('state'));
    }
    if (outputDeviceId !== undefined) await this.setOutputDevice(outputDeviceId);
    await this.ctx.resume();
    this.emit('state');
  }

  async stop() { if (this.ctx) await this.ctx.suspend(); this.emit('state'); }

  onWorklet(which, m) {
    if (m.type === 'meter') {
      const M = this.meters;
      if (which === 'pre') { M.inPeak = m.inPeak; M.inClip = m.inClip; M.gate = m.gate; M.gr = m.gr; M.loadPre = m.load; }
      else { M.outL = m.outL; M.outR = m.outR; M.lim = m.lim; M.loadPost = m.load; M.protect = m.protect; }
      this.emit('meter', M);
    } else if (m.type === 'protect') this.emit('protect');
  }

  // ------------------------------------------------------------ devices
  async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return {
        inputs: all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Input ${i + 1}`) })),
        outputs: all.filter((d) => d.kind === 'audiooutput').map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'System default' : `Output ${i + 1}`) })),
      };
    } catch { return { inputs: [], outputs: [] }; }
  }

  // Raw instrument signal: every voice-call processing feature off.
  async openInput(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Audio input is not available in this browser.');
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, latency: { ideal: 0 } };
    if (deviceId) audio.deviceId = { exact: deviceId };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (err) {
      if (err && err.name === 'OverconstrainedError' && deviceId) { delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      else throw err;
    }
    this.closeInput();
    this.stream = stream;
    const tr = stream.getAudioTracks()[0];
    this.inputLabel = (tr && tr.label) || 'Audio input';
    this.inputSettings = tr && tr.getSettings ? tr.getSettings() : {};
    if (tr) tr.addEventListener('ended', () => { if (this.stream === stream) { this.closeInput(); this.emit('inputlost'); } });
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.pre);
    this.emit('input');
    return this.inputLabel;
  }
  closeInput() {
    if (this.source) { try { this.source.disconnect(); } catch {} this.source = null; }
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; }
  }

  async setOutputDevice(id) {
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return false;
    try { await this.ctx.setSinkId(id || ''); return true; } catch (err) { this.emit('error', `Couldn't switch output: ${err.message || err}`); return false; }
  }

  // Round trip the browser reports (output side + processing), in ms.
  latencyMs() {
    if (!this.ctx) return null;
    const base = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return Math.round(base * 1000 * 10) / 10;
  }

  // ------------------------------------------------------------ board
  // board.chain: pedals and the amp block in order; pedals left of the amp run before it.
  sendBoard(board) {
    if (!this.ctx) return;
    const ampAt = board.chain.findIndex((x) => x.type === 'amp');
    const pre = [], post = [];
    board.chain.forEach((x, i) => { if (x.type !== 'amp' && PEDALS[x.type]) (i < ampAt ? pre : post).push({ uid: x.uid, type: x.type, on: x.on, params: x.params }); });
    this.pre.port.postMessage({ type: 'chain', slots: pre });
    this.post.port.postMessage({ type: 'chain', slots: post });
    this.setTempo(board.bpm);
    this.sendAmp(board.amp);
  }
  sectionOf(board, uid) {
    const ampAt = board.chain.findIndex((x) => x.type === 'amp'), i = board.chain.findIndex((x) => x.uid === uid);
    return i < ampAt ? this.pre : this.post;
  }
  sendParams(board, pedal) { if (this.ctx) this.sectionOf(board, pedal.uid).port.postMessage({ type: 'param', uid: pedal.uid, params: pedal.params }); }
  sendOn(board, pedal) { if (this.ctx) this.sectionOf(board, pedal.uid).port.postMessage({ type: 'on', uid: pedal.uid, on: pedal.on }); }
  setTempo(bpm) { if (!this.ctx) return; for (const n of [this.pre, this.post]) n.port.postMessage({ type: 'tempo', bpm }); }

  sendAmp(amp) {
    if (!this.ctx) return;
    this.pre.port.postMessage({ type: 'amp', model: amp.model, params: amp.params, on: amp.on });
    // cabinet
    const t = this.ctx.currentTime, wet = amp.cabOn ? 1 : 0;
    this.cabWet.gain.setTargetAtTime(wet, t, 0.015); this.cabDry.gain.setTargetAtTime(1 - wet, t, 0.015);
    const key = amp.cab === 'user' ? `user:${this.userIRName}` : `${amp.cab}|${amp.cabB || ''}|${amp.mic}|${amp.dist}`;
    if (key !== this.cabKey) {
      this.cabKey = key;
      this.cab.buffer = amp.cab === 'user' && this.userIR ? this.userIR : cabBuffer(this.ctx, amp.cab === 'user' ? 'warm-studio' : amp.cab, amp.cabB, amp.mic / 100, amp.dist / 100);
    }
  }
  async importIR(file) {
    const buf = await loadUserIR(this.ctx, await file.arrayBuffer());
    this.userIR = buf; this.userIRName = file.name; this.cabKey = '';
    return file.name;
  }

  setIO(o) { if (this.pre) this.pre.port.postMessage({ type: 'io', ...o }); }
  setOut(o) { if (this.post) this.post.port.postMessage({ type: 'out', ...o }); }
  panic() { for (const n of [this.pre, this.post]) if (n) n.port.postMessage({ type: 'panic' }); }
  unprotect() { if (this.post) this.post.port.postMessage({ type: 'unprotect' }); }
}
