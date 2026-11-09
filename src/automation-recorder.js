// Automation writing (Touch / Latch).
//
// While automation is armed and the transport is rolling, moving an
// automatable control writes into its lane at the playhead instead of
// changing the static value:
//   Touch - writes while the control is held, overwriting what it passes;
//           on release the lane glides back to the curve it had before.
//   Latch - like Touch, but after release keeps writing the last value
//           until the transport stops.
// The lane being written is marked "touched" in the engine so playback of
// its old points doesn't fight the live control. Loop wraps start a new
// pass at the loop start. Touch writes join the control's undo step; a
// latch tail becomes its own undo step when the transport stops.

import { valueAt, mergeSegment, simplify } from './core/autowrite.js';
import { findChannel, uid } from './core/project.js';
import { resolveTarget } from './audio/compile.js';
import { instDefs } from './shared/instruments.js';
import { targetInfo } from './ui/arrangement.js';
import { SYNTH_DEF, SYNTH_INDEX, EFFECT_DEFS, fromNorm } from './shared/params.js';
import { WP_DEF, WP_INDEX } from './shared/worship-params.js';

const MIN_GAP = 1 / 96;   // beats between written points while moving
const RETURN = 1 / 16;    // beats to glide back to the previous curve after a touch

export class AutomationRecorder {
  constructor(app) {
    this.app = app;
    this.writers = new Map();
    this.latchBefore = null;
  }

  get armed() { return !!this.app.ui.autoArm; }
  get mode() { return this.app.ui.autoMode || 'touch'; }
  get rolling() { return this.app.engine.playState === 1; }
  key(chId, target) { return chId + '|' + target; }
  isWriting(chId, target) { return this.writers.has(this.key(chId, target)); }
  get busy() { return this.writers.size > 0; }

  // Called from every control's live update. Returns true when the move was
  // captured as automation (the caller then leaves the static value alone).
  capture(chId, target, norm) {
    if (!this.armed || !this.rolling) return false;
    const beat = this.app.engine.position;
    let w = this.writers.get(this.key(chId, target));
    if (!w) { w = this.start(chId, target, norm, beat); if (!w) return false; }
    w.touching = true;
    this.advance(w, beat);
    w.value = norm;
    this.push(w, beat, norm);
    this.flush(w);
    this.sendLive(w, norm);
    return true;
  }

  start(chId, target, norm, beat) {
    const app = this.app, store = app.store;
    const ch0 = findChannel(app.p, chId);
    const res = ch0 && resolveTarget(ch0, target);
    if (!res) return null;
    if (store.gesture) store.gesture.label = 'Write automation';
    let laneId;
    store.live((p) => {
      const ch = findChannel(p, chId);
      ch.showLanes = true;
      let lane = ch.automation.find((a) => a.target === target);
      if (!lane) { lane = { id: uid('aut'), target, points: [] }; ch.automation.push(lane); }
      laneId = lane.id;
    }, 'auto', { id: chId });
    const ch = findChannel(app.p, chId);
    const lane = ch.automation.find((a) => a.id === laneId);
    const info = targetInfo(app.p, ch, target);
    const manual = info ? info.norm : norm;
    const base = lane.points.map((pt) => [pt[0], pt[1]]);
    const prior = base.length ? valueAt(base, beat) : manual;
    const w = { chId, target, laneId, res, base, manual, segStart: beat, seg: [[beat, prior]], lastBeat: beat, value: norm, touching: true, frames: 0 };
    this.writers.set(this.key(chId, target), w);
    app.engine.post({ type: 'touch', ch: chId, key: res.key, on: true });
    return w;
  }

  // Follow the playhead; a backwards jump means the loop wrapped: close this
  // pass at the loop end and start the next one at the loop start.
  advance(w, beat) {
    if (beat < w.lastBeat - 1e-6) {
      const L = this.app.p.loop;
      const endB = L.on && w.lastBeat <= L.end + 0.05 ? L.end : w.lastBeat;
      if (endB > w.seg[w.seg.length - 1][0]) w.seg.push([endB, w.value]);
      w.base = mergeSegment(w.base, w.seg);
      w.segStart = L.on && beat >= L.start - 1e-6 ? Math.min(beat, L.start) : beat;
      w.seg = [[w.segStart, w.value]];
    }
    w.lastBeat = beat;
  }

