// Top bar: file actions, undo/redo, transport, tempo, signature, metronome.

import { h, fmtBars, fmtTime } from './dom.js';
import { icon } from './icons.js';
import { NumberField, selectEl, contextMenu, Meter } from './widgets.js';
import { punchMenu } from './arrangement.js';
import { keyName } from '../shared/worship-params.js';

export class Topbar {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    const btn = (ic, title, onClick, cls = '') => h('button', { class: 'ibtn ' + cls, title, onClick }, icon(ic));

    this.nameEl = h('div', { class: 'proj-name', title: 'Project name — double-click to rename' });
    this.nameEl.addEventListener('dblclick', async () => {
      const { promptText } = await import('./widgets.js');
      const n = await promptText('Rename project', app.p.name);
      if (n) app.store.do('Rename project', (p) => { p.name = n; }, 'project');
    });
    this.dirtyEl = h('span', { class: 'dirty-dot', title: 'Unsaved changes' });

    const fileMenu = (e) => contextMenu(e.clientX, e.clientY + 8, [
      { label: 'New empty project', action: () => app.newProject('empty') },
      { label: 'New demo project', action: () => app.newProject('demo') },
      { sep: true },
      { label: 'Open…', shortcut: 'Ctrl+O', action: () => app.openProject() },
      { label: 'Save', shortcut: 'Ctrl+S', action: () => app.saveProject(false) },
      { label: 'Save as…', shortcut: 'Ctrl+Shift+S', action: () => app.saveProject(true) },
      { sep: true },
      { label: 'Import audio…', action: () => shell.importAudio() },
      { label: 'Export WAV…', shortcut: 'Ctrl+Shift+E', action: () => shell.openExport() },
      { sep: true },
      { label: 'Audio & MIDI settings…', action: () => shell.openSettings() },
    ]);

    this.undoBtn = btn('undo', 'Undo (Ctrl+Z)', () => app.store.undo());
    this.redoBtn = btn('redo', 'Redo (Ctrl+Shift+Z)', () => app.store.redo());

