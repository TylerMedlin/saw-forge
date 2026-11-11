// Application shell: layout, splitters, bottom panel tabs, status bar and dialogs.

import { h, drag, clamp, fmtTime } from './dom.js';
import { icon } from './icons.js';
import { dialog, toast, selectEl, NumberField } from './widgets.js';
import { Topbar } from './topbar.js';
import { BrowserPanel } from './browser.js';
import { Arrangement } from './arrangement.js';
import { Mixer } from './mixer.js';
import { PianoRoll } from './pianoroll.js';
import { SynthEditor } from './synth-editor.js';
import { WorshipEditor } from './worship-editor.js';
import { PianoEditor } from './piano-editor.js';
import { DrummerEditor } from './drummer-editor.js';
import { LiveView } from './live-view.js';
import { Devices } from './devices.js';
import { projectEndBeat } from '../core/project.js';
import { listDisk } from '../core/diskstore.js';

const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
// Autosaves newer than the saved project of the same name: unsaved work worth offering.
const pendingAutosaves = (disk) => (disk ? disk.autosaves.filter((a) => { const s = disk.saves.find((x) => x.name === a.name); return !s || a.modified > s.modified; }) : []);

const LS_LAYOUT = 'sawforge.layout.v1';

export class Shell {
  constructor(app) {
    this.app = app;
    let layout = { browserW: 236, panelH: 430, collapsed: false };
    try { layout = { ...layout, ...JSON.parse(localStorage.getItem(LS_LAYOUT) || '{}') }; } catch { /* default */ }
    this.layout = layout;

    this.topbar = new Topbar(app, this);
    this.browser = new BrowserPanel(app, this);
    this.arrange = new Arrangement(app, this);
    this.mixer = new Mixer(app, this);
    this.pianoroll = new PianoRoll(app, this);
    this.synth = new SynthEditor(app, this);
    this.worship = new WorshipEditor(app, this);
    this.drummer = new DrummerEditor(app, this);
    this.piano = new PianoEditor(app, this);
    this.live = new LiveView(app, this);
    // the instrument tab shows whichever instrument is being edited
    const inst = {
      el: h('div', { class: 'inst-panel' }, this.synth.el, this.worship.el, this.drummer.el, this.piano.el),
      refresh: (d) => {
        const wp = !!this.worship.pickTarget(), dr = !wp && !!this.drummer.pickTarget(), pn = !wp && !dr && !!this.piano.pickTarget();
        this.synth.el.style.display = wp || dr || pn ? 'none' : '';
        this.piano.el.style.display = pn ? '' : 'none';
        if (!pn) this.piano.trackId = null;
        this.worship.el.style.display = wp ? '' : 'none';
        this.drummer.el.style.display = dr ? '' : 'none';
        // a hidden editor forgets its target, so it re-points the engine's scope when it comes back
        if (!wp) this.worship.target = null;
        if (!dr) this.drummer.trackId = null;
        if (wp) this.worship.refresh(d); else if (dr) this.drummer.refresh(d); else if (pn) this.piano.refresh(d); else this.synth.refresh(d);
      },
      frame: (t) => {
        if (this.worship.el.style.display !== 'none') this.worship.frame(t);
        else if (this.drummer.el.style.display !== 'none') this.drummer.frame(t);
        else if (this.piano.el.style.display !== 'none') this.piano.frame(t);
        else this.synth.frame(t);
      },
    };
    this.inst = inst;
    this.devices = new Devices(app, this);
    this.tabs = [
      { id: 'mixer', label: 'Mixer', icon: 'mixer', comp: this.mixer, key: 'Alt+1' },
      { id: 'editor', label: 'Piano Roll', icon: 'roll', comp: this.pianoroll, key: 'Alt+2' },
      { id: 'synth', label: 'Instrument', icon: 'synth', comp: this.inst, key: 'Alt+3' },
      { id: 'fx', label: 'Effects', icon: 'fx', comp: this.devices, key: 'Alt+4' },
    ];
    this.tabBtns = this.tabs.map((t) => h('button', { class: 'ptab', title: `${t.label} (${t.key})`, onClick: () => { if (app.ui.tab === t.id && !this.layout.collapsed) this.toggleCollapse(); else { this.setCollapsed(false); app.setTab(t.id); } } }, icon(t.icon, 14), h('span', null, t.label)));
    this.tabBody = h('div', { class: 'panel-body' }, ...this.tabs.map((t) => h('div', { class: 'panel-page', dataset: { tab: t.id } }, t.comp.el)));
    this.collapseBtn = h('button', { class: 'ibtn sm', title: 'Collapse / expand panel', onClick: () => this.toggleCollapse() }, icon('chevron', 14));
    this.bottom = h('section', { class: 'bottom-panel' }, h('div', { class: 'panel-tabs' }, ...this.tabBtns, h('div', { class: 'tb-spacer' }), this.collapseBtn), this.tabBody);
    this.hsplit = h('div', { class: 'hsplit', title: 'Drag to resize · double-click to collapse' });
    this.vsplit = h('div', { class: 'vsplit', title: 'Drag to resize the browser' });
    this.mainCol = h('div', { class: 'main-col' }, this.live.el, this.arrange.el, this.hsplit, this.bottom);
    this.status = h('div', { class: 'status-left' });
    this.statusRight = h('div', { class: 'status-right' });
    this.statusbar = h('footer', { class: 'statusbar' }, this.status, h('div', { class: 'tb-spacer' }), this.statusRight);
    this.workspace = h('div', { class: 'workspace' }, this.browser.el, this.vsplit, this.mainCol);
    this.el = h('div', { class: 'app' }, this.topbar.el, this.workspace, this.statusbar);
    this.applyLayout();

    this.hsplit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const y0 = e.clientY, h0 = this.layout.collapsed ? 34 : this.layout.panelH;
      drag(e, { cursor: 'ns-resize', move: (ev) => { this.layout.collapsed = false; this.layout.panelH = clamp(h0 - (ev.clientY - y0), 120, window.innerHeight - 220); this.applyLayout(); }, up: () => this.saveLayout() });
    });
    this.hsplit.addEventListener('dblclick', () => this.toggleCollapse());
    this.vsplit.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const x0 = e.clientX, w0 = this.layout.browserW;
      drag(e, { cursor: 'ew-resize', move: (ev) => { this.layout.browserW = clamp(w0 + ev.clientX - x0, 0, 420); this.applyLayout(); }, up: () => this.saveLayout() });
    });
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest && e.target.closest('[title]');
      const txt = t ? t.getAttribute('title') : '';
      if (txt !== this.lastHint) { this.lastHint = txt; this.status.textContent = txt || this.defaultHint(); }
    });
    window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', (e) => { if (!e.defaultPrevented && e.dataTransfer?.files?.length) { e.preventDefault(); app.ensureAudio().then(() => app.importAudioFiles([...e.dataTransfer.files])); } });
    app.addEventListener('engine', () => this.renderStatusRight());
  }

  defaultHint() { return 'Space play/stop · R record · L loop · I punch · K metronome · ` computer keyboard · ? shortcuts'; }

  applyLayout() {
    const L = this.layout;
    this.browser.el.style.width = `${L.browserW}px`;
    this.browser.el.style.display = L.browserW < 40 ? 'none' : '';
    this.bottom.style.height = L.collapsed ? '34px' : `${L.panelH}px`;
    this.bottom.classList.toggle('collapsed', !!L.collapsed);
    this.collapseBtn.classList.toggle('flip', !L.collapsed);
  }
  saveLayout() { try { localStorage.setItem(LS_LAYOUT, JSON.stringify(this.layout)); } catch { /* ignore */ } }
  setCollapsed(c) { this.layout.collapsed = c; this.applyLayout(); this.saveLayout(); }
  toggleCollapse() { this.setCollapsed(!this.layout.collapsed); }

  activeComp() { return this.tabs.find((t) => t.id === this.app.ui.tab).comp; }

  refresh(d) {
    const app = this.app;
    if (d.scope === 'autowrite') { this.topbar.refresh(d); this.arrange.refresh(d); return; } // 30–60 updates/s while writing: keep it light
    this.topbar.refresh(d);
    this.browser.refresh(d);
    this.arrange.refresh(d);
    const liveOn = !!app.ui.live;
    this.live.el.style.display = liveOn ? '' : 'none';
    this.arrange.el.style.display = liveOn ? 'none' : '';
    if (liveOn) this.live.refresh(d);
    const tab = app.ui.tab;
    this.tabs.forEach((t, i) => {
      const on = t.id === tab;
      this.tabBtns[i].classList.toggle('on', on);
      this.tabBody.children[i].classList.toggle('on', on);
    });
    // keep all panels coherent; the active one gets everything, others catch up when shown
    if (tab !== this.lastTab) { this.lastTab = tab; this.activeComp().refresh({ scope: 'all' }); }
    else this.activeComp().refresh(d);
    this.renderStatusRight();
  }

  frame(t) {
    this.topbar.frame();
    if (this.app.ui.live) this.live.frame(); else this.arrange.frame();
    if (!this.layout.collapsed) this.activeComp().frame(t);
  }

  handleKey(e) {
    const app = this.app;
    if (app.ui.focus === 'editor' && app.ui.tab === 'editor' && !this.layout.collapsed) { if (this.pianoroll.onKey(e)) return true; }
    if (app.ui.focus === 'arrange') return this.arrange.onKey(e);
    return false;
  }

  renderStatusRight() {
    const app = this.app, e = app.engine, p = app.p;
    const end = projectEndBeat(p);
    const parts = [];
    if (app.ui.selClips.size) parts.push(`${app.ui.selClips.size} clip${app.ui.selClips.size > 1 ? 's' : ''} selected`);
    parts.push(`Length ${fmtTime((end * 60) / p.tempo).slice(0, 5)}`);
    if (e.state === 'running') parts.push(`${e.sampleRate} Hz · out ${(e.latency() * 1000).toFixed(1)} ms${e.shared ? ' · lock-free meters' : ''}`);
    else parts.push('Audio off');
    if (app.ui.kbd) parts.push(`⌨ C${app.ui.kbdOct} · vel ${Math.round(app.ui.kbdVel * 127)}`);
    this.statusRight.textContent = parts.join('   ·   ');
  }

  importAudio() {
    const inp = h('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac', style: { display: 'none' } });
    inp.multiple = true;
    inp.addEventListener('change', async () => {
      const files = [...inp.files]; inp.remove();
      if (!files.length) return;
      await this.app.ensureAudio();
      const sel = this.app.selectedTrack;
      await this.app.importAudioFiles(files, sel && sel.kind === 'audio' ? sel.id : null, this.app.ui.cursor);
    });
    document.body.append(inp); inp.click();
  }

  // ------------------------------------------------------------ welcome
  showWelcome(recovery, disk = null) {
    const app = this.app;
    const back = h('div', { class: 'welcome-back' });
    const close = () => back.remove();
    const start = async (fn) => {
      close();
      const ok = await app.ensureAudio();
      if (!ok) toast('Audio could not start — check your output device, then click the status pill in the top bar to retry.', 'error', 8000);
      await fn();
    };
    const card = (ic, title, sub, fn, primary) => h('button', { class: 'wl-card' + (primary ? ' primary' : ''), onClick: () => start(fn) }, h('div', { class: 'wl-ico' }, icon(ic, 20)), h('div', null, h('div', { class: 'wl-title' }, title), h('div', { class: 'wl-sub' }, sub)));
    const last = disk && disk.saves[0];
    const cards = [
      card('synth', 'Demo session', 'A 4-bar loop: supersaw chords, acid bass, arp, drums, reverb bus and automation', () => app.newProject('demo'), !last),
      card('plus', 'New project', 'One Saw Forge track, ready to play', () => app.newProject('empty')),
      card('folder', 'Open project…', disk ? 'From the saves folder, or browse for a file' : 'Load a .sfproj file', () => app.openProject()),
    ];
    if (last) cards.unshift(card('folder', `Continue “${last.name}”`, `Saved ${when(last.modified)} in the saves folder`, () => app.openSaved(last), true));
    // unsaved work: the newest autosave on disk, or the browser's own recovery copy if that is newer
    const auto = pendingAutosaves(disk)[0];
    if (auto && (!recovery || auto.modified >= recovery.time - 5000)) {
      cards.unshift(card('save', `Recover “${auto.name}”`, `Unsaved work autosaved ${when(auto.modified)}`, () => app.openSaved(auto, { autosave: true }), true));
    } else if (recovery && recovery.bytes) {
      cards.unshift(card('save', `Recover “${recovery.name}”`, `Unsaved work autosaved ${when(recovery.time)}`, () => app.recover(recovery), true));
    }
    const coi = globalThis.crossOriginIsolated;
    back.append(h('div', { class: 'welcome' },
      h('div', { class: 'wl-brand' }, h('div', { class: 'brand-mark big' }), h('div', null, h('div', { class: 'wl-name' }, 'SAW FORGE STUDIO'), h('div', { class: 'wl-tag' }, 'Arrange, sequence and sculpt sawtooth wavetables'))),
      h('div', { class: 'wl-cards' }, cards),
      h('div', { class: 'wl-foot' },
        h('span', null, 'Audio starts when you choose an option (browsers require a click before playing sound).'),
        coi ? null : h('span', { class: 'warn' }, ' Not cross-origin isolated: meters use a slower message path. Run serve.py for best results.'))));
    document.body.append(back);
  }

  // ------------------------------------------------------------ open from the saves folder
  async openSavedDialog() {
    const app = this.app;
    const disk = (await listDisk()) || app.disk;
    if (!disk) { app.openProjectFile(); return; }
    app.disk = disk;
    let dlg = null;
    const row = (e, autosave) => h('button', { class: 'sv-row', title: e.file, onClick: async () => { dlg.close(); await app.openSaved(e, { autosave }); } },
      h('span', { class: 'sv-name' }, e.name),
      h('span', { class: 'sv-meta' }, `${autosave ? 'unsaved work · ' : ''}${when(e.modified)} · ${size(e.size)}`));
    const autos = pendingAutosaves(disk);
    const body = h('div', { class: 'sv-list' },
      autos.length ? [h('div', { class: 'sv-head' }, 'Autosaved, not yet saved'), ...autos.map((e) => row(e, true))] : null,
      h('div', { class: 'sv-head' }, 'Saved projects'),
      disk.saves.length ? disk.saves.map((e) => row(e, false)) : h('div', { class: 'sv-empty' }, 'Nothing saved yet. Ctrl+S saves the current project here.'));
    dlg = dialog({ title: 'Open project', body, width: 500, className: 'sv-dialog',
      actions: [{ label: 'Browse for a file…', action: () => { setTimeout(() => app.openProjectFile(), 0); } }, { label: 'Cancel', value: null }] });
  }

  // ------------------------------------------------------------ export
  openExport() {
    const app = this.app, p = app.p;
    const range = selectEl([{ value: 'song', label: 'Whole arrangement' }, { value: 'loop', label: 'Loop region' }], p.loop.on ? 'loop' : 'song', () => {});
    const rate = selectEl([44100, 48000, 88200, 96000].map((r) => ({ value: r, label: `${r} Hz` })), app.engine.sampleRate === 44100 ? 44100 : 48000, () => {});
    const bits = selectEl([{ value: 16, label: '16-bit (dithered)' }, { value: 24, label: '24-bit' }, { value: 32, label: '32-bit float' }], 24, () => {});
    const tail = selectEl([0, 1, 2, 4, 8].map((s) => ({ value: s, label: s ? `${s} s tail` : 'No tail' })), 2, () => {});
    const bar = h('div', { class: 'progress-fill' });
    const prog = h('div', { class: 'progress' }, bar);
    const info = h('div', { class: 'export-info' }, 'Renders offline with the same engine used for playback (faster than real time).');
    let busy = false;
    const field = (label, el) => h('label', { class: 'field' }, h('span', null, label), el);
    const dlg = dialog({
      title: 'Export audio', width: 440,
      body: h('div', { class: 'export-form' }, field('Range', range), field('Sample rate', rate), field('Format', bits), field('Tail', tail), prog, info),
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Render WAV', primary: true, action: async () => {
          if (busy) return false;
          busy = true;
          info.textContent = 'Rendering…';
          try {
            const t0 = performance.now();
            const res = await app.exportAudio({ range: range.value, sampleRate: +rate.value, bitDepth: +bits.value, tail: +tail.value, onProgress: (f) => { bar.style.width = `${Math.round(f * 100)}%`; } });
            bar.style.width = '100%';
            const ms = performance.now() - t0;
            const st = res.stats;
            info.textContent = `Rendered ${res.seconds.toFixed(1)} s in ${(ms / 1000).toFixed(1)} s · peak ${st.peakDb.toFixed(1)} dBFS${st.clipped ? ` · ${st.clipped} clipped samples` : ''}`;
            const saved = await app.saveWav(res.wav, `${p.name}${range.value === 'loop' ? ' (loop)' : ''}`);
            if (saved) { toast(`Exported ${typeof saved === 'string' ? saved : 'WAV'} — peak ${st.peakDb.toFixed(1)} dBFS${st.clipped ? ' (clipping: lower the master)' : ''}`, st.clipped ? 'warn' : 'ok', 6000); dlg.close(); }
            busy = false;
            return false;
          } catch (err) { info.textContent = 'Export failed: ' + (err.message || err); busy = false; return false; }
        } },
      ],
    });
  }

  // ------------------------------------------------------------ settings
  async openSettings() {
    const app = this.app, e = app.engine, s = app.settings;
    const rate = selectEl([{ value: 0, label: 'Device default' }, ...[44100, 48000, 88200, 96000].map((r) => ({ value: r, label: `${r} Hz` }))], s.sampleRate || 0, () => {});
    const lat = selectEl([{ value: 'interactive', label: 'Lowest latency' }, { value: 'balanced', label: 'Balanced' }, { value: 'playback', label: 'Most stable (high latency)' }], s.latencyHint, () => {});
    const outs = await e.listOutputs();
    const canSink = e.ctx && typeof e.ctx.setSinkId === 'function';
    const out = selectEl([{ value: '', label: 'System default' }, ...outs.filter((o) => o.id !== 'default').map((o) => ({ value: o.id, label: o.label }))], s.sinkId || '', () => {});
    out.disabled = !canSink;
    const midiBtn = h('button', { class: 'btn', onClick: () => app.enableMidi() }, app.midiAccess ? `MIDI enabled (${app.midiAccess.inputs.size} inputs)` : 'Enable MIDI input');
    const state = e.state === 'running' ? `Running at ${e.sampleRate} Hz · base ${(e.ctx.baseLatency * 1000).toFixed(1)} ms · output ${((e.ctx.outputLatency || 0) * 1000).toFixed(1)} ms` : `Audio is ${e.state}${e.error ? ': ' + e.error : ''}`;
    const field = (label, el, note) => h('label', { class: 'field' }, h('span', null, label), el, note ? h('small', null, note) : null);

    // ---- audio input (recording)
    const ins = await app.input.listDevices();
    const inSel = selectEl([{ value: '', label: 'System default' }, ...ins.filter((o) => o.id !== 'default').map((o) => ({ value: o.id, label: o.label }))], s.inputDeviceId || '', async (v) => {
      app.saveSettings({ inputDeviceId: v });
      if (app.input.enabled) await app.enableInput(v);
      renderIn();
    });
    const inBtn = h('button', { class: 'btn' });
    const inState = h('small');
    const latInfo = h('div', { class: 'lat-info' });
    const autoBtn = h('button', { class: 'btn ghost sm', title: 'Forget the measured value and use the browser-reported latency', onClick: (ev) => { ev.preventDefault(); app.saveSettings({ recLatencyMs: null }); renderIn(); } }, 'Use estimate');
    const measureBtn = h('button', { class: 'btn' }, 'Measure');
    const offset = new NumberField({
      value: s.recOffsetMs || 0, min: -100, max: 100, step: 0.5, dragStep: 0.25, class: 'offset-field', title: 'Fine-tune recorded timing: positive moves takes earlier',
      format: (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' ms',
      onBegin: () => {}, onInput: (v) => { app.saveSettings({ recOffsetMs: v }); renderIn(); }, onEnd: () => {},
    });
    const renderIn = () => {
      const on = app.input.enabled;
      inBtn.textContent = on ? 'Disable input' : 'Enable input';
      const ch = app.input.channels || app.input.settings.channelCount;
      inState.textContent = on ? `${app.input.label}${ch ? ` · ${ch} ch` : ''}${app.input.inputLatency() ? ` · input path ${(app.input.inputLatency() * 1000).toFixed(1)} ms` : ''}`
        : 'Off. Arming an audio track or pressing Record asks for microphone permission.';
      const measured = typeof app.settings.recLatencyMs === 'number';
      const est = app.input.estimateRoundTrip() * 1000;
      const off = app.settings.recOffsetMs || 0;
      latInfo.textContent = `Takes shift earlier by ${app.recLatencyMs().toFixed(1)} ms (${measured ? `measured ${app.settings.recLatencyMs.toFixed(1)} ms` : `estimated ${est.toFixed(1)} ms`}${off ? `, ${off > 0 ? '+' : '−'}${Math.abs(off).toFixed(1)} ms adjust` : ''})`;
      autoBtn.style.display = measured ? '' : 'none';
      measureBtn.disabled = !on;
    };
    inBtn.addEventListener('click', async (ev) => { ev.preventDefault(); if (app.input.enabled) app.disableInput(); else await app.enableInput(inSel.value); renderIn(); });
    measureBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      measureBtn.disabled = true; measureBtn.textContent = 'Listening…';
      try {
        const r = await app.input.measureLatency();
        if (r.ok) { app.saveSettings({ recLatencyMs: r.ms }); toast(`Round-trip latency ${r.ms.toFixed(1)} ms (${r.detected} of ${r.clicks} clicks, spread ${r.spreadMs.toFixed(1)} ms)`, 'ok', 7000); }
        else toast('No clicks were heard. Point the speakers at the mic (or connect output to input with a loopback cable), raise the volume and try again.', 'warn', 9000);
      } catch (err) { toast(err.message || String(err), 'error', 6000); }
      measureBtn.textContent = 'Measure';
      renderIn();
    });
    renderIn();

    dialog({
      title: 'Audio & MIDI settings', width: 520,
      body: h('div', { class: 'settings-form' },
        h('div', { class: 'settings-state' }, state),
        field('Sample rate', rate, 'Changing it restarts the engine; wavetables and audio are re-prepared automatically.'),
        field('Buffering', lat),
        field('Output device', out, canSink ? null : 'Output selection needs Chrome/Edge 110+.'),
        field('MIDI', midiBtn, 'Note on/off, pitch bend, mod wheel (CC1) and sustain (CC64) go to armed or selected instrument tracks.'),
        h('div', { class: 'settings-section' }, 'Audio input (recording)'),
        field('Input device', inSel),
        h('div', { class: 'field' }, h('span', null, 'Input'), inBtn),
        h('div', { class: 'settings-inline' }, inState),
        h('div', { class: 'field' }, h('span', null, 'Latency'), h('div', { class: 'lat-row' }, measureBtn, autoBtn, h('span', { class: 'lat-adj' }, 'Adjust'), offset.el),
          h('small', null, 'Measure plays a few clicks and listens for them: point speakers at the mic or use a loopback cable.')),
        latInfo,
        h('div', { class: 'settings-note' }, 'Plugin hosting (VST3/AU) is not available in the browser; Saw Forge and the built-in effects run natively in the engine.')),
      actions: [
        { label: 'Close', value: null },
        { label: 'Restart audio', action: () => app.restartAudio({ sampleRate: +rate.value, latencyHint: lat.value, sinkId: out.value }) },
        { label: 'Apply', primary: true, action: () => app.restartAudio({ sampleRate: +rate.value, latencyHint: lat.value, sinkId: out.value }) },
      ],
    });
  }

  openShortcuts() {
    const rows = [
      ['Transport', [['Space', 'Play / stop'], ['Enter / Home', 'Return to start (or loop start)'], ['R', 'Record armed tracks — MIDI and audio (count-in when stopped)'], ['L', 'Loop on/off'], ['I', 'Punch in/out on/off (records only inside the red ruler range)'], ['P', 'Live Pad Mode (Worship Atmospheres) — ← → step songs, Enter goes, Esc closes'], ['K', 'Metronome'], ['W', 'Arm automation writing (Touch / Latch)'], ['M', 'Add marker at playhead']]],
      ['Editing', [['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Delete', 'Delete selection'], ['Ctrl+D', 'Duplicate'], ['Ctrl+C / Ctrl+V', 'Copy / paste'], ['Ctrl+E', 'Split clips at playhead'], ['Ctrl+A', 'Select all'], ['Ctrl+L', 'Loop selected clips'], ['Alt+drag', 'Duplicate while dragging / bypass snap'], ['Shift+drag', 'Fine adjustment on knobs and faders']]],
      ['Piano roll', [['B / V', 'Draw / select tool'], ['Q', 'Quantize (selection or all)'], ['↑ ↓ (Shift)', 'Transpose semitone (octave)'], ['← →', 'Nudge by grid'], ['Double-click', 'Delete note'], ['Ctrl+wheel / Alt+wheel', 'Zoom time / key height']]],
      ['Project', [['Ctrl+S / Ctrl+Shift+S', 'Save / save as'], ['Ctrl+O', 'Open'], ['Ctrl+Shift+E', 'Export WAV'], ['Ctrl+Alt+T / A / R', 'New instrument / audio track / return bus'], ['Alt+1…4', 'Mixer, piano roll, Saw Forge, effects']]],
      ['Playing', [['`', 'Computer keyboard as MIDI (A…L = notes)'], ['Z / X', 'Octave down / up'], ['C / V', 'Velocity down / up']]],
    ];
    dialog({
      title: 'Keyboard shortcuts', width: 640, className: 'shortcuts',
      body: h('div', { class: 'sc-grid' }, rows.map(([g, list]) => h('div', { class: 'sc-group' }, h('div', { class: 'sc-title' }, g), list.map(([k, d]) => h('div', { class: 'sc-row' }, h('kbd', null, k), h('span', null, d)))))),
      actions: [{ label: 'Close', primary: true }],
    });
  }
}
