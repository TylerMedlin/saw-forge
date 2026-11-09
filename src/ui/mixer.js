// Mixer: one strip per track, then return buses, master pinned on the right.

import { h } from './dom.js';
import { icon } from './icons.js';
import { Knob, Fader, Meter, HSlider, contextMenu, selectEl, lin2db } from './widgets.js';
import { currentDrag } from './browser.js';
import { findChannel } from '../core/project.js';
import { laneValueAt } from './arrangement.js';
import { MIX_PARAMS, EFFECT_DEFS, EFFECT_TYPES, faderNormToDb } from '../shared/params.js';

class Strip {
  constructor(mixer, id) {
    this.mixer = mixer; this.app = mixer.app; this.id = id;
    const app = this.app;
    this.nameEl = h('div', { class: 'strip-name', title: 'Click to select · double-click to rename' });
    this.nameEl.addEventListener('dblclick', () => app.promptRename(id));
    this.insEl = h('div', { class: 'strip-inserts' });
    this.sendsEl = h('div', { class: 'strip-sends' });
    this.routeEl = h('div', { class: 'strip-route' });
    this.pan = new Knob({ def: MIX_PARAMS.pan, size: 30, label: 'Pan',
      onBegin: () => app.mixBegin('Change pan'), onInput: (v) => app.mixLive(id, 'pan', v), onEnd: () => app.mixEnd(),
      onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(id, 'mix:pan', () => app.setChannel(id, 'pan', 0, 'Reset pan'))) });
    this.fader = new Fader({ onBegin: () => app.mixBegin('Change volume'), onInput: (v) => { app.mixLive(id, 'vol', v); this.dbEl.textContent = fmtDb(v); }, onEnd: () => app.mixEnd(),
      onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(id, 'mix:vol', () => app.setChannel(id, 'vol', 0, 'Reset volume'))) });
    this.meter = new Meter();
    this.meter.clipEl.addEventListener('click', () => { app.engine.clearClip(id); this.peakHold = -140; });
    this.dbEl = h('div', { class: 'strip-db', title: 'Fader level' });
    this.pkEl = h('div', { class: 'strip-peak', title: 'Peak level — click to reset', onClick: () => { this.peakHold = -140; app.engine.clearClip(id); } });
    this.bMute = h('button', { class: 'th-btn mute', title: 'Mute', onClick: () => app.toggleChannel(id, 'mute') }, 'M');
    this.bSolo = h('button', { class: 'th-btn solo', title: 'Solo', onClick: (e) => (e.ctrlKey ? app.exclusiveSolo(id) : app.toggleChannel(id, 'solo')) }, 'S');
    this.bArm = h('button', { class: 'th-btn arm', title: 'Arm', onClick: () => app.toggleChannel(id, 'arm') }, 'R');
    this.bMon = h('button', { class: 'th-btn mon', title: 'Monitor input while armed', onClick: () => app.toggleChannel(id, 'monitor') }, icon('headphones', 11));
    this.inputEl = h('div', { class: 'strip-input' });
    this.peakHold = -140;
    this.el = h('div', { class: 'strip' },
      this.nameEl,
      h('div', { class: 'strip-sec-label' }, 'Inserts'), this.insEl,
      h('div', { class: 'strip-sec-label sends-label' }, 'Sends'), this.sendsEl,
      this.inputEl,
      this.routeEl,
      h('div', { class: 'strip-pan' }, this.pan.el),
      h('div', { class: 'strip-fader-row' }, this.fader.el, this.meter.el),
      h('div', { class: 'strip-readouts' }, this.dbEl, this.pkEl),
      h('div', { class: 'strip-btns' }, this.bMute, this.bSolo, this.bArm, this.bMon));
    this.el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button, .knob, .fader, select, .hslider, .ins-item')) app.selectTrack(id, { openInstrument: false }); });
    this.el.addEventListener('dragover', (e) => { if (currentDrag && currentDrag.kind === 'effect') { e.preventDefault(); this.el.classList.add('drop'); } });
    this.el.addEventListener('dragleave', () => this.el.classList.remove('drop'));
    this.el.addEventListener('drop', (e) => { this.el.classList.remove('drop'); if (currentDrag && currentDrag.kind === 'effect') { e.preventDefault(); app.addInsert(id, currentDrag.name); } });
    this.sendKey = null; this.routeKey = null; this.sends = [];
  }

  update(ch, kind) {
    const app = this.app, p = app.p;
    this.el.className = 'strip strip-' + kind + (app.ui.selTrack === this.id ? ' selected' : '');
    this.el.style.setProperty('--tc', ch.color || '#888');
    this.nameEl.textContent = ch.name;
    this.fader.set(ch.vol); this.dbEl.textContent = fmtDb(ch.vol);
    this.fader.setAutomated(app.hasAutomation(this.id, 'mix:vol'));
    this.pan.set(ch.pan || 0); this.pan.setAutomated(app.hasAutomation(this.id, 'mix:pan'));
    this.bMute.classList.toggle('on', !!ch.mute); this.bSolo.classList.toggle('on', !!ch.solo); this.bArm.classList.toggle('on', !!ch.arm);
    const isAudio = kind === 'track' && ch.kind === 'audio';
    this.bSolo.style.display = kind === 'master' ? 'none' : ''; this.bArm.style.display = kind === 'track' ? '' : 'none';
    this.bMon.style.display = isAudio ? '' : 'none'; this.bMon.classList.toggle('on', !!ch.monitor);
    if (isAudio) {
      const key = 'in|' + (ch.input || 'stereo');
      if (key !== this.inputKey) {
        this.inputKey = key;
        this.inputEl.replaceChildren(selectEl([{ value: 'stereo', label: 'In 1+2' }, { value: 'L', label: 'In 1' }, { value: 'R', label: 'In 2' }], ch.input || 'stereo', (v) => app.setTrackInput(this.id, v), 'route-sel', 'Record input channels'));
      }
      this.inputEl.style.display = '';
    } else { this.inputEl.style.display = 'none'; this.inputKey = null; }
    // inserts
    this.insEl.replaceChildren(...ch.inserts.map((fx, i) => {
      const b = h('div', { class: 'ins-item' + (fx.bypass ? ' bypassed' : '') + (app.ui.selInsert === fx.id ? ' active' : ''), title: `${EFFECT_DEFS[fx.type].name} — click to edit · right-click for options` },
        h('span', { class: 'ins-pow' + (fx.bypass ? '' : ' on'), title: fx.bypass ? 'Enable' : 'Bypass', onClick: (e) => { e.stopPropagation(); app.toggleBypass(this.id, fx.id); } }),
        h('span', { class: 'ins-name' }, EFFECT_DEFS[fx.type].short));
      b.addEventListener('click', () => { app.ui.selTrack = this.id; app.ui.selInsert = fx.id; app.setTab('fx'); });
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); contextMenu(e.clientX, e.clientY, [
        { label: fx.bypass ? 'Enable' : 'Bypass', action: () => app.toggleBypass(this.id, fx.id) },
        { label: 'Move up', disabled: i === 0, action: () => app.moveInsert(this.id, fx.id, -1) },
        { label: 'Move down', disabled: i === ch.inserts.length - 1, action: () => app.moveInsert(this.id, fx.id, 1) },
        { sep: true }, { label: 'Remove', danger: true, action: () => app.removeInsert(this.id, fx.id) }]); });
      return b;
    }), h('button', { class: 'ins-add', title: 'Add insert effect', onClick: (e) => contextMenu(e.clientX, e.clientY, EFFECT_TYPES.map((t) => ({ label: EFFECT_DEFS[t].name, action: () => app.addInsert(this.id, t) }))) }, icon('plus', 12)));
    // sends (tracks only)
    const isTrack = kind === 'track';
    this.sendsEl.style.display = isTrack ? '' : 'none';
    this.el.querySelector('.sends-label').style.display = isTrack ? '' : 'none';
    if (isTrack) {
      const key = p.buses.map((b) => b.id + ':' + b.name).join('|');
      if (key !== this.sendKey) {
        this.sendKey = key;
        this.sends = p.buses.map((b) => {
          const sl = new HSlider({ def: MIX_PARAMS.send, value: -70, class: 'send-slider', prefix: '', title: `Send to ${b.name}`,
            onBegin: () => app.mixBegin(`Send to ${b.name}`), onInput: (v) => app.mixLive(this.id, 'send', v, b.id), onEnd: () => app.mixEnd(),
            onContext: (e) => contextMenu(e.clientX, e.clientY, app.laneMenuItems(this.id, `mix:send:${b.id}`)) });
          return { bus: b.id, sl, row: h('div', { class: 'send-row' }, h('span', { class: 'send-name' }, b.name), sl.el) };
        });
        this.sendsEl.replaceChildren(...(this.sends.length ? this.sends.map((s) => s.row) : [h('div', { class: 'strip-empty' }, 'No buses')]));
      }
      for (const s of this.sends) { const snd = ch.sends.find((x) => x.busId === s.bus); s.sl.set(snd ? snd.level : -70); s.sl.setAutomated(app.hasAutomation(this.id, `mix:send:${s.bus}`)); }
      const rkey = key + '|' + ch.output;
      if (rkey !== this.routeKey) {
        this.routeKey = rkey;
        this.routeEl.replaceChildren(selectEl([{ value: 'master', label: '→ Master' }, ...p.buses.map((b) => ({ value: b.id, label: '→ ' + b.name }))], ch.output || 'master', (v) => app.setChannel(this.id, 'output', v, 'Route output'), 'route-sel', 'Output routing'));
      }
    } else this.routeEl.replaceChildren(h('div', { class: 'strip-route-fixed' }, kind === 'master' ? 'Output' : '→ Master'));
  }

  frame() {
    const e = this.app.engine, b = e.meterBase(this.id);
    if (b < 0) { this.meter.draw(0, 0, 0, 0, 0); return; }
    const m = e.meters;
    this.meter.draw(m[b], m[b + 1], m[b + 2], m[b + 3], m[b + 4]);
    const pk = lin2db(Math.max(m[b], m[b + 1]));
    if (pk > this.peakHold) this.peakHold = pk;
    const t = this.peakHold <= -100 ? '−∞' : (this.peakHold > 0 ? '+' : '') + this.peakHold.toFixed(1);
    if (t !== this.pkText) { this.pkText = t; this.pkEl.textContent = t; this.pkEl.classList.toggle('hot', this.peakHold > -0.1); }
  }
}