    this.rewBtn = btn('rewind', 'Return to start (Enter)', () => app.returnToStart());
    this.playBtn = btn('play', 'Play (Space)', () => app.togglePlay(), 'play');
    this.stopBtn = btn('stop', 'Stop (Space)', () => app.stop());
    this.recBtn = btn('record', 'Record (R) — records the armed tracks, or the selected track', () => app.toggleRecord(), 'rec');
    this.loopBtn = btn('loop', 'Loop (L)', () => app.toggleLoop(), 'toggle');
    this.punchBtn = btn('punch', 'Punch in/out (I): record only inside the red range in the ruler · right-click for pre-roll', () => app.togglePunch(), 'toggle punch');
    this.punchBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); const r = this.punchBtn.getBoundingClientRect(); punchMenu(app, r.left, r.bottom + 4); });
    this.autoBtn = btn('automation', 'Arm automation writing (W): move any knob or fader during playback to record it', () => app.toggleAutoArm(), 'toggle auto-arm');
    this.autoMode = selectEl([{ value: 'touch', label: 'Touch' }, { value: 'latch', label: 'Latch' }], 'touch', (v) => app.setAutoMode(v), 'auto-mode',
      'Touch: writes while you hold a control, then returns to the existing curve. Latch: keeps writing the last value until you stop.');

    this.liveKey = h('span', { class: 'live-key' });
    this.liveBtn = h('button', { class: 'live-btn', title: 'Live Pad Mode (P): continuous worship pads, keys and setlists — runs independently of the transport', onClick: () => app.toggleLiveView() },
      h('span', { class: 'live-dot' }), h('span', null, 'LIVE PAD'), this.liveKey);
    this.posBars = h('div', { class: 'pos-bars' });
    this.posTime = h('div', { class: 'pos-time' });
    this.posEl = h('div', { class: 'position', title: 'Bars.Beats.Sixteenths  /  time' }, this.posBars, this.posTime);

    this.tempo = new NumberField({
      value: app.p.tempo, min: 20, max: 999, step: 0.1, dragStep: 0.5, decimals: 1, class: 'tempo', title: 'Tempo (BPM) — drag or double-click to type',
      onBegin: () => app.setTempo(this.tempo.value, 'begin'), onInput: (v) => app.setTempo(v, 'live'), onEnd: () => app.setTempo(this.tempo.value, 'end'),
    });
    this.sigNum = new NumberField({ value: app.p.sigNum, min: 1, max: 32, step: 1, dragStep: 0.1, class: 'sig', title: 'Beats per bar',
      onBegin: () => {}, onInput: () => {}, onEnd: () => app.setSignature(this.sigNum.value, app.p.sigDen) });
    this.sigDen = selectEl([2, 4, 8, 16].map((v) => ({ value: v, label: String(v) })), app.p.sigDen, (v) => app.setSignature(app.p.sigNum, +v), 'sig-den', 'Beat unit');

    this.metroBtn = btn('metro', 'Metronome (K)', () => app.toggleMetronome(), 'toggle');
    this.countSel = selectEl([{ value: 0, label: 'No count-in' }, { value: 1, label: '1 bar' }, { value: 2, label: '2 bars' }], 1, (v) => app.setCountIn(+v), 'count-in', 'Count-in before recording');
    this.kbdBtn = btn('keys', 'Computer keyboard as MIDI input (`)', () => app.toggleKbd(), 'toggle');
    this.inMeter = new Meter({ horizontal: true });
    this.inBox = h('button', { class: 'in-box', title: 'Audio input level — click for input settings', onClick: () => shell.openSettings() }, icon('mic', 13), this.inMeter.el);
    this.inBox.style.display = 'none';

    this.cpuBar = h('div', { class: 'cpu-fill' });
    this.cpuText = h('span', { class: 'cpu-text' }, 'CPU');
    this.cpuEl = h('div', { class: 'cpu', title: 'Audio thread load' }, h('div', { class: 'cpu-track' }, this.cpuBar), this.cpuText);
    this.audioPill = h('button', { class: 'audio-pill', title: 'Audio engine status — click for settings', onClick: () => (app.engine.state === 'running' ? shell.openSettings() : app.ensureAudio()) });

    this.el = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }), h('div', { class: 'brand-text' }, h('b', null, 'SAW FORGE'), h('span', null, 'STUDIO'))),
      h('div', { class: 'tb-group file' },
        h('button', { class: 'btn ghost menu-btn', onClick: fileMenu }, 'File'),
        h('div', { class: 'proj' }, this.nameEl, this.dirtyEl)),
      h('div', { class: 'tb-group' }, btn('save', 'Save (Ctrl+S)', () => app.saveProject(false)), btn('export', 'Export WAV (Ctrl+Shift+E)', () => shell.openExport()), this.undoBtn, this.redoBtn),
      h('div', { class: 'tb-group transport' }, this.rewBtn, this.stopBtn, this.playBtn, this.recBtn, this.loopBtn, this.punchBtn),
      h('div', { class: 'tb-group auto-group' }, this.autoBtn, this.autoMode),
      this.liveBtn,
      this.posEl,
      h('div', { class: 'tb-group tempo-group' }, h('label', { class: 'tb-label' }, 'BPM'), this.tempo.el, h('div', { class: 'sig-box' }, this.sigNum.el, h('span', { class: 'sig-slash' }, '/'), this.sigDen)),
      h('div', { class: 'tb-group' }, this.metroBtn, this.countSel, this.kbdBtn, this.inBox),
      h('div', { class: 'tb-spacer' }),
      this.cpuEl, this.audioPill,
      h('div', { class: 'tb-group' }, btn('gear', 'Audio & MIDI settings', () => shell.openSettings()), btn('help', 'Keyboard shortcuts (?)', () => shell.openShortcuts())),
    );
    app.addEventListener('history', () => this.refreshHistory());
    app.addEventListener('engine', () => this.refreshEngine());
    app.addEventListener('transport', () => this.refreshTransport());
    app.addEventListener('input', () => { this.inBox.style.display = app.input.enabled ? '' : 'none'; });
    this.refresh({ scope: 'all' });
  }

  refreshLive() {
    const app = this.app, s = app.liveState;
    this.liveBtn.classList.toggle('on', !!app.ui.live);
    this.liveBtn.classList.toggle('playing', !!s.playing);
    this.liveKey.textContent = s.playing ? keyName(s.key, s.minor, app.p.live.spell) : '';
  }
  refreshHistory() {
    const st = this.app.store;
    this.undoBtn.disabled = !st.canUndo; this.redoBtn.disabled = !st.canRedo;
    this.undoBtn.title = st.canUndo ? `Undo ${st.undoLabel} (Ctrl+Z)` : 'Nothing to undo';
    this.redoBtn.title = st.canRedo ? `Redo ${st.redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo';
    this.dirtyEl.classList.toggle('on', st.unsaved);
  }
  refreshEngine() {
    const e = this.app.engine;
    const labels = { off: 'Audio off — click to start', starting: 'Starting audio…', running: `${(e.sampleRate / 1000).toFixed(1)} kHz · ${(e.latency() * 1000).toFixed(0)} ms`, suspended: 'Audio paused — click to resume', error: 'Audio error — restart' };
    this.audioPill.textContent = labels[e.state] || e.state;
    this.audioPill.className = 'audio-pill ' + e.state;
  }
  refreshTransport() {
    const ps = this.app.playState, rec = !!this.app.recording;
    this.playBtn.classList.toggle('on', ps === 1);
    this.recBtn.classList.toggle('on', rec);
    this.recBtn.classList.toggle('counting', rec && ps === 2);
  }
  refresh(d) {
    const p = this.app.p;
    if (d.scope === 'ui' && d.what === 'kbd') { this.kbdBtn.classList.toggle('on', this.app.ui.kbd); return; }
    if (d.scope === 'ui' && d.what === 'live') { this.refreshLive(); return; }
    if (d.scope === 'autowrite') { this.dirtyEl.classList.toggle('on', this.app.store.unsaved); return; }
    this.autoBtn.classList.toggle('on', !!this.app.ui.autoArm);
    this.autoMode.value = this.app.ui.autoMode || 'touch';
    this.nameEl.textContent = p.name;
    this.tempo.set(p.tempo); this.sigNum.set(p.sigNum); this.sigDen.value = String(p.sigDen);
    this.loopBtn.classList.toggle('on', p.loop.on);
    this.punchBtn.classList.toggle('on', p.punch.on);
    this.refreshLive();
    this.metroBtn.classList.toggle('on', p.metronome.on);
    this.countSel.value = String(p.metronome.countIn ?? 1);
    this.kbdBtn.classList.toggle('on', this.app.ui.kbd);
    this.refreshHistory(); this.refreshEngine(); this.refreshTransport();
  }
  frame() {
    const app = this.app, e = app.engine, p = app.p;
    const ps = e.playState;
    let beat = ps === 1 ? e.position : app.ui.cursor;
    if (ps === 2) { this.posBars.textContent = `−${Math.ceil(e.countIn)}`; this.posBars.classList.add('count'); }
    else {
      this.posBars.classList.remove('count');
      const t = fmtBars(beat, p);
      if (t !== this.lastBars) { this.posBars.textContent = t; this.lastBars = t; }
    }
    this.posTime.textContent = fmtTime((beat * 60) / p.tempo);
    if (ps !== this.lastPs) { this.lastPs = ps; this.refreshTransport(); }
    // punch recording: the record button pulses until the playhead is inside the punch range
    const rec = app.recording;
    const wait = !!(rec && rec.punch && ps === 1 && !(e.position >= rec.punch.start && e.position < rec.punch.end));
    if (wait !== this.lastWait) { this.lastWait = wait; this.recBtn.classList.toggle('waiting', wait); }
    if (app.input.enabled) { const [l, r] = e.inputPeaks; this.inMeter.draw(l, r, l * 0.7, r * 0.7, l >= 1 || r >= 1 ? 1 : 0); }
    const cpu = Math.min(1, e.cpu || 0);
    this.cpuBar.style.width = `${cpu * 100}%`;
    this.autoBtn.classList.toggle('writing', app.autoRec.busy);
    this.cpuBar.classList.toggle('hot', cpu > 0.7);
    this.cpuText.textContent = e.state === 'running' ? `${Math.round(cpu * 100)}%` : 'CPU';
  }
}
