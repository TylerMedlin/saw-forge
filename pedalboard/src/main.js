// Saw Forge — Worship Pedalboard (Milestone 1: live guitar engine).

import { PedalEngine } from './audio/engine.js';
import { PEDALS, AMPS, CABS, AMP_PARAMS, ampById, cabById } from './shared/defs.js';
import { loadBoard, saveBoard, loadSettings, saveSettings, newPedal, newAmp, starterBoard, cleanBoard, exportBoardFile } from './board.js';
import { h, knob, toast } from './ui.js';

const CPU_BUDGET = 60; // rough cost units for a comfortable real-time load

class PedalboardApp {
  constructor(root) {
    this.root = root;
    this.engine = new PedalEngine();
    const { board, warning } = loadBoard();
    this.board = board; this.settings = loadSettings();
    this.tab = 'board'; this.test = false; this.muted = false; this.taps = [];
    this.devices = { inputs: [], outputs: [] }; this.inputError = '';
    this.saveSoon = 0;
    if (warning) setTimeout(() => toast(warning, 'warn'), 300);
  }

  async boot() {
    this.root.append(this.buildShell());
    this.render();
    this.engine.addEventListener('meter', () => {});
    this.engine.addEventListener('state', () => this.renderPower());
    this.engine.addEventListener('protect', () => { toast('Feedback protection: the output was runaway-loud, so it faded out and the delays/reverbs were cleared. Press Resume when ready.', 'warn'); this.renderPower(); });
    this.engine.addEventListener('inputlost', () => { this.inputError = 'The audio input disconnected.'; toast('Your audio interface disconnected.', 'warn'); this.renderPower(); });
    this.engine.addEventListener('error', (e) => toast(e.detail, 'warn'));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => this.refreshDevices());
    this.meterLoop();
    window.addEventListener('beforeunload', () => saveBoard(this.board));
  }

  // ------------------------------------------------------------ persistence
  changed(structural = false) {
    clearTimeout(this.saveSoon);
    this.saveSoon = setTimeout(() => saveBoard(this.board), 400);
    if (structural) { this.engine.sendBoard(this.board); this.render(); }
  }
  setSetting(k, v) { this.settings[k] = v; saveSettings(this.settings); }

  // ------------------------------------------------------------ audio start/stop
  async startAudio() {
    if (!this.settings.seenIntro) { this.setSetting('seenIntro', true); this.renderTab(); }
    try {
      await this.engine.start({ outputDeviceId: this.settings.outputId || undefined });
    } catch (err) { toast(`Audio couldn't start: ${err.message || err}`, 'warn'); return; }
    this.engine.sendBoard(this.board);
    this.sendIO(); this.sendOut();
    if (!this.test) await this.openInput();
    this.refreshDevices();
    this.renderPower();
  }
  async openInput() {
    this.inputError = '';
    try { await this.engine.openInput(this.settings.inputId); }
    catch (err) {
      const why = err && err.name === 'NotAllowedError' ? 'Permission to use the audio input was denied. Allow microphone/audio input access for this app, then press Start again.'
        : err && err.name === 'NotFoundError' ? 'No audio input was found. Connect your audio interface and press Start again.'
          : `The audio input couldn't open: ${err.message || err}`;
      this.inputError = why; toast(why, 'warn');
    }
    this.renderPower();
  }
  sendIO() { const s = this.settings; this.engine.setIO({ inputGain: s.inputGain, channel: s.channel, gateOn: s.gateOn, gateThr: s.gateThr, gateRel: s.gateRel, test: this.test }); }
  sendOut() { const s = this.settings; this.engine.setOut({ volume: s.volume, mute: this.muted, width: s.width, mono: s.mono }); }

  async refreshDevices() {
    this.devices = await this.engine.listDevices();
    if (this.tab === 'settings') this.renderTab();
  }

  // ------------------------------------------------------------ shell
  buildShell() {
    this.powerBtn = h('button', { class: 'btn power', onclick: () => (this.engine.running ? this.engine.stop() : this.startAudio()) });
    this.statusEl = h('div', { class: 'status' });
    this.testBtn = h('button', { class: 'btn test', title: 'A synthetic plucked-guitar signal for trying sounds without a guitar. It is not your instrument.', onclick: () => this.toggleTest() }, 'TEST SIGNAL');
    this.muteBtn = h('button', { class: 'btn mute', onclick: () => { this.muted = !this.muted; this.sendOut(); this.renderPower(); } }, 'MUTE');
    this.volKnob = knob({ k: 'volume', name: 'Master', min: -60, max: 6, def: -6, unit: 'dB' }, this.settings.volume, { size: 's', onInput: (v) => { this.settings.volume = v; this.sendOut(); }, onCommit: (v) => this.setSetting('volume', v) });
    this.bpmEl = h('div', { class: 'bpm-val', title: 'Click to type a tempo', onclick: () => this.askBpm() });
    this.tapBtn = h('button', { class: 'btn tap', onpointerdown: () => this.tap() }, 'TAP');
    this.inMeter = this.meter('IN'); this.outMeterL = this.meter('L'); this.outMeterR = this.meter('R');
    this.clipLed = h('div', { class: 'clip-led', title: 'Input clipping: turn down the gain knob on your audio interface' }, 'CLIP');
    this.cpuEl = h('div', { class: 'cpu', title: 'Estimated processing load' });
    this.tabsEl = h('nav', { class: 'tabs' });
    this.tabBody = h('main', { class: 'tab-body' });
    const top = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), h('div', {}, h('div', { class: 'brand-1' }, 'SAW FORGE'), h('div', { class: 'brand-2' }, 'WORSHIP PEDALBOARD'))),
      this.powerBtn, this.testBtn, this.statusEl,
      h('div', { class: 'spacer' }),
      h('div', { class: 'meters' }, this.inMeter.el, this.clipLed, h('div', { class: 'meter-gap' }), this.outMeterL.el, this.outMeterR.el),
      h('div', { class: 'tempo' }, h('div', { class: 'tempo-label' }, 'TEMPO'), this.bpmEl, this.tapBtn),
      this.volKnob, this.muteBtn, this.cpuEl);
    return h('div', { class: 'app' }, top, this.tabsEl, this.tabBody);
  }
  meter(label) {
    const bar = h('div', { class: 'meter-fill' }), el = h('div', { class: 'meter' }, h('div', { class: 'meter-track' }, bar), h('div', { class: 'meter-label' }, label));
    return { el, bar, v: 0 };
  }

  render() {
    this.tabsEl.replaceChildren(...[['board', 'BOARD'], ['amp', 'AMP'], ['settings', 'SETTINGS']].map(([id, label]) =>
      h('button', { class: `tab ${this.tab === id ? 'on' : ''}`, onclick: () => { this.tab = id; this.render(); } }, label)),
    h('div', { class: 'board-name' }, h('input', { value: this.board.name, 'aria-label': 'Board name', onchange: (e) => { this.board.name = e.target.value.slice(0, 60) || 'Untitled board'; this.changed(); } })),
    h('button', { class: 'btn small', onclick: () => exportBoardFile(this.board) }, 'Export'),
    h('button', { class: 'btn small', onclick: () => this.importBoard() }, 'Import'),
    h('button', { class: 'btn small', onclick: () => { if (confirm('Replace this board with the starter board?')) { this.board = starterBoard(); this.changed(true); } } }, 'Starter board'));
    this.renderTab(); this.renderPower(); this.renderTempo();
  }
  renderTab() {
    const body = this.tab === 'board' ? this.boardView() : this.tab === 'amp' ? this.ampView() : this.settingsView();
    this.tabBody.replaceChildren(body);
    if (!this.settings.seenIntro) this.tabBody.append(this.introCard());
  }
  renderPower() {
    const run = this.engine.running;
    this.powerBtn.textContent = run ? '■ STOP' : '▶ START AUDIO';
    this.powerBtn.classList.toggle('on', run);
    this.testBtn.classList.toggle('on', this.test);
    this.muteBtn.classList.toggle('on', this.muted);
    const lat = this.engine.latencyMs();
    let s;
    if (!run) s = 'Audio is off. Nothing is monitored until you press Start.';
    else if (this.engine.meters.protect) s = h('span', {}, 'Output protected. ', h('button', { class: 'btn small', onclick: () => { this.engine.unprotect(); this.engine.meters.protect = false; this.renderPower(); } }, 'Resume'));
    else if (this.test) s = 'Playing the TEST SIGNAL (not your guitar).';
    else if (this.inputError) s = this.inputError;
    else s = `Input: ${this.engine.inputLabel || '…'}${lat ? ` · output latency ≈ ${lat} ms` : ''}`;
    this.statusEl.replaceChildren(typeof s === 'string' ? document.createTextNode(s) : s);
    this.statusEl.classList.toggle('warn', !!(run && (this.inputError || this.engine.meters.protect)));
  }

  async toggleTest() {
    this.test = !this.test;
    if (this.test && !this.engine.running) await this.startAudio();
    if (!this.test && this.engine.running && !this.engine.stream) await this.openInput();
    this.sendIO(); this.renderPower();
  }

  // ------------------------------------------------------------ tempo
  renderTempo() { this.bpmEl.textContent = `${Math.round(this.board.bpm)}`; }
  setBpm(bpm) { this.board.bpm = Math.max(40, Math.min(240, bpm)); this.engine.setTempo(this.board.bpm); this.renderTempo(); this.changed(); if (this.tab === 'board') this.renderTab(); }
  tap() {
    const t = performance.now();
    this.taps = this.taps.filter((x) => t - x < 2500); this.taps.push(t);
    this.tapBtn.classList.add('flash'); setTimeout(() => this.tapBtn.classList.remove('flash'), 90);
    if (this.taps.length >= 2) {
      const d = []; for (let i = 1; i < this.taps.length; i++) d.push(this.taps[i] - this.taps[i - 1]);
      const avg = d.slice(-4).reduce((a, b) => a + b, 0) / Math.min(4, d.length);
      this.setBpm(Math.round(60000 / avg * 10) / 10);
    }
  }
  askBpm() { const v = Number(prompt('Tempo (BPM)', String(Math.round(this.board.bpm)))); if (Number.isFinite(v) && v > 0) this.setBpm(v); }

  // ------------------------------------------------------------ BOARD tab
  cpuCost() {
    let c = this.board.amp.on ? 6 : 0;
    for (const x of this.board.chain) if (PEDALS[x.type]) c += PEDALS[x.type].cost;
    return c;
  }
  boardView() {
    const chain = this.board.chain, ampAt = chain.findIndex((x) => x.type === 'amp');
    const flow = h('div', { class: 'flow' }, h('span', { class: 'flow-io' }, 'GUITAR'), h('span', { class: 'flow-arrow' }, '→'), h('span', { class: `flow-chip gate ${this.settings.gateOn ? 'on' : ''}` }, 'Gate'),
      ...chain.flatMap((x, i) => [h('span', { class: 'flow-arrow' }, '→'), x.type === 'amp'
        ? h('span', { class: `flow-chip amp ${this.board.amp.on ? 'on' : ''}` }, `${ampById(this.board.amp.model).name} + Cab`)
        : h('span', { class: `flow-chip ${x.on ? 'on' : ''}`, style: { '--c': PEDALS[x.type].color } }, x.name || PEDALS[x.type].name)]),
      h('span', { class: 'flow-arrow' }, '→'), h('span', { class: 'flow-io' }, 'OUT (STEREO)'));
    const pedals = chain.map((x, i) => (x.type === 'amp' ? this.ampBlock(i) : this.pedalEl(x, i, i < ampAt)));
    const add = h('div', { class: 'add-pedal' },
      h('select', { 'aria-label': 'Add a pedal', onchange: (e) => { if (e.target.value) this.addPedal(e.target.value); e.target.value = ''; } },
        h('option', { value: '' }, '+ Add pedal…'),
        ...['Dynamics', 'Drive', 'Delay', 'Reverb'].map((fam) => h('optgroup', { label: fam }, ...Object.entries(PEDALS).filter(([, d]) => d.family === fam).map(([id, d]) => h('option', { value: id }, `${d.name} — ${d.label}`))))),
      h('div', { class: 'muted' }, 'More pedal types arrive in the next milestones.'));
    const pct = Math.round(this.cpuCost() / CPU_BUDGET * 100);
    return h('div', { class: 'board-view' }, flow,
      h('div', { class: 'board-surface' }, h('div', { class: 'pedal-row' }, ...pedals), add),
      h('div', { class: 'board-foot muted' }, `${chain.length - 1} pedal${chain.length === 2 ? '' : 's'} · estimated load ${pct}% · Pedals left of the amp run before it (mono); pedals right of it run after the cabinet in stereo. Use ◀ ▶ to change the order.`));
  }

  pedalEl(x, i, beforeAmp) {
    const d = PEDALS[x.type];
    const led = h('div', { class: `led ${x.on ? 'on' : ''}` });
    const knobs = d.params.map((q) => knob(q, x.params[q.k], {
      size: d.params.length > 6 ? 's' : 'm',
      onInput: (v) => { x.params[q.k] = v; this.engine.sendParams(this.board, x); },
      onCommit: () => this.changed(),
    }));
    const el = h('div', { class: `pedal ${x.on ? 'on' : 'off'} fam-${d.family.toLowerCase()}`, style: { '--c': d.color }, 'data-uid': x.uid },
      h('div', { class: 'pedal-tools' },
        h('button', { title: 'Move left', disabled: i === 0, onclick: () => this.move(i, -1) }, '◀'),
        h('button', { title: 'Move right', disabled: i === this.board.chain.length - 1, onclick: () => this.move(i, 1) }, '▶'),
        h('button', { title: 'Remove pedal', onclick: () => this.remove(i) }, '✕')),
      h('div', { class: 'pedal-head' }, h('div', { class: 'pedal-name' }, x.name || d.name), h('div', { class: 'pedal-label' }, d.label), led),
      h('div', { class: 'pedal-knobs' }, ...knobs),
      h('div', { class: 'pedal-place' }, beforeAmp ? 'before amp · mono' : 'after amp · stereo'),
      h('button', { class: 'footswitch', title: 'Bypass on/off', onclick: () => { x.on = !x.on; el.classList.toggle('on', x.on); el.classList.toggle('off', !x.on); led.classList.toggle('on', x.on); this.engine.sendOn(this.board, x); this.changed(); this.updateFlowChip(); } }));
    return el;
  }
  updateFlowChip() { if (this.tab === 'board') { const f = this.tabBody.querySelector('.flow'); if (f) f.replaceWith(this.boardView().querySelector('.flow')); } }
  ampBlock() {
    const a = this.board.amp, m = ampById(a.model);
    return h('div', { class: `amp-block ${a.on ? 'on' : 'off'}`, onclick: (e) => { if (!e.target.closest('button')) { this.tab = 'amp'; this.render(); } }, title: 'Open the amp' },
      h('div', { class: 'amp-grill' }), h('div', { class: 'amp-name' }, m.name), h('div', { class: 'amp-label' }, m.label),
      h('div', { class: 'amp-cab' }, a.cabOn ? (a.cab === 'user' ? `IR: ${this.engine.userIRName || 'your file'}` : cabById(a.cab).name) : 'Cab off'),
      h('div', { class: 'amp-tools' },
        h('button', { title: 'Move amp left', onclick: () => this.move(this.board.chain.findIndex((x) => x.type === 'amp'), -1) }, '◀'),
        h('button', { title: 'Move amp right', onclick: () => this.move(this.board.chain.findIndex((x) => x.type === 'amp'), 1) }, '▶')));
  }
  addPedal(type) {
    const d = PEDALS[type], chain = this.board.chain, ampAt = chain.findIndex((x) => x.type === 'amp');
    const p = newPedal(type);
    // drives and dynamics go before the amp, time effects after it
    if (d.place === 'pre') chain.splice(ampAt, 0, p); else chain.push(p);
    if (this.cpuCost() > CPU_BUDGET * 0.85) toast('This board is getting heavy. If you hear crackles or dropouts, remove a pedal (reverbs cost the most).', 'warn');
    this.changed(true);
  }
  move(i, dir) {
    const c = this.board.chain, j = i + dir;
    if (j < 0 || j >= c.length) return;
    [c[i], c[j]] = [c[j], c[i]];
    this.changed(true);
  }
  remove(i) { this.board.chain.splice(i, 1); this.changed(true); }

  async importBoard() {
    const inp = h('input', { type: 'file', accept: '.json,application/json' });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try { this.board = cleanBoard(JSON.parse(await f.text())); this.changed(true); toast(`Loaded “${this.board.name}”.`); }
      catch (err) { toast(`Couldn't open that file: ${err.message}`, 'warn'); }
    };
    inp.click();
  }

  // ------------------------------------------------------------ AMP tab
  ampView() {
    const a = this.board.amp, m = ampById(a.model);
    const send = () => { this.engine.sendAmp(a); this.changed(); };
    const models = h('div', { class: 'amp-models' }, ...AMPS.map((x) => h('button', { class: `amp-model ${x.id === a.model ? 'on' : ''}`, onclick: () => {
      a.model = x.id; a.cab = a.cab === 'user' ? 'user' : x.cab; a.cabB = x.cabB || null; send(); this.render();
    } }, h('b', {}, x.name), h('span', {}, x.label))));
    const knobs = AMP_PARAMS.map((q) => knob(q, a.params[q.k], { onInput: (v) => { a.params[q.k] = v; this.engine.sendAmp(a); }, onCommit: () => this.changed() }));
    const micQ = { k: 'mic', name: 'Mic Position', min: 0, max: 100, def: 35, unit: '%' }, distQ = { k: 'dist', name: 'Mic Distance', min: 0, max: 100, def: 20, unit: '%' };
    const cabSel = h('select', { onchange: (e) => { a.cab = e.target.value; a.cabB = e.target.value !== 'user' && m.stereoB ? a.cabB : null; send(); this.render(); } },
      ...CABS.map((c) => h('option', { value: c.id, selected: a.cab === c.id }, c.name)),
      this.engine.userIR ? h('option', { value: 'user', selected: a.cab === 'user' }, `Your IR: ${this.engine.userIRName}`) : null);
    return h('div', { class: 'amp-view' },
      h('div', { class: 'panel' }, h('h3', {}, 'Amplifier'), models,
        h('p', { class: 'muted' }, m.blurb, ' Original model; describes a sonic family, not an official emulation.'),
        h('div', { class: 'amp-face' }, ...knobs),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.on, onchange: (e) => { a.on = e.target.checked; send(); } }), ' Amp simulation on'),
        h('p', { class: 'muted' }, 'Turn the amp and cabinet off when you run into a real guitar amp.')),
      h('div', { class: 'panel' }, h('h3', {}, 'Cabinet'),
        h('div', { class: 'row' }, cabSel, h('button', { class: 'btn small', onclick: () => this.importIR() }, 'Import IR…')),
        m.stereoB && a.cab !== 'user' ? h('p', { class: 'muted' }, `Stereo rig: ${cabById(a.cab).name} on the left, ${cabById(a.cabB || m.cabB).name} on the right.`) : null,
        h('div', { class: 'amp-face' },
          knob(micQ, a.mic, { onInput: (v) => { a.mic = Math.round(v); this.engine.sendAmp(a); }, onCommit: () => this.changed(), disabledText: a.cab === 'user' ? 'n/a' : undefined }),
          knob(distQ, a.dist, { onInput: (v) => { a.dist = Math.round(v); this.engine.sendAmp(a); }, onCommit: () => this.changed(), disabledText: a.cab === 'user' ? 'n/a' : undefined })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.cabOn, onchange: (e) => { a.cabOn = e.target.checked; send(); } }), ' Cabinet simulation on'),
        h('p', { class: 'muted' }, 'Mic Position moves from the centre of the speaker (bright) to the edge (warm). Imported IRs (WAV files) stay on this computer for this session; re-import after restarting.')));
  }
  async importIR() {
    if (!this.engine.ctx) { toast('Press Start Audio first, then import your IR.', 'warn'); return; }
    const inp = h('input', { type: 'file', accept: 'audio/*,.wav' });
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try { await this.engine.importIR(f); this.board.amp.cab = 'user'; this.engine.sendAmp(this.board.amp); this.changed(); this.render(); toast(`Loaded cabinet IR “${f.name}”.`); }
      catch (err) { toast(`Couldn't load that IR: ${err.message || err}`, 'warn'); }
    };
    inp.click();
  }

  // ------------------------------------------------------------ SETTINGS tab
  settingsView() {
    const s = this.settings;
    const sel = (list, cur, on, emptyLabel) => h('select', { onchange: (e) => on(e.target.value) },
      h('option', { value: '' }, emptyLabel), ...list.map((d) => h('option', { value: d.id, selected: d.id === cur }, d.label)));
    const gq = (k, name, min, max, def, unit) => ({ k, name, min, max, def, unit });
    const canSink = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    return h('div', { class: 'settings-view' },
      h('div', { class: 'panel' }, h('h3', {}, 'Audio input'),
        h('div', { class: 'field' }, h('label', {}, 'Input device'), sel(this.devices.inputs, s.inputId, async (v) => { this.setSetting('inputId', v); if (this.engine.running && !this.test) await this.openInput(); }, 'System default')),
        this.devices.inputs.length === 0 ? h('p', { class: 'muted' }, 'Device names appear after you press Start Audio and allow access.') : null,
        h('div', { class: 'field' }, h('label', {}, 'Guitar is on'), h('select', { onchange: (e) => { this.setSetting('channel', Number(e.target.value)); this.sendIO(); } },
          ...['Input 1 (left)', 'Input 2 (right)', 'Both inputs (mixed)'].map((t, i) => h('option', { value: i, selected: s.channel === i }, t)))),
        h('div', { class: 'amp-face' },
          knob(gq('inputGain', 'Input Gain', -24, 24, 0, 'dB'), s.inputGain, { onInput: (v) => { s.inputGain = v; this.sendIO(); }, onCommit: (v) => this.setSetting('inputGain', v) }),
          knob(gq('gateThr', 'Gate Threshold', -90, -30, -64, 'dB'), s.gateThr, { onInput: (v) => { s.gateThr = v; this.sendIO(); }, onCommit: (v) => this.setSetting('gateThr', v) }),
          knob({ ...gq('gateRel', 'Gate Release', 20, 800, 120, 'ms'), curve: 'log' }, s.gateRel, { onInput: (v) => { s.gateRel = v; this.sendIO(); }, onCommit: (v) => this.setSetting('gateRel', v) })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.gateOn, onchange: (e) => { this.setSetting('gateOn', e.target.checked); this.sendIO(); } }), ' Noise gate on')),
      h('div', { class: 'panel' }, h('h3', {}, 'Output'),
        canSink ? h('div', { class: 'field' }, h('label', {}, 'Output device'), sel(this.devices.outputs, s.outputId, async (v) => { this.setSetting('outputId', v); if (this.engine.ctx) await this.engine.setOutputDevice(v); }, 'System default')) : h('p', { class: 'muted' }, 'This browser plays through the system default output.'),
        h('div', { class: 'amp-face' }, knob(gq('width', 'Stereo Width', 0, 150, 100, '%'), s.width, { onInput: (v) => { s.width = v; this.sendOut(); }, onCommit: (v) => this.setSetting('width', v) })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.mono, onchange: (e) => { this.setSetting('mono', e.target.checked); this.sendOut(); } }), ' Mono output (for a mono PA feed)'),
        h('p', { class: 'muted' }, 'A limiter keeps the output below 0 dBFS, and feedback protection fades the output if delays or reverbs ever run away.'),
        h('button', { class: 'btn small', onclick: () => { this.engine.panic(); toast('Delays and reverbs cleared.'); } }, 'Clear all tails (panic)')),
      h('div', { class: 'panel help' }, h('h3', {}, 'Connecting your guitar'), ...this.helpText()));
  }
  helpText() {
    return [
      h('ol', {},
        h('li', {}, 'Plug the guitar into the ', h('b', {}, 'Hi-Z / Instrument'), ' input of your audio interface (often marked with a guitar icon or "INST"). A normal line or mic input will sound thin and weak.'),
        h('li', {}, 'Set the interface\'s gain so your hardest strum lights the IN meter near the top but the CLIP light stays off.'),
        h('li', {}, h('b', {}, 'Turn off "Direct Monitor"'), ' on the interface (or turn its mix knob fully to "Playback/DAW"). Otherwise you hear your dry guitar on top of the pedalboard, which sounds doubled or phasey.'),
        h('li', {}, 'Use headphones or speakers on the interface\'s outputs, then press ', h('b', {}, 'Start Audio'), ' and allow audio input access.'),
        h('li', {}, 'If "Guitar is on" is wrong you\'ll hear nothing; switch it to Input 2.')),
      h('p', { class: 'muted' }, 'Latency: the browser chooses the audio buffer size; this app can\'t change your interface\'s driver settings. For the lowest delay, set your interface\'s buffer to 128 samples or less in its own control panel, and close other audio apps.'),
    ];
  }
  introCard() {
    return h('div', { class: 'intro' }, h('div', { class: 'intro-card' },
      h('h2', {}, 'Welcome to Worship Pedalboard'), ...this.helpText(),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => { this.setSetting('seenIntro', true); this.renderTab(); this.startAudio(); } }, 'Start Audio'),
        h('button', { class: 'btn', onclick: () => { this.setSetting('seenIntro', true); this.renderTab(); } }, 'Not now'))));
  }

  // ------------------------------------------------------------ meters
  meterLoop() {
    const toPos = (v) => Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-9) + 60) / 60));
    let clipHold = 0;
    const step = () => {
      const M = this.engine.meters, run = this.engine.running;
      const set = (m, v) => { m.v = Math.max(toPos(run ? v : 0), m.v - 0.025); m.bar.style.transform = `scaleY(${m.v})`; m.bar.classList.toggle('hot', m.v > 0.95); };
      set(this.inMeter, M.inPeak); set(this.outMeterL, M.outL); set(this.outMeterR, M.outR);
      if (run && M.inClip) { clipHold = 90; M.inClip = false; }
      if (clipHold > 0) clipHold--;
      this.clipLed.classList.toggle('on', clipHold > 0);
      const meas = M.loadPre !== null && M.loadPost !== null ? (M.loadPre + M.loadPost) : null;
      this.cpuEl.textContent = meas !== null ? `DSP ${Math.round(meas * 100)}%` : `DSP ≈${Math.round(this.cpuCost() / CPU_BUDGET * 100)}%`;
      this.cpuEl.classList.toggle('warn', (meas !== null ? meas : this.cpuCost() / CPU_BUDGET) > 0.8);
      // compressor gain-reduction readouts
      for (const [uid, gr] of Object.entries(M.gr || {})) { const el = this.tabBody.querySelector(`[data-uid="${uid}"] .led`); if (el) el.style.setProperty('--gr', String(Math.min(1, gr / 12))); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

const app = new PedalboardApp(document.getElementById('root'));
window.pedalboard = app; // handy for debugging in the console
app.boot().then(() => { window.__booted = true; }).catch((err) => {
  console.error(err);
  const el = document.getElementById('boot-error');
  el.hidden = false;
  el.innerHTML = '<h1>Worship Pedalboard failed to start</h1><pre></pre>';
  el.querySelector('pre').textContent = String(err && err.stack ? err.stack : err);
});