const fmtDb = (v) => (v <= -69.9 ? '−∞' : (v > 0 ? '+' : '') + v.toFixed(1));

export class Mixer {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.strips = new Map();
    this.scroll = h('div', { class: 'mixer-scroll' });
    this.masterWrap = h('div', { class: 'mixer-master' });
    this.el = h('div', { class: 'mixer' }, this.scroll, this.masterWrap);
  }
  refresh(d) {
    if (d.scope === 'mix-param' || d.scope === 'inst-param' || d.scope === 'fx-param' || d.scope === 'wt') return;
    const p = this.app.p;
    const order = [...p.tracks.map((t) => [t, 'track']), ...p.buses.map((b) => [b, 'bus'])];
    const seen = new Set();
    const nodes = [];
    let lastKind = null;
    for (const [ch, kind] of order) {
      seen.add(ch.id);
      let st = this.strips.get(ch.id);
      if (!st) { st = new Strip(this, ch.id); this.strips.set(ch.id, st); }
      st.update(ch, kind);
      if (kind === 'bus' && lastKind === 'track') nodes.push(h('div', { class: 'mixer-gap' }));
      lastKind = kind;
      nodes.push(st.el);
    }
    if (!p.tracks.length) nodes.push(h('div', { class: 'empty-note mixer-empty' }, 'No tracks yet — add one from the arrangement toolbar or the browser.'));
    this.scroll.replaceChildren(...nodes);
    seen.add('master');
    let ms = this.strips.get('master');
    if (!ms) { ms = new Strip(this, 'master'); this.strips.set('master', ms); this.masterWrap.append(ms.el); }
    ms.update(p.master, 'master');
    for (const [id] of this.strips) if (!seen.has(id)) this.strips.delete(id);
  }
  frame() {
    for (const st of this.strips.values()) if (st.el.isConnected) st.frame();
    // faders, pans and sends follow their automation during playback
    const app = this.app;
    if (!app.isPlaying || (this.tick = (this.tick || 0) + 1) % 3) return;
    const pos = app.engine.position, p = app.p;
    for (const ch of [...p.tracks, ...p.buses, p.master]) {
      const st = this.strips.get(ch.id);
      if (!st || !ch.automation.length) continue;
      for (const lane of ch.automation) {
        if (!lane.points.length || app.autoRec.isWriting(ch.id, lane.target)) continue;
        const v = laneValueAt(lane.points, pos);
        if (lane.target === 'mix:vol') { const db = faderNormToDb(v); st.fader.set(db); st.dbEl.textContent = db <= -69.9 ? '−∞' : (db > 0 ? '+' : '') + db.toFixed(1); }
        else if (lane.target === 'mix:pan') st.pan.set(v * 2 - 1);
        else if (lane.target.startsWith('mix:send:')) { const s = st.sends.find((x) => x.bus === lane.target.slice(9)); if (s) s.sl.set(faderNormToDb(v)); }
      }
    }
  }
}