  push(w, beat, v) {
    const seg = w.seg, last = seg[seg.length - 1];
    if (beat < last[0]) return;
    const prev = seg.length >= 2 ? seg[seg.length - 2] : null;
    if (prev && prev[1] === last[1] && last[1] === v) last[0] = beat;            // holding: stretch the flat part
    else if (seg.length >= 2 && beat - last[0] < MIN_GAP) { last[0] = beat; last[1] = v; } // too dense: move the last point
    else seg.push([beat, v]);
  }

  flush(w) {
    const pts = mergeSegment(w.base, w.seg);
    this.app.store.live((p) => {
      const ch = findChannel(p, w.chId);
      const lane = ch && ch.automation.find((a) => a.id === w.laneId);
      if (lane) lane.points = pts;
    }, 'autowrite', { id: w.chId });
  }

  // Make the move audible right away through the engine's automation override.
  sendLive(w, norm) {
    const e = this.app.engine, t = w.target;
    if (t.startsWith('inst:')) {
      const pid = t.slice(5), tr = findChannel(this.app.p, w.chId), D = instDefs(tr && tr.instrument);
      e.post({ type: 'param', ch: w.chId, scope: 'inst', index: D.INDEX[pid], value: fromNorm(D.DEF[pid], norm), force: true });
    } else if (t.startsWith('fx:')) {
      const def = EFFECT_DEFS[w.res.type].params[w.res.index];
      e.post({ type: 'param', ch: w.chId, scope: 'fx', slot: w.res.slot, index: w.res.index, value: fromNorm(def, norm), force: true });
    } else {
      e.post({ type: 'param', ch: w.chId, scope: 'mixn', key: t === 'mix:vol' ? 'vol' : t === 'mix:pan' ? 'pan' : 'send', bus: w.res.bus, norm });
    }
  }

  // End of a control gesture.
  release() {
    for (const w of [...this.writers.values()]) {
      if (!w.touching) continue;
      if (this.mode === 'touch' || !this.rolling) this.finish(w, true);
      else w.touching = false; // latch: keep writing the held value
    }
  }
  // After the gesture's undo step is closed: a latch tail gets its own step later.
  afterGesture() {
    if (!this.latchBefore && [...this.writers.values()].some((w) => !w.touching)) this.latchBefore = this.app.store.snapshot();
  }

  // Every frame: holding still (or latched) still writes; stopping finishes everything.
  tick() {
    if (!this.writers.size) return;
    if (!this.rolling || !this.armed) { this.finishAll(); return; }
    const beat = this.app.engine.position;
    for (const w of this.writers.values()) {
      this.advance(w, beat);
      this.push(w, beat, w.value);
      if ((++w.frames & 1) === 0) this.flush(w);
    }
  }

  finish(w, touchRelease) {
    const beat = this.rolling ? this.app.engine.position : w.lastBeat;
    this.advance(w, beat);
    this.push(w, Math.max(beat, w.seg[w.seg.length - 1][0]), w.value);
    let seg = simplify(w.seg, 0.004); // 0.4% of the range: finer than a hand can control
    if (touchRelease) {
      const end = seg[seg.length - 1][0], rb = end + RETURN;
      const rv = w.base.length ? valueAt(w.base, rb) : w.manual;
      if (Math.abs(rv - w.value) > 1e-6) seg = [...seg, [rb, rv]];
    }
    const pts = mergeSegment(w.base, seg);
    this.app.store.live((p) => {
      const ch = findChannel(p, w.chId);
      const lane = ch && ch.automation.find((a) => a.id === w.laneId);
      if (lane) lane.points = pts;
    }, 'auto', { id: w.chId });
    this.app.engine.post({ type: 'touch', ch: w.chId, key: w.res.key, on: false });
    this.writers.delete(this.key(w.chId, w.target));
  }

  finishAll() {
    for (const w of [...this.writers.values()]) this.finish(w, false);
    if (this.latchBefore) {
      const before = this.latchBefore;
      this.latchBefore = null;
      if (!this.app.store.gesture && this.app.store.snapshot() !== before) this.app.store.pushUndo('Write automation (latch)', before);
    }
  }
}
