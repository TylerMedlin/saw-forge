// Application controller: actions, engine synchronisation, transport,
// recording, live input, files and autosave. UI components call into this.

import { AudioEngine } from './audio/engine.js';
import { InputManager } from './audio/input.js';
import { AutomationRecorder } from './automation-recorder.js';
import { addTakeLanes, compRange, compLaneRange, laneUsage, remapTakeIds, COMP_XFADE_SEC } from './core/comp.js';
import { WP_DEF, VC, voiceChord, parseIntervals, worshipParamArray } from './shared/worship-params.js';
import { WORSHIP_PRESETS, worshipPresetByName, worshipPresetParams } from './shared/worship-presets.js';
import { planTake, extractRange, carveAudio, punchNotes, placePunchMidi } from './audio/recording.js';
import { encodeWav, audioStats } from './audio/wav.js';
import { factorySamples } from './audio/samples.js';
import { Store } from './core/store.js';
import { AssetManager } from './core/assets.js';
import { packProject, unpackProject, downloadBlob, safeFileName } from './core/fileio.js';
import { saveRecovery, loadRecovery, clearRecovery } from './core/recovery.js';
import { listDisk, writeDisk, deleteDisk, readDisk } from './core/diskstore.js';
import { DRUM_DEF, KIT_NAMES, kitIndex } from './shared/drums.js';
import { DRUMMERS, drummerById, newDrummerSettings, generateDrummer, newSeed } from './shared/drummers.js';
import {
  newWorshipInstrument, newSetlist, newSong, newDrumInstrument, newDrummerClip, isDrumTrack, clipFits,
  newProject, newTrack, newBus, newInsert, newMidiClip, newAudioClip, newLane, newSynthInstrument, normalizeProject,
  findChannel, findTrack, findClip, allChannels, cloneJSON, uid, barBeats, projectEndBeat, newNote,
} from './core/project.js';
import { SYNTH_DEF, EFFECT_DEFS, MIX_PARAMS, toNorm, faderDbToNorm, dbToGain } from './shared/params.js';
import { FACTORY_PRESETS } from './shared/presets.js';
import { wavetableHash } from './shared/wavetable.js';
import { buildDemoProject } from './demo.js';
import { toast, dialog, confirmDialog, promptText } from './ui/widgets.js';
import { h, isTextInput } from './ui/dom.js';
import { Shell } from './ui/shell.js';

const LS_PRESETS = 'sawforge.userPresets.v1';
// the drummer whose kit is each kit index (used when a new region starts on a drum track with no regions)
const DRUMMER_FOR_KIT = ['Festival', 'House', 'Techno', 'Trance', 'Future', 'Trap', 'Heavy', 'Breaks', 'Lo-Fi'].map((k) => (DRUMMERS.find((d) => d.kit === k) || DRUMMERS[0]).id);
const LS_SETTINGS = 'sawforge.settings.v1';
const KBD_MAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };

const readLS = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

export class App extends EventTarget {
  constructor(root) {
    super();
    this.root = root;
    this.engine = new AudioEngine();
    this.store = new Store(newProject());
    this.assets = new AssetManager(this.engine);
    this.input = new InputManager(this.engine);
    this.pendingStop = null;
    this.autoRec = new AutomationRecorder(this);
    this.factorySamples = factorySamples();
    this.userPresets = readLS(LS_PRESETS, []);
    this.settings = { sampleRate: 0, latencyHint: 'interactive', sinkId: '', inputDeviceId: '', recLatencyMs: null, recOffsetMs: 0, ...readLS(LS_SETTINGS, {}) };
    this.ui = {
      selTrack: null, selClips: new Set(), editClip: null, tab: 'synth', focus: 'arrange',
      cursor: 0, follow: true, snap: 'auto', kbd: false, kbdOct: 4, kbdVel: 0.8,
      wtOsc: 0, wtFrame: [0, 0], wtMode: 'shape',
      autoArm: false, autoMode: 'touch',
      audition: null, // { track, lane }: that track plays a take lane instead of its comp
      live: false, padEdit: false, // Live Pad view open; instrument panel edits the live pad
    };
    this.fileHandle = null;
    this.disk = null;      // file store offered by serve.py (saves/ next to the app), or null
    this.saveName = null;  // name of this project's file in saves/, once saved or opened from there
    this.autosaveTimer = 0; this.autosaveFails = 0;
    this.liveState = { playing: false, key: 7, minor: false, chord: null, bass: null, song: null, selSong: null };
    this.recording = null;
    this.kbdHeld = new Map();
    this.sustain = false; this.sustained = new Set();
    this.clipboard = null;
    this.syncPending = false; this.snapNext = new Set();
    this.tableTimer = 0;
    this.autosavedVersion = 0;
    this.lastPlayState = 0;
  }

  get p() { return this.store.p; }

  // ------------------------------------------------------------------ boot
  async boot() {
    this.shell = new Shell(this);
    this.root.append(this.shell.el);
    this.store.addEventListener('change', (e) => this.onChange(e.detail));
    this.store.addEventListener('history', () => this.emit('history'));
    this.engine.addEventListener('state', () => this.emit('engine'));
    this.engine.addEventListener('error', (e) => { toast(e.detail, 'error', 7000); this.emit('engine'); });
    this.engine.addEventListener('warning', (e) => toast(e.detail, 'warn', 5000));
    this.engine.addEventListener('recstarted', (e) => { if (this.recording && this.recording.audio.length) this.recording.audioStart = e.detail; });
    this.engine.addEventListener('recstopped', (e) => { const r = this.pendingStop; if (r && r.resolveStop) { this.pendingStop = null; r.resolveStop(e.detail); } });
    this.input.addEventListener('change', () => this.emit('input'));
    this.input.addEventListener('error', (e) => toast(e.detail, 'error', 6000));
    this.input.addEventListener('ended', () => {
      toast('The audio input was disconnected.', 'warn', 6000);
      if (this.recording && this.recording.audio.length) this.finishRecording();
      this.emit('input');
    });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.releaseKbd());
    window.addEventListener('beforeunload', (e) => {
      if (this.store.unsaved && this.p.tracks.length) { this.autosaveNow(); e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.autosaveNow(); });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this.onDeviceChange());
    }
    setInterval(() => this.autosaveNow(), 15000);
    this.shell.refresh({ scope: 'all' });
    requestAnimationFrame((t) => this.tick(t));
    const rec = await loadRecovery();
    this.disk = await listDisk();
    this.shell.showWelcome(rec, this.disk);
  }

  emit(what, detail) { this.dispatchEvent(new CustomEvent(what, { detail })); }
  uiChanged(what = 'ui') { this.shell.refresh({ scope: 'ui', what }); }

  async ensureAudio() {
    if (this.engine.state === 'running') return true;
    if (this.engine.ctx && this.engine.state === 'suspended') { await this.engine.resume(); return this.engine.state === 'running'; }
    if (this.engine.state === 'starting') return false;
    const ok = await this.engine.start(this.settings);
    if (!ok) return false;
    this.input.reattach();
    await this.assets.resyncEngine();
    this.syncNow(true);
    this.syncTables(true);
    this.emit('engine');
    return true;
  }

  async restartAudio(opts) {
    if (opts) { Object.assign(this.settings, opts); writeLS(LS_SETTINGS, this.settings); }
    this.stop();
    const ok = await this.engine.start(this.settings);
    if (ok) {
      this.input.reattach();
      await this.assets.resyncEngine();
      this.syncNow(true);
      this.syncTables(true);
      if (this.liveState.playing) { this.liveState.playing = false; this.liveStart(); } // the pad comes back on the new device
      toast(`Audio running at ${this.engine.sampleRate} Hz`, 'ok');
    }
    this.emit('engine');
    return ok;
  }

  async onDeviceChange() {
    if (!this.settings.sinkId || !this.engine.ctx) return;
    const outs = await this.engine.listOutputs();
    if (!outs.some((o) => o.id === this.settings.sinkId)) {
      toast('Selected audio output disconnected — switching to the system default.', 'warn', 5000);
      await this.restartAudio({ sinkId: '' });
    }
  }

  // ------------------------------------------------------------------ store → engine
  onChange(d) {
    const { scope, transient, reason } = d;
    if (reason) this.validateSelection();
    if (reason === 'undo' || reason === 'redo' || reason === 'load' || reason === 'cancel' || scope === 'inst') {
      for (const t of this.p.tracks) if (t.instrument && (scope !== 'inst' || t.id === d.id)) this.snapNext.add(t.id);
    }
    const fast = (transient && (scope === 'inst-param' || scope === 'mix-param' || scope === 'fx-param' || scope === 'live-param')) || scope === 'autowrite';
    if (!fast && scope !== 'project' && scope !== 'markers' && scope !== 'wt' && scope !== 'ui') this.scheduleSync();
    if (scope === 'wt' || scope === 'all' || scope === 'inst' || scope === 'tracks' || scope === 'live') this.scheduleTables(scope === 'wt' && transient ? 60 : 0);
    this.shell.refresh(d);
    if (!transient && scope !== 'ui') this.scheduleAutosave();
  }

  // Unsaved work goes to disk a few seconds after each edit (and every 15 s regardless).
  scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => this.autosaveNow(), 3000);
  }

  scheduleSync() {
    if (this.syncPending) return;
    this.syncPending = true;
    queueMicrotask(() => { this.syncPending = false; this.syncNow(false); });
  }
  syncNow() {
    if (!this.engine.node) return;
    const snap = this.snapNext.size ? new Set(this.snapNext) : null;
    this.snapNext.clear();
    this.engine.syncProject(this.p, snap, this.validAudition());
  }
  scheduleTables(delay = 0) {
    clearTimeout(this.tableTimer);
    this.tableTimer = setTimeout(() => this.syncTables(false), delay);
  }
  syncTables(force) {
    if (!this.engine.node) return;
    if (force) this.engine.sentTables.clear();
    const instOf = (id) => (id === 'livepad' ? this.p.live && this.p.live.patch : (findTrack(this.p, id) || {}).instrument);
    const list = this.p.tracks.filter((t) => t.instrument).map((t) => t.id);
    if (this.p.live) list.push('livepad');
    for (const id of list) {
      const inst = instOf(id);
      inst.wt.forEach((wt, osc) => {
        if (inst.type === 'worship' && inst.params[`o${osc + 1}.wave`] !== 6) return; // only slots set to Wavetable need one
        const key = wavetableHash(wt);
        if (this.engine.sentTables.get(id + ':' + osc) === key) return;
        this.engine.tables.build(wt).then(({ key: k, table }) => {
          const cur = instOf(id);
          if (!cur || !cur.wt[osc] || wavetableHash(cur.wt[osc]) !== k) return;
          this.engine.sendTable(id, osc, k, table);
        }).catch((err) => toast('Wavetable build failed: ' + err.message, 'error'));
      });
    }
  }

  validateSelection() {
    const ui = this.ui, p = this.p;
    if (ui.selTrack && !findChannel(p, ui.selTrack)) ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    for (const id of [...ui.selClips]) if (!findClip(p, id)) ui.selClips.delete(id);
    if (ui.editClip && !findClip(p, ui.editClip)) ui.editClip = null;
  }

  // ------------------------------------------------------------------ selection
  selectTrack(id, opts = {}) {
    if (this.ui.selTrack === id && !opts.force) return;
    this.ui.selTrack = id;
    const t = findTrack(this.p, id);
    if (!this.ui.live) this.ui.padEdit = false; // the instrument panel follows the selected track again
    if (opts.openInstrument && t && t.instrument) this.ui.tab = 'synth';
    this.uiChanged('track');
  }
  selectClips(ids, add = false) {
    if (!add) this.ui.selClips.clear();
    for (const id of ids) this.ui.selClips.add(id);
    this.uiChanged('clips');
  }
  editClip(id) {
    const f = findClip(this.p, id);
    if (!f) return;
    this.ui.editClip = id;
    this.ui.selTrack = f.track.id;
    if (f.clip.kind === 'midi') this.ui.tab = 'editor';
    else if (f.clip.kind === 'drummer') this.ui.tab = 'synth';
    this.uiChanged('edit');
  }
  setTab(tab) { this.ui.tab = tab; this.uiChanged('tab'); }
  get selectedTrack() { return findTrack(this.p, this.ui.selTrack); }
  get selectedChannel() { return findChannel(this.p, this.ui.selTrack) || this.p.master; }

  // ------------------------------------------------------------------ projects
  async newProject(kind = 'empty') {
    if (!(await this.confirmDiscard())) return false;
    this.stop();
    this.assets.clear();
    let p;
    if (kind === 'demo') p = await buildDemoProject(this);
    else {
      p = newProject('Untitled');
      const t = newTrack(p, 'instrument', { preset: FACTORY_PRESETS[0] });
      p.tracks.push(t);
    }
    this.fileHandle = null; this.saveName = null;
    this.store.replace(p);
    this.liveSync();
    this.ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    this.ui.selClips.clear(); this.ui.editClip = null; this.ui.cursor = 0;
    const firstMidi = p.tracks.find((t) => t.clips.some((c) => c.kind === 'midi'));
    if (firstMidi) this.ui.editClip = firstMidi.clips.find((c) => c.kind === 'midi').id;
    this.ui.tab = 'synth';
    this.uiChanged('project');
    await clearRecovery();
    this.autosavedVersion = this.store.version;
    return true;
  }

  async confirmDiscard() {
    if (!this.store.unsaved || !this.p.tracks.length) return true;
    return confirmDialog('Discard unsaved changes?', `“${this.p.name}” has unsaved changes. They will be lost.`, 'Discard', true);
  }

  // Open: the saves folder when the local server offers one, else a file picker.
  async openProject() {
    if (this.disk) { this.shell.openSavedDialog(); return; }
    await this.openProjectFile();
  }
  async openProjectFile() {
    if (!(await this.confirmDiscard())) return;
    try {
      let file, handle = null;
      if (window.showOpenFilePicker) {
        const [hnd] = await window.showOpenFilePicker({ types: [{ description: 'Saw Forge project', accept: { 'application/octet-stream': ['.sfproj'], 'application/json': ['.json'] } }] });
        handle = hnd; file = await hnd.getFile();
      } else {
        file = await pickFile('.sfproj,.json');
        if (!file) return;
      }
      await this.loadProjectBytes(await file.arrayBuffer(), file.name.replace(/\.(sfproj|json)$/i, ''), handle);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      toast('Could not open project: ' + (err.message || err), 'error', 6000);
    }
  }

  async openSaved(entry, { autosave = false } = {}) {
    if (!(await this.confirmDiscard())) return false;
    try {
      const buf = await readDisk(entry.file);
      await this.loadProjectBytes(buf, entry.name, null, { recovered: autosave, saveName: entry.name });
      return true;
    } catch (err) { toast(`Could not open “${entry.name}”: ${err.message || err}`, 'error', 7000); return false; }
  }

  async loadProjectBytes(buffer, fallbackName, handle = null, { recovered = false, saveName = null } = {}) {
    const { project, assetBytes, missing } = unpackProject(buffer);
    const p = normalizeProject(project);
    if (!project.name && fallbackName) p.name = fallbackName;
    this.stop();
    this.assets.clear();
    for (const a of p.assets) {
      const bytes = assetBytes.get(a.id);
      if (bytes) await this.assets.add({ id: a.id, name: a.name, bytes });
      else this.assets.addMissing(a.id, a.name);
    }
    this.fileHandle = handle; this.saveName = saveName;
    this.store.replace(p);
    if (recovered) this.store.version++; // keep it marked unsaved
    this.liveSync();
    this.ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    this.ui.selClips.clear(); this.ui.editClip = null; this.ui.cursor = 0;
    this.uiChanged('project');
    const bad = [...this.assets.items.values()].filter((a) => a.missing).map((a) => a.name);
    if (missing.length || bad.length) toast(`Opened with ${new Set([...missing, ...bad]).size} missing audio file(s); their clips are shown offline.`, 'warn', 7000);
    else toast(recovered ? 'Recovered unsaved session' : `Opened “${p.name}”`, 'ok');
  }

  async saveProject(saveAs = false) {
    if (this.disk) return this.saveToDisk(saveAs);
    const p = this.p;
    const bytes = packProject(p, this.assets.bytesMap());
    const name = safeFileName(p.name) + '.sfproj';
    try {
      if (window.showSaveFilePicker) {
        let handle = saveAs ? null : this.fileHandle;
        if (!handle) handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Saw Forge project', accept: { 'application/octet-stream': ['.sfproj'] } }] });
        const w = await handle.createWritable();
        await w.write(bytes); await w.close();
        this.fileHandle = handle;
        const base = handle.name.replace(/\.sfproj$/i, '');
        if (base && base !== p.name) this.store.do('Rename project', (q) => { q.name = base; }, 'project');
      } else downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), name);
      this.store.markSaved();
      this.autosavedVersion = this.store.version;
      await clearRecovery();
      this.emit('history');
      toast(`Saved “${this.p.name}” (${(bytes.length / 1024).toFixed(0)} KB)`, 'ok');
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
      toast('Save failed: ' + (err.message || err), 'error', 6000);
      return false;
    }
  }

  // Save into saves/ through the local server. The first save of a new project
  // asks before replacing a different project with the same name; every
  // replaced version is kept in saves/.history.
  async saveToDisk(saveAs = false) {
    let name = this.saveName;
    if (saveAs || !name) {
      name = this.p.name;
      if (saveAs || !name || name === 'Untitled') {
        name = await promptText(saveAs ? 'Save a copy as' : 'Save project', name || 'Untitled', 'Name');
        if (!name) return false;
      }
    }
    if (name !== this.p.name) this.store.do('Rename project', (q) => { q.name = name; }, 'project');
    const bytes = packProject(this.p, this.assets.bytesMap());
    try {
      let res = await writeDisk('project', name, bytes, { overwrite: !!this.saveName && name === this.saveName });
      if (res.exists) {
        const ok = await confirmDialog('Replace saved project?', `A project called “${res.name}” is already in the saves folder. Replace it? The old version is kept in saves/.history.`, 'Replace');
        if (!ok) return false;
        res = await writeDisk('project', name, bytes, { overwrite: true });
      }
      const oldAuto = this.saveName || this.p.name;
      this.saveName = res.name; this.fileHandle = null;
      this.store.markSaved();
      this.autosavedVersion = this.store.version;
      await clearRecovery();
      deleteDisk('autosave', res.name);
      if (oldAuto !== res.name) deleteDisk('autosave', oldAuto);
      this.emit('history');
      toast(`Saved to saves/${res.file.split('/').pop()} (${(bytes.length / 1024).toFixed(0)} KB)`, 'ok');
      return true;
    } catch (err) {
      toast('Save failed: ' + (err.message || err), 'error', 8000);
      return false;
    }
  }

  async autosaveNow() {
    if (!this.store.unsaved || this.store.version === this.autosavedVersion || !this.p.tracks.length) return;
    this.autosavedVersion = this.store.version;
    const bytes = packProject(this.p, this.assets.bytesMap());
    await saveRecovery(bytes, this.p.name);
    if (!this.disk) return;
    try { await writeDisk('autosave', this.saveName || this.p.name, bytes); this.autosaveFails = 0; }
    catch (err) { if (this.autosaveFails++ === 0) toast('Autosave to the saves folder failed: ' + (err.message || err), 'warn', 7000); }
  }

  async recover(rec) {
    await this.loadProjectBytes(rec.bytes.buffer || rec.bytes, rec.name, null, { recovered: true });
  }

  // ------------------------------------------------------------------ export
  async exportAudio({ range = 'song', sampleRate = 48000, bitDepth = 24, tail = 2, onProgress } = {}) {
    const p = this.p;
    let start = 0, end = projectEndBeat(p);
    if (range === 'loop') { start = p.loop.start; end = p.loop.end; }
    if (end <= start) throw new Error('Nothing to export — the arrangement is empty.');
    const used = new Set();
    for (const t of p.tracks) for (const c of t.clips) if (c.kind === 'audio') used.add(c.assetId);
    const assets = [...used].map((id) => this.assets.get(id)).filter((a) => a && a.bytes).map((a) => ({ id: a.id, bytes: a.bytes }));
    const wavetables = [];
    for (const t of p.tracks) if (t.instrument) t.instrument.wt.forEach((wt, osc) => wavetables.push({ ch: t.id, osc, wt }));
    const { buffer, missing } = await this.engine.renderOffline({ project: cloneJSON(p), assets, wavetables, startBeat: start, endBeat: end, sampleRate, tailSec: tail, onProgress });
    const ch = [buffer.getChannelData(0), buffer.getChannelData(1)];
    const stats = audioStats(ch);
    const wav = encodeWav(ch, sampleRate, bitDepth);
    return { wav, stats, missing, seconds: buffer.duration };
  }

  async saveWav(wav, name) {
    if (this.disk) return (await writeDisk('export', name, wav)).file; // e.g. "exports/Song.wav"
    const fname = safeFileName(name) + '.wav';
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: fname, types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
        const w = await handle.createWritable(); await w.write(wav); await w.close();
        return true;
      } catch (err) { if (err && err.name === 'AbortError') return false; throw err; }
    }
    downloadBlob(new Blob([wav], { type: 'audio/wav' }), fname);
    return true;
  }

  // ------------------------------------------------------------------ tracks & buses
  addInstrumentTrack(preset = null, at = null) {
    let id;
    this.store.do('Add instrument track', (p) => {
      const t = newTrack(p, 'instrument', { preset: preset || FACTORY_PRESETS[0] });
      if (preset) t.name = preset.name;
      id = t.id;
      if (at === null || at > p.tracks.length) p.tracks.push(t); else p.tracks.splice(at, 0, t);
    }, 'tracks');
    this.ui.selTrack = id; this.ui.tab = 'synth';
    this.uiChanged('track');
    return id;
  }
  addAudioTrack(at = null) {
    let id;
    this.store.do('Add audio track', (p) => {
      const t = newTrack(p, 'audio'); id = t.id;
      if (at === null || at > p.tracks.length) p.tracks.push(t); else p.tracks.splice(at, 0, t);
    }, 'tracks');
    this.ui.selTrack = id; this.uiChanged('track');
    return id;
  }
  addBus(withReverb = false) {
    let id;
    this.store.do('Add bus', (p) => {
      const b = newBus(p);
      if (withReverb) { b.name = 'Reverb Bus'; b.inserts.push(newInsert('reverb', { mix: 1 })); }
      id = b.id; p.buses.push(b);
    }, 'tracks');
    this.ui.selTrack = id; this.uiChanged('track');
    return id;
  }
  deleteChannel(id) {
    if (id === 'master') return;
    const ch = findChannel(this.p, id);
    if (!ch) return;
    this.store.do(`Delete ${ch.name}`, (p) => {
      p.tracks = p.tracks.filter((t) => t.id !== id);
      p.buses = p.buses.filter((b) => b.id !== id);
      for (const t of p.tracks) {
        t.sends = t.sends.filter((s) => s.busId !== id);
        if (t.output === id) t.output = 'master';
        t.automation = t.automation.filter((a) => a.target !== `mix:send:${id}`);
      }
    }, 'tracks');
    this.engine.forgetTables(id);
    this.validateSelection();
    this.uiChanged('track');
  }
  duplicateTrack(id) {
    const t = findTrack(this.p, id);
    if (!t) return;
    let nid;
    this.store.do(`Duplicate ${t.name}`, (p) => {
      const c = cloneJSON(t);
      c.id = uid('trk'); c.name = t.name + ' copy'; nid = c.id;
      c.clips.forEach((cl) => { cl.id = uid('clp'); });
      remapTakeIds(c);
      const remap = new Map();
      c.inserts.forEach((fx) => { const n = uid('fx'); remap.set(fx.id, n); fx.id = n; });
      c.automation.forEach((a) => {
        a.id = uid('aut');
        const m = a.target.match(/^fx:([^:]+):(.*)$/);
        if (m && remap.has(m[1])) a.target = `fx:${remap.get(m[1])}:${m[2]}`;
      });
      p.tracks.splice(p.tracks.indexOf(findTrack(p, id)) + 1, 0, c);
    }, 'tracks');
    this.ui.selTrack = nid; this.uiChanged('track');
  }
  renameChannel(id, name) {
    if (!name) return;
    this.store.do('Rename', (p) => { const c = findChannel(p, id); if (c) c.name = name; }, 'tracks');
  }
  async promptRename(id) {
    const c = findChannel(this.p, id);
    if (!c || id === 'master') return;
    const n = await promptText('Rename', c.name);
    if (n) this.renameChannel(id, n);
  }
  setChannel(id, key, value, label) {
    this.store.do(label || `Set ${key}`, (p) => { const c = findChannel(p, id); if (c) c[key] = value; }, key === 'color' || key === 'output' || key === 'showLanes' ? 'tracks' : 'mix', { id });
  }
  toggleChannel(id, key) {
    const c = findChannel(this.p, id);
    if (!c) return;
    const labels = { mute: 'Mute', solo: 'Solo', arm: 'Arm', monitor: 'Monitor' };
    this.setChannel(id, key, !c[key], `${c[key] ? 'Un' : ''}${labels[key] || key} ${c.name}`);
    // arming an audio track opens the input (this click is the permission gesture)
    if (key === 'arm' && !c.arm && c.kind === 'audio' && !this.input.enabled) this.enableInput();
  }
  setTrackInput(id, input) { this.setChannel(id, 'input', input, 'Change input'); }
  exclusiveSolo(id) {
    this.store.do('Solo exclusive', (p) => { for (const c of [...p.tracks, ...p.buses]) c.solo = c.id === id ? !c.solo : false; }, 'mix');
  }
  moveTrack(id, toIndex) {
    this.store.do('Move track', (p) => {
      const i = p.tracks.findIndex((t) => t.id === id);
      if (i < 0) return false;
      const [t] = p.tracks.splice(i, 1);
      p.tracks.splice(Math.max(0, Math.min(p.tracks.length, toIndex > i ? toIndex - 1 : toIndex)), 0, t);
    }, 'tracks');
  }

  // Mixer gestures (fast path to the engine while dragging)
  mixBegin(label) { this.store.begin(label); }
  mixLive(id, key, value, busId) {
    const ch = findChannel(this.p, id);
    if (!ch) return;
    const target = key === 'send' ? `mix:send:${busId}` : `mix:${key}`;
    const norm = key === 'pan' ? (value + 1) / 2 : faderDbToNorm(value);
    if (this.autoRec.capture(id, target, norm)) return;
    this.store.live((p) => {
      const c = findChannel(p, id);
      if (key === 'send') { const s = c.sends.find((x) => x.busId === busId); if (s) s.level = value; else c.sends.push({ busId, level: value, pre: false }); }
      else c[key] = value;
    }, 'mix-param', { id, key });
    const gain = key === 'vol' || key === 'send' ? (value <= -69.9 ? 0 : Math.pow(10, value / 20)) : value;
    if (key === 'vol') this.engine.setMix(id, 'gain', gain);
    else if (key === 'pan') this.engine.setMix(id, 'pan', value);
    else if (key === 'send') this.engine.setMix(id, 'send', gain, busId);
  }
  mixEnd() { this.autoRec.release(); this.store.end('mix'); this.autoRec.afterGesture(); }

  // ------------------------------------------------------------------ inserts
  addInsert(chId, type, index = null) {
    let fid;
    this.store.do(`Add ${EFFECT_DEFS[type].name}`, (p) => {
      const c = findChannel(p, chId);
      if (!c) return false;
      const fx = newInsert(type); fid = fx.id;
      if (index === null) c.inserts.push(fx); else c.inserts.splice(index, 0, fx);
    }, 'fx', { id: chId });
    this.ui.selTrack = chId; this.ui.tab = 'fx'; this.ui.selInsert = fid;
    this.uiChanged('fx');
  }
  removeInsert(chId, fxId) {
    this.store.do('Remove effect', (p) => {
      const c = findChannel(p, chId);
      c.inserts = c.inserts.filter((f) => f.id !== fxId);
      c.automation = c.automation.filter((a) => !a.target.startsWith(`fx:${fxId}:`));
    }, 'fx', { id: chId });
  }
  toggleBypass(chId, fxId) {
    this.store.do('Toggle bypass', (p) => { const f = findChannel(p, chId).inserts.find((x) => x.id === fxId); f.bypass = !f.bypass; }, 'fx', { id: chId });
  }
  moveInsert(chId, fxId, dir) {
    this.store.do('Move effect', (p) => {
      const list = findChannel(p, chId).inserts, i = list.findIndex((f) => f.id === fxId), j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return false;
      [list[i], list[j]] = [list[j], list[i]];
    }, 'fx', { id: chId });
  }
  fxBegin(label) { this.store.begin(label); }
  fxLive(chId, fxId, pid, value) {
    const ins = (findChannel(this.p, chId) || { inserts: [] }).inserts.find((x) => x.id === fxId);
    if (ins) {
      const def = EFFECT_DEFS[ins.type].params.find((d) => d.id === pid);
      if (def && def.automatable && this.autoRec.capture(chId, `fx:${fxId}:${pid}`, toNorm(def, value))) return;
    }
    let type = null;
    this.store.live((p) => { const f = findChannel(p, chId).inserts.find((x) => x.id === fxId); if (f) { f.params[pid] = value; type = f.type; } }, 'fx-param', { id: chId, fxId, pid });
    if (type) this.engine.setFxParam(chId, fxId, EFFECT_DEFS[type].params.findIndex((d) => d.id === pid), value);
  }
  fxEnd() { this.autoRec.release(); this.store.end('fx'); this.autoRec.afterGesture(); }

  // ------------------------------------------------------------------ instrument
  synthBegin(label) { this.store.begin(label); }
  synthLive(trackId, pid, value) {
    const def = SYNTH_DEF[pid];
    if (def && def.automatable && this.autoRec.capture(trackId, `inst:${pid}`, toNorm(def, value))) return;
    this.store.live((p) => { const t = findTrack(p, trackId); if (t && t.instrument) t.instrument.params[pid] = value; }, 'inst-param', { id: trackId, pid });
    this.engine.setInstParam(trackId, pid, value);
  }
  synthEnd() { this.autoRec.release(); this.store.end('inst-param'); this.autoRec.afterGesture(); }

  // ------------------------------------------------------------------ automation writing
  toggleAutoArm() {
    this.ui.autoArm = !this.ui.autoArm;
    if (!this.ui.autoArm) this.autoRec.finishAll();
    this.uiChanged('auto');
    toast(this.ui.autoArm ? `Automation armed (${this.ui.autoMode === 'latch' ? 'Latch' : 'Touch'}): move controls during playback to write` : 'Automation disarmed');
  }
  setAutoMode(mode) { this.ui.autoMode = mode === 'latch' ? 'latch' : 'touch'; this.uiChanged('auto'); }
  setSynthParam(trackId, pid, value) {
    this.store.do(`Set ${SYNTH_DEF[pid].name}`, (p) => { findTrack(p, trackId).instrument.params[pid] = value; }, 'inst-param', { id: trackId, pid });
  }

  loadPreset(trackId, preset) {
    const t = findTrack(this.p, trackId);
    if (!t || !t.instrument) return;
    this.store.do(`Load preset ${preset.name}`, (p) => {
      const tr = findTrack(p, trackId);
      tr.instrument = newSynthInstrument(preset);
      if (/^Saw Forge \d+$/.test(tr.name) || FACTORY_PRESETS.some((f) => f.name === tr.name) || this.userPresets.some((u) => u.name === tr.name)) tr.name = preset.name;
      tr.automation = tr.automation.filter((a) => !a.target.startsWith('inst:'));
    }, 'inst', { id: trackId });
    this.ui.wtFrame = [0, 0];
  }
  async savePreset(trackId) {
    const t = findTrack(this.p, trackId);
    if (!t || !t.instrument) return;
    const name = await promptText('Save preset', t.instrument.preset && t.instrument.preset !== 'Custom' ? t.instrument.preset : t.name, 'Preset name');
    if (!name) return;
    const preset = { name, category: 'User', params: { ...t.instrument.params }, wt: cloneJSON(t.instrument.wt) };
    this.userPresets = this.userPresets.filter((u) => u.name !== name).concat([preset]);
    writeLS(LS_PRESETS, this.userPresets);
    this.store.do('Name preset', (p) => { findTrack(p, trackId).instrument.preset = name; }, 'project');
    this.uiChanged('presets');
    toast(`Saved preset “${name}”`, 'ok');
  }
  deleteUserPreset(name) {
    this.userPresets = this.userPresets.filter((u) => u.name !== name);
    writeLS(LS_PRESETS, this.userPresets);
    this.uiChanged('presets');
  }
  allPresets() { return [...FACTORY_PRESETS, ...this.userPresets]; }

  // Wavetable edits: phase 'begin' | 'live' | 'end' | 'do'
  wtEdit(trackId, osc, fn, phase = 'do', label = 'Edit wavetable') {
    const apply = (p) => { const t = findTrack(p, trackId); if (t && t.instrument) { fn(t.instrument.wt[osc]); t.instrument.wt[osc].name = t.instrument.wt[osc].name.replace(/ \(edited\)$/, '') + ' (edited)'; } };
    if (phase === 'begin') { this.store.begin(label); this.store.live(apply, 'wt', { id: trackId, osc }); }
    else if (phase === 'live') this.store.live(apply, 'wt', { id: trackId, osc });
    else if (phase === 'end') { this.store.end('wt'); this.scheduleTables(0); }
    else this.store.do(label, apply, 'wt', { id: trackId, osc });
  }
  setWavetable(trackId, osc, wt) {
    this.store.do('Load wavetable', (p) => { findTrack(p, trackId).instrument.wt[osc] = cloneJSON(wt); }, 'wt', { id: trackId, osc });
    this.ui.wtFrame[osc] = 0;
  }

  // ------------------------------------------------------------------ clips
  createMidiClip(trackId, start, length) {
    let id;
    this.store.do('Create MIDI clip', (p) => {
      const t = findTrack(p, trackId);
      if (!t || t.kind !== 'instrument') return false;
      const c = newMidiClip(start, length, [], t.name);
      id = c.id; t.clips.push(c);
    }, 'clips');
    if (id) { this.selectClips([id]); this.editClip(id); }
    return id;
  }
  deleteClips(ids) {
    if (!ids.length) return;
    this.store.do(ids.length > 1 ? `Delete ${ids.length} clips` : 'Delete clip', (p) => {
      const set = new Set(ids);
      for (const t of p.tracks) t.clips = t.clips.filter((c) => !set.has(c.id));
    }, 'clips');
    this.ui.selClips.clear(); this.validateSelection(); this.uiChanged('clips');
  }
  duplicateClips(ids) {
    if (!ids.length) return;
    const found = ids.map((id) => findClip(this.p, id)).filter(Boolean);
    const minS = Math.min(...found.map((f) => f.clip.start)), maxE = Math.max(...found.map((f) => f.clip.start + f.clip.length));
    const bar = barBeats(this.p), span = Math.ceil((maxE - minS) / bar - 1e-6) * bar || bar;
    const created = [];
    this.store.do('Duplicate clips', (p) => {
      for (const f of found) {
        const t = findTrack(p, f.track.id);
        const c = cloneJSON(f.clip); c.id = uid('clp'); c.start += span;
        t.clips.push(c); created.push(c.id);
      }
    }, 'clips');
    this.selectClips(created);
  }
  splitClips(ids, beat) {
    const created = [];
    this.store.do('Split clips', (p) => {
      for (const id of ids) {
        const f = findClip(p, id);
        if (!f) continue;
        const c = f.clip;
        if (beat <= c.start + 1e-6 || beat >= c.start + c.length - 1e-6) continue;
        const right = cloneJSON(c); right.id = uid('clp');
        const cut = beat - c.start;
        c.length = cut;
        right.start = beat; right.length -= cut;
        if (c.kind === 'midi') right.offset = (c.offset || 0) + cut;
        else if (c.kind === 'drummer') { right.offset = 0; right.dr = { ...cloneJSON(c.dr), seed: newSeed() }; }
        else { right.offset = (c.offset || 0) + (cut * 60) / p.tempo; right.fadeIn = 0; c.fadeOut = 0; }
        f.track.clips.push(right); created.push(right.id);
      }
      if (!created.length) return false;
    }, 'clips');
    if (created.length) this.selectClips([...ids, ...created]);
  }
  copyClips(ids) {
    const found = ids.map((id) => findClip(this.p, id)).filter(Boolean);
    if (!found.length) return;
    const minS = Math.min(...found.map((f) => f.clip.start));
    const ti = (id) => this.p.tracks.findIndex((t) => t.id === id);
    const baseT = Math.min(...found.map((f) => ti(f.track.id)));
    this.clipboard = { type: 'clips', items: found.map((f) => ({ dt: ti(f.track.id) - baseT, clip: cloneJSON({ ...f.clip, start: f.clip.start - minS }) })) };
    toast(`Copied ${found.length} clip${found.length > 1 ? 's' : ''}`);
  }
  pasteClips() {
    if (!this.clipboard || this.clipboard.type !== 'clips') return;
    const base = Math.max(0, this.p.tracks.findIndex((t) => t.id === this.ui.selTrack));
    const created = [];
    this.store.do('Paste clips', (p) => {
      for (const it of this.clipboard.items) {
        const t = p.tracks[base + it.dt];
        if (!clipFits(t, it.clip)) continue;
        const c = cloneJSON(it.clip); c.id = uid('clp'); c.start += this.ui.cursor;
        t.clips.push(c); created.push(c.id);
      }
      if (!created.length) return false;
    }, 'clips');
    if (created.length) this.selectClips(created); else toast('Nothing to paste here — select a matching track.');
  }

  // ------------------------------------------------------------------ audio import
  async importAudioFiles(files, trackId = null, beat = null) {
    let tid = trackId;
    let pos = beat ?? this.ui.cursor;
    for (const file of files) {
      if (!/^audio\//.test(file.type) && !/\.(wav|aif|aiff|mp3|ogg|flac|m4a)$/i.test(file.name)) { toast(`Skipped ${file.name}: not an audio file`, 'warn'); continue; }
      const bytes = await file.arrayBuffer();
      const id = uid('ast');
      const item = await this.assets.add({ id, name: file.name.replace(/\.[^.]+$/, ''), bytes });
      if (item.missing) { toast(`Could not decode ${file.name}`, 'error'); continue; }
      const len = await this.placeAsset(item, tid, pos);
      tid = len.trackId; pos += len.length;
    }
  }
  async addFactorySample(sample, trackId, beat) {
    let item = this.assets.get(sample.id);
    if (!item || !item.buffer) item = await this.assets.add({ id: sample.id, name: sample.name, bytes: sample.bytes, factory: true });
    return this.placeAsset(item, trackId, beat);
  }
  async placeAsset(item, trackId, beat) {
    if (this.engine.ctx && item.buffer) await this.engine.sendAsset(item.id, item.buffer);
    let tid = trackId;
    const t = tid ? findTrack(this.p, tid) : null;
    const length = Math.max(0.0625, (item.duration * this.p.tempo) / 60);
    this.store.do(`Add audio ${item.name}`, (p) => {
      if (!p.assets.some((a) => a.id === item.id)) p.assets.push({ id: item.id, name: item.name, duration: item.duration, factory: !!item.factory });
      let tr = t && t.kind === 'audio' ? findTrack(p, t.id) : null;
      if (!tr) { tr = newTrack(p, 'audio', { name: item.name }); p.tracks.push(tr); }
      tid = tr.id;
      tr.clips.push(newAudioClip(item, Math.max(0, beat), length, item.name));
    }, 'clips');
    this.ui.selTrack = tid; this.uiChanged('track');
    return { trackId: tid, length };
  }

  // ------------------------------------------------------------------ automation
  showLane(chId, target) {
    this.store.do('Show automation', (p) => {
      const c = findChannel(p, chId);
      if (!c) return false;
      c.showLanes = true;
      if (!c.automation.some((a) => a.target === target)) c.automation.push(newLane(target));
    }, 'auto', { id: chId });
  }
  clearLane(chId, target) {
    this.store.do('Clear automation', (p) => {
      const c = findChannel(p, chId);
      const l = c && c.automation.find((a) => a.target === target);
      if (!l) return false;
      l.points = [];
    }, 'auto', { id: chId });
  }
  removeLane(chId, laneId) {
    this.store.do('Remove automation lane', (p) => { const c = findChannel(p, chId); c.automation = c.automation.filter((a) => a.id !== laneId); }, 'auto', { id: chId });
  }
  hasAutomation(chId, target) {
    const c = findChannel(this.p, chId);
    const l = c && c.automation.find((a) => a.target === target);
    return !!(l && l.points.length);
  }
  laneMenuItems(chId, target, resetFn) {
    const has = this.hasAutomation(chId, target);
    return [
      { label: 'Show automation lane', action: () => this.showLane(chId, target) },
      { label: 'Clear automation', disabled: !has, action: () => this.clearLane(chId, target) },
      resetFn ? { sep: true } : null,
      resetFn ? { label: 'Reset to default', action: resetFn } : null,
    ];
  }

  // ------------------------------------------------------------------ markers
  addMarker(beat) {
    const n = this.p.markers.length + 1;
    this.store.do('Add marker', (p) => { p.markers.push({ id: uid('mrk'), beat, name: `Marker ${n}` }); p.markers.sort((a, b) => a.beat - b.beat); }, 'markers');
  }

  // ------------------------------------------------------------------ transport
  get playState() { return this.engine.playState; }
  get isPlaying() { return this.engine.playState !== 0; }
  async togglePlay() { if (this.isPlaying) this.stop(); else await this.play(); }
  async play(from = null) {
    if (!(await this.ensureAudio())) return;
    this.syncNow();
    const beat = from ?? this.ui.cursor;
    this.engine.play(beat, 0);
    this.engine.status[0] = beat; this.engine.status[1] = 1;
    this.emit('transport');
  }
  stop() {
    this.autoRec.finishAll();
    if (this.recording) this.finishRecording();
    if (this.engine.node) this.engine.stop();
    this.releaseKbd();
    if (this.engine.playState !== 0) {
      const pos = this.engine.position;
      if (Number.isFinite(pos)) this.ui.cursor = this.p.loop.on && pos >= this.p.loop.end ? this.p.loop.start : pos;
    }
    this.engine.status[1] = 0;
    this.emit('transport');
    this.uiChanged('cursor');
  }
  returnToStart() {
    const target = this.p.loop.on && this.ui.cursor > this.p.loop.start + 1e-6 ? this.p.loop.start : 0;
    this.locate(target);
  }
  locate(beat) {
    beat = Math.max(0, beat);
    this.ui.cursor = beat;
    if (this.engine.node) this.engine.locate(beat);
    this.engine.status[0] = beat;
    this.uiChanged('cursor');
  }
  setTempo(v, phase = 'do') {
    v = Math.min(999, Math.max(20, v));
    if (phase === 'begin') this.store.begin('Change tempo');
    if (phase === 'live' || phase === 'begin') this.store.live((p) => { p.tempo = v; }, 'transport');
    else if (phase === 'end') this.store.end('transport');
    else this.store.do('Change tempo', (p) => { p.tempo = v; }, 'transport');
  }
  setSignature(num, den) { this.store.do('Change time signature', (p) => { p.sigNum = num; p.sigDen = den; }, 'transport'); }
  toggleLoop() { this.store.do(this.p.loop.on ? 'Loop off' : 'Loop on', (p) => { p.loop.on = !p.loop.on; }, 'transport'); }
  setLoop(start, end) {
    if (end - start < 0.25) return;
    this.store.do('Set loop', (p) => { p.loop.start = Math.max(0, start); p.loop.end = end; p.loop.on = true; }, 'transport');
  }
  toggleMetronome() { this.store.do('Metronome', (p) => { p.metronome.on = !p.metronome.on; }, 'transport'); }
  setCountIn(bars) { this.store.do('Count-in', (p) => { p.metronome.countIn = bars; }, 'transport'); }

  // ------------------------------------------------------------------ punch in/out
  togglePunch() {
    const on = !this.p.punch.on;
    this.store.do(on ? 'Punch on' : 'Punch off', (p) => {
      const P = p.punch;
      if (on && !P.set) {
        // first use: start from the loop range, or the two bars at the playhead
        const bar = barBeats(p);
        if (p.loop.on && p.loop.end > p.loop.start) { P.start = p.loop.start; P.end = p.loop.end; }
        else { P.start = Math.floor(this.ui.cursor / bar) * bar; P.end = P.start + 2 * bar; }
        P.set = true;
      }
      P.on = on;
    }, 'transport');
    if (on) toast('Punch on: recording keeps only what falls inside the red range in the ruler');
  }
  setPunch(start, end) {
    if (end - start < 0.25) return;
    this.store.do('Set punch range', (p) => { Object.assign(p.punch, { start: Math.max(0, start), end, on: true, set: true }); }, 'transport');
  }
  setPreRoll(bars) { this.store.do('Pre-roll', (p) => { p.punch.preRoll = bars; }, 'transport'); }
  // Where playback starts when recording from stop with punch on.
  punchStart(punch) {
    const p = this.p, bar = barBeats(p), pre = p.punch.preRoll, cur = this.ui.cursor, L = p.loop;
    if (pre === 0) return { from: punch.start, preRoll: false };
    if (pre === -1) {
      const reaches = cur < punch.end - 1e-6 || (L.on && cur < L.end && punch.start >= L.start && punch.start < L.end);
      if (reaches) return { from: cur, preRoll: false };
      toast('The playhead is past the punch range — starting 1 bar before the punch-in.');
    }
    return { from: Math.max(0, punch.start - Math.max(1, pre) * bar), preRoll: true };
  }

  // ------------------------------------------------------------------ recording (MIDI + audio)
  liveTargets() {
    const armed = this.p.tracks.filter((t) => t.arm && t.kind === 'instrument');
    if (armed.length) return armed;
    const sel = this.selectedTrack;
    return sel && sel.kind === 'instrument' ? [sel] : [];
  }
  // Armed tracks record; with nothing armed, the selected track does.
  recordTargets() {
    const armed = this.p.tracks.filter((t) => t.arm);
    if (armed.length) return armed;
    const sel = this.selectedTrack;
    return sel ? [sel] : [];
  }
  async toggleRecord() {
    if (this.recording) { this.finishRecording(); this.emit('transport'); return; }
    const targets = this.recordTargets();
    const midi = targets.filter((t) => t.kind === 'instrument'), audio = targets.filter((t) => t.kind === 'audio');
    if (!midi.length && !audio.length) { toast('Arm a track (R) or select one to record.', 'warn'); return; }
    if (!(await this.ensureAudio())) return;
    if (audio.length && !this.input.enabled && !(await this.enableInput())) return;
    const P = this.p.punch, punch = P.on ? { on: true, start: P.start, end: P.end } : null;
    this.recording = {
      tracks: midi.map((t) => t.id), audio: audio.map((t) => t.id), notes: [], open: new Map(),
      started: false, startBeat: this.ui.cursor, loop: { ...this.p.loop }, audioStart: null, punch,
    };
    if (audio.length) {
      this.input.dropped = 0;
      this.input.beginCollect();
      this.engine.post({ type: 'rec', on: true }); // the engine marks the exact start sample when playback begins
    }
    const takeMsg = () => this.engine.post({ type: 'take', on: true, audio: this.recording.audio, midi: punch ? this.recording.tracks : [], punch });
    if (!this.isPlaying) {
      this.syncNow();
      takeMsg();
      let from = this.ui.cursor, countIn = (this.p.metronome.countIn || 0) * barBeats(this.p);
      if (punch) { const st = this.punchStart(punch); from = st.from; if (st.preRoll) countIn = 0; } // the pre-roll is the cue
      this.recording.startBeat = from;
      this.engine.play(from, countIn);
      this.engine.status[0] = from; this.engine.status[1] = countIn > 0 ? 2 : 1;
      if (countIn > 0 && !this.p.metronome.on) toast('Count-in…');
    } else {
      takeMsg();
      this.recording.started = true; this.recording.startBeat = this.engine.position;
      if (punch && this.engine.position >= punch.end && !(this.p.loop.on && this.engine.position < this.p.loop.end)) toast('The playhead is past the punch range — nothing will be recorded until it returns.', 'warn');
    }
    this.emit('transport');
  }
  recBeat() {
    let b = this.engine.heardBeat(this.p.tempo);
    const L = this.p.loop;
    if (L.on && this.recording && this.recording.startBeat < L.end) {
      if (b >= L.end) b = L.start + ((b - L.start) % (L.end - L.start));
      if (b < L.start && this.recording.startBeat >= L.start) b = L.end - (L.start - b);
    }
    return Math.max(0, b);
  }
  finishRecording() {
    const rec = this.recording;
    this.recording = null;
    if (!rec) return;
    this.engine.post({ type: 'take', on: false });
    if (rec.audio.length) {
      // ask the engine where the take ends; it answers with the exact ring positions
      const stopped = new Promise((resolve) => { rec.resolveStop = resolve; setTimeout(() => resolve(null), 1500); });
      this.pendingStop = rec;
      this.engine.post({ type: 'rec', on: false });
      this.commitAudio(rec, stopped).catch((err) => toast('Could not save the recording: ' + (err.message || err), 'error', 7000));
    }
    if (rec.tracks.length && rec.started) this.commitMidi(rec);
  }
  commitMidi(rec) {
    const endBeat = this.recBeat();
    for (const [, n] of rec.open) rec.notes.push({ ...n, e: endBeat });
    if (!rec.notes.length) { if (!rec.audio.length) toast('Nothing recorded'); return; }
    const L = this.p.loop, loopRec = L.on && rec.startBeat >= L.start - 1e-6 && rec.startBeat < L.end;
    const wrapRec = L.on && rec.startBeat < L.end; // recBeat wraps note times at the loop end
    const bar = barBeats(this.p);
    const notes = rec.notes.map((n) => {
      let e = n.e;
      if (wrapRec && e < n.s) e = L.end;
      return { p: n.p, s: n.s, l: Math.max(0.03, e - n.s), v: n.v };
    });
    if (rec.punch) { this.commitPunchMidi(rec, notes); return; }
    const rs = loopRec ? L.start : Math.floor(Math.min(...notes.map((n) => n.s)) / bar) * bar;
    const re = loopRec ? L.end : Math.ceil(Math.max(...notes.map((n) => n.s + n.l)) / bar) * bar;
    this.store.do('Record MIDI', (p) => {
      for (const tid of rec.tracks) {
        const t = findTrack(p, tid);
        if (!t) continue;
        let clip = t.clips.find((c) => c.kind === 'midi' && c.start <= rs + 1e-6 && c.start + c.length >= re - 1e-6);
        if (!clip) { clip = newMidiClip(rs, Math.max(bar, re - rs), [], `${t.name} rec`); t.clips.push(clip); }
        const Lc = clip.loopLen || clip.length;
        for (const n of notes) {
          let s = n.s - clip.start + (clip.offset || 0);
          s = ((s % Lc) + Lc) % Lc;
          clip.notes.push({ p: n.p, s, l: Math.min(n.l, Lc), v: n.v });
        }
        this.ui.editClip = clip.id;
      }
    }, 'clips');
    toast(`Recorded ${notes.length} note${notes.length > 1 ? 's' : ''}`, 'ok');
    this.uiChanged('edit');
  }
  // Punch MIDI take: keep what was played inside the range; it replaces the notes there.
  commitPunchMidi(rec, notes) {
    const P = rec.punch, take = punchNotes(notes, P.start, P.end);
    if (!take.length) { if (!rec.audio.length) toast('Nothing was played inside the punch range.', 'warn'); return; }
    this.store.do('Record MIDI (punch)', (p) => {
      for (const tid of rec.tracks) {
        const t = findTrack(p, tid);
        if (!t) continue;
        const clip = placePunchMidi(t, take, P.start, P.end, () => newMidiClip(P.start, P.end - P.start, [], `${t.name} punch`));
        this.ui.editClip = clip.id;
      }
    }, 'clips');
    toast(`Punched in ${take.length} note${take.length > 1 ? 's' : ''}`, 'ok');
    this.uiChanged('edit');
  }
  async commitAudio(rec, stoppedP) {
    const stopped = await stoppedP;
    const c = this.input.endCollect();
    if (!stopped || !stopped.started || !c) { toast('Audio recording stopped before it began.', 'warn'); return; }
    const sr = this.engine.sampleRate, tempo = this.p.tempo, spb = (sr * 60) / tempo;
    const recorded = (stopped.index - stopped.startIndex) >>> 0;
    const xfade = rec.punch ? (0.01 * tempo) / 60 : 0; // 10 ms crossfades at the punch points
    const plan = planTake({ recorded, latency: this.recLatencyFrames(), startBeat: stopped.startBeat, spb, loop: rec.loop, punch: rec.punch, xfade });
    if (!plan) { toast(rec.punch ? 'Nothing was recorded inside the punch range.' : 'Recording too short — nothing kept.', 'warn'); return; }
    // every complete pass becomes a take (plus partial passes covering at least half the window)
    const keep = plan.takes.filter((tk) => tk.full || tk.cover >= 0.5 || tk.pass === plan.pass);
    // a punch take keeps 2 s of audio either side (room to adjust the edits), not the whole pre-roll
    let from = 0, to = recorded;
    if (rec.punch) {
      const hd = Math.round(sr * 2);
      from = Math.max(0, Math.min(...keep.map((tk) => tk.offsetFrames)) - hd);
      to = Math.min(recorded, Math.max(...keep.map((tk) => tk.offsetFrames + Math.ceil(tk.length * spb))) + hd);
    }
    const [L, R] = extractRange(c, (stopped.startIndex + from) >>> 0, (stopped.startIndex + to) >>> 0);
    const mono = this.input.channels <= 1;
    const takes = [];
    for (const tid of rec.audio) {
      const t = findTrack(this.p, tid);
      if (!t) continue;
      const mode = mono ? 'L' : t.input || 'stereo';
      const chans = mode === 'stereo' ? [L.slice(), R.slice()] : [(mode === 'R' ? R : L).slice()];
      const n = this.p.assets.filter((a) => a.recorded && a.trackId === tid).length + 1;
      const item = await this.assets.addPcm({ id: uid('rec'), name: `${t.name} recording ${n}`, channels: chans, sampleRate: sr });
      takes.push({ tid, item });
    }
    this.store.do('Record audio', (p) => {
      for (const { tid, item } of takes) {
        const t = findTrack(p, tid);
        if (!t) continue;
        p.assets.push({ id: item.id, name: item.name, duration: item.duration, recorded: true, trackId: tid });
        // every take goes into its own lane; the chosen one also goes into the comp, replacing what it covers
        const clips = keep.map((tk) => {
          const clip = newAudioClip(item, tk.start, tk.length, item.name);
          clip.offset = (tk.offsetFrames - from) / sr; clip.fadeIn = tk.xIn; clip.fadeOut = tk.xOut;
          return clip;
        });
        const hadTwo = t.takeLanes.length >= 2;
        const lanes = addTakeLanes(t, clips);
        const lane = lanes[Math.max(0, keep.findIndex((tk) => tk.pass === plan.pass))];
        compRange(t, lane, lane.clips[0], plan.carveStart, plan.carveEnd, p.tempo, xfade);
        if (!hadTwo && t.takeLanes.length >= 2) t.showTakes = true; // comping just became possible: show the lanes
      }
    }, 'clips');
    const secs = ((plan.length * 60) / tempo).toFixed(1);
    toast(`${rec.punch ? 'Punched in' : 'Recorded'} ${secs} s of audio${keep.length > 1 ? ` — ${keep.length} takes in the take lanes, pass ${plan.pass} in use` : ''}${this.input.dropped ? ' — some input was lost while the page was busy' : ''}`, 'ok', 5000);
  }

  // ------------------------------------------------------------------ Worship Atmospheres (tracks and the live pad)
  // chId is a track id or 'livepad'.
  padInst(chId) { return chId === 'livepad' ? this.p.live && this.p.live.patch : ((findTrack(this.p, chId) || {}).instrument || null); }
  padMutate(p, chId, fn) { const inst = chId === 'livepad' ? p.live.patch : findTrack(p, chId).instrument; if (inst) fn(inst); }
  padBegin(chId, label) { this.padGesture = chId; this.store.begin(label); }
  padLive(chId, pid, value) {
    const def = WP_DEF[pid];
    if (chId !== 'livepad' && def && def.automatable && this.autoRec.capture(chId, `inst:${pid}`, toNorm(def, value))) return;
    this.store.live((p) => this.padMutate(p, chId, (i) => { i.params[pid] = value; }), chId === 'livepad' ? 'live-param' : 'inst-param', { id: chId, pid });
    this.engine.setWorshipParam(chId, pid, value);
  }
  padEnd() {
    const chId = this.padGesture;
    this.autoRec.release();
    this.store.end(chId === 'livepad' ? 'live' : 'inst-param');
    this.autoRec.afterGesture();
  }
  setPadParam(chId, pid, value) {
    const def = WP_DEF[pid];
    this.store.do(`Set ${def ? def.name : pid}`, (p) => this.padMutate(p, chId, (i) => { i.params[pid] = value; }), chId === 'livepad' ? 'live' : 'inst-param', { id: chId, pid });
    if (/\.wave$/.test(pid)) this.scheduleTables(0);
    if (chId === 'livepad' && /^vc\./.test(pid) && this.liveState.playing) this.liveRevoice({ mode: 'gentle', time: Math.min(3, this.p.live.transTime) });
  }
  setPadCustom(chId, text) {
    this.store.do('Custom voicing', (p) => this.padMutate(p, chId, (i) => { i.custom = text; }), chId === 'livepad' ? 'live' : 'inst');
    if (chId === 'livepad' && this.liveState.playing) this.liveRevoice({ mode: 'gentle', time: 2 });
  }
  // Load a factory preset. On the live pad it crossfades; the key never changes.
  loadPadPreset(chId, name) {
    const preset = worshipPresetByName(name);
    if (!preset) return;
    const params = worshipPresetParams(preset);
    const cur = this.padInst(chId);
    if (chId === 'livepad') {
      const L = this.p.live;
      if (L.keepVoicing && cur) for (const k of ['vc.type', 'vc.reg', 'vc.density', 'vc.spread']) params[k] = cur.params[k];
      const before = cur ? JSON.stringify(['vc.type', 'vc.reg', 'vc.density', 'vc.spread'].map((k) => cur.params[k])) : '';
      this.engine.livePad('load', { params: Array.from(worshipParamArray(params)), xfade: L.xfade }); // crossfade first, then record it
      this.store.do(`Pad preset ${name}`, (p) => { p.live.patch.params = params; p.live.patch.preset = name; }, 'live');
      const after = JSON.stringify(['vc.type', 'vc.reg', 'vc.density', 'vc.spread'].map((k) => params[k]));
      if (this.liveState.playing && before !== after) this.liveRevoice({ mode: 'gentle', time: L.xfade });
      this.uiChanged('live');
      return;
    }
    this.store.do(`Load preset ${name}`, (p) => {
      const tr = findTrack(p, chId);
      const wt = tr.instrument && tr.instrument.type === 'worship' ? tr.instrument.wt : null;
      tr.instrument = newWorshipInstrument(name);
      if (wt) tr.instrument.wt = wt;
      if (/^Worship Pad( \d+)?$/.test(tr.name) || WORSHIP_PRESETS.some((x) => x.name === tr.name)) tr.name = name;
      tr.automation = tr.automation.filter((a) => !a.target.startsWith('inst:'));
    }, 'inst', { id: chId });
  }
  padWtEdit(chId, osc, fn, phase = 'do', label = 'Edit wavetable') {
    const scope = chId === 'livepad' ? 'live' : 'wt';
    const apply = (p) => this.padMutate(p, chId, (i) => { if (fn) fn(i.wt[osc]); i.wt[osc].name = i.wt[osc].name.replace(/ \(edited\)$/, '') + ' (edited)'; });
    if (phase === 'begin') { this.store.begin(label); this.store.live(apply, scope, { id: chId, osc }); }
    else if (phase === 'live') this.store.live(apply, scope, { id: chId, osc });
    else if (phase === 'end') { this.store.end(scope); this.scheduleTables(0); }
    else { this.store.do(label, apply, scope, { id: chId, osc }); this.scheduleTables(0); }
  }
  padSetWavetable(chId, osc, wt) {
    this.store.do('Load wavetable', (p) => this.padMutate(p, chId, (i) => { i.wt[osc] = cloneJSON(wt); }), chId === 'livepad' ? 'live' : 'wt', { id: chId, osc });
    this.scheduleTables(0);
  }
  addWorshipTrack(presetName = 'Endless Worship', at = null) {
    let id;
    this.store.do('Add Worship Atmospheres track', (p) => {
      const t = newTrack(p, 'instrument', { instrument: newWorshipInstrument(presetName), name: presetName });
      id = t.id;
      if (at === null || at > p.tracks.length) p.tracks.push(t); else p.tracks.splice(at, 0, t);
    }, 'tracks');
    this.ui.selTrack = id; this.ui.padEdit = false; this.ui.tab = 'synth';
    this.uiChanged('track');
    return id;
  }

  // ------------------------------------------------------------------ Drummer (EDM drum kit + virtual drummers)
  // A drum track holds Drummer regions (generated grooves) and/or ordinary MIDI clips for the kit.
  addDrummerTrack(drummerId = 'nova', at = null, opts = {}) {
    const d = drummerById(drummerId);
    let id, cid;
    this.store.do(`Add Drummer track (${d.name})`, (p) => {
      const bar = barBeats(p);
      const t = newTrack(p, 'instrument', { instrument: newDrumInstrument(d.kit), name: 'Drummer' });
      t.color = d.color;
      const start = opts.start ?? 0, length = opts.length ?? 8 * bar;
      const c = newDrummerClip(start, length, newDrummerSettings(d.id), d.name);
      t.clips.push(c);
      id = t.id; cid = c.id;
      if (at === null || at > p.tracks.length) p.tracks.push(t); else p.tracks.splice(at, 0, t);
    }, 'tracks');
    this.ui.selTrack = id; this.ui.selClips = new Set([cid]); this.ui.editClip = cid; this.ui.tab = 'synth'; this.ui.padEdit = false;
    this.uiChanged('track');
    return id;
  }
  // The region the Drummer editor works on: the one being edited, else a selected one, else the first on the track.
  drummerTarget(trackId) {
    const t = findTrack(this.p, trackId);
    if (!isDrumTrack(t)) return null;
    const regions = t.clips.filter((c) => c.kind === 'drummer').sort((a, b) => a.start - b.start);
    return regions.find((c) => c.id === this.ui.editClip) || regions.find((c) => this.ui.selClips.has(c.id)) || regions[0] || null;
  }
  createDrummerRegion(trackId, start, length = null) {
    const t = findTrack(this.p, trackId);
    if (!isDrumTrack(t)) return null;
    const bar = barBeats(this.p);
    const prev = t.clips.filter((c) => c.kind === 'drummer' && c.start <= start).sort((a, b) => b.start - a.start)[0] || t.clips.find((c) => c.kind === 'drummer');
    const next = t.clips.filter((c) => c.start > start + 1e-6).sort((a, b) => a.start - b.start)[0];
    const len = length ?? Math.max(bar, Math.min(8 * bar, next ? next.start - start : 8 * bar));
    const dr = prev ? { ...cloneJSON(prev.dr), seed: newSeed() } : newDrummerSettings(DRUMMER_FOR_KIT[t.instrument.params.kit] || 'nova');
    let id;
    this.store.do('Create Drummer region', (p) => {
      const c = newDrummerClip(start, len, dr, drummerById(dr.id).name);
      findTrack(p, trackId).clips.push(c); id = c.id;
    }, 'clips');
    if (id) { this.selectClips([id]); this.editClip(id); }
    return id;
  }
  // Merge settings into a region: { cx, loud, fill, speed, swing, feel, hum, parts: { kick: { on, v } } }
  mergeDrummer(c, patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'parts') for (const [pid, pv] of Object.entries(v)) c.dr.parts[pid] = { ...c.dr.parts[pid], ...pv };
      else c.dr[k] = v;
    }
  }
  setDrummer(clipId, patch, label = 'Change Drummer') {
    this.store.do(label, (p) => { const f = findClip(p, clipId); if (!f || f.clip.kind !== 'drummer') return false; this.mergeDrummer(f.clip, patch); }, 'clips', { id: clipId });
  }
  drummerBegin(label) { this.store.begin(label); }
  drummerLive(clipId, patch) { this.store.live((p) => { const f = findClip(p, clipId); if (f && f.clip.kind === 'drummer') this.mergeDrummer(f.clip, patch); }, 'clips', { id: clipId }); }
  drummerEnd() { this.store.end('clips'); }
  // Pick who plays the track: every region gets the drummer and the kit follows;
  // the edited region takes on the drummer's personality (their default feel).
  chooseDrummer(trackId, drummerId, clipId = null) {
    const d = drummerById(drummerId);
    this.store.do(`Drummer: ${d.name}`, (p) => {
      const t = findTrack(p, trackId);
      if (!isDrumTrack(t)) return false;
      t.instrument.params.kit = kitIndex(d.kit);
      t.instrument.preset = d.kit;
      for (const c of t.clips) {
        if (c.kind !== 'drummer') continue;
        const wasName = c.name === drummerById(c.dr.id).name;
        c.dr.id = d.id;
        if (c.id === clipId || !clipId) Object.assign(c.dr, { cx: d.def.cx, loud: d.def.loud, fill: d.def.fill, swing: d.def.swing, feel: d.def.feel, hum: d.def.hum });
        if (wasName) c.name = d.name;
      }
    }, 'inst', { id: trackId });
  }
  newDrummerTake(clipId) { this.setDrummer(clipId, { seed: newSeed() }, 'New Drummer take'); }
  // Turn a Drummer region into an ordinary MIDI clip with the same hits (editable in the piano roll).
  drummerToMidi(clipId) {
    const f = findClip(this.p, clipId);
    if (!f || f.clip.kind !== 'drummer') return;
    const bar = barBeats(this.p);
    let id;
    this.store.do('Convert Drummer region to MIDI', (p) => {
      const g = findClip(p, clipId);
      const notes = generateDrummer(g.clip.dr, g.clip.length, bar).map((n) => newNote(n.p, n.s, n.l, n.v));
      const c = newMidiClip(g.clip.start, g.clip.length, notes, `${g.clip.name} (MIDI)`);
      g.track.clips = g.track.clips.filter((x) => x.id !== clipId);
      g.track.clips.push(c); id = c.id;
    }, 'clips');
    if (id) { this.selectClips([id]); this.editClip(id); }
  }
  // Drum kit parameters (knobs in the Drummer editor), with automation capture like the synths
  drumBegin(label) { this.store.begin(label); }
  drumLive(trackId, pid, value) {
    const def = DRUM_DEF[pid];
    if (def && def.automatable && this.autoRec.capture(trackId, `inst:${pid}`, toNorm(def, value))) return;
    this.store.live((p) => { const t = findTrack(p, trackId); if (t && t.instrument) t.instrument.params[pid] = value; }, 'inst-param', { id: trackId, pid });
    this.engine.setDrumParam(trackId, pid, value);
  }
  drumEnd() { this.autoRec.release(); this.store.end('inst-param'); this.autoRec.afterGesture(); }
  setDrumParam(trackId, pid, value) {
    const def = DRUM_DEF[pid];
    this.store.do(`Set ${def ? def.name : pid}`, (p) => {
      const t = findTrack(p, trackId);
      t.instrument.params[pid] = value;
      if (pid === 'kit') t.instrument.preset = KIT_NAMES[value];
    }, pid === 'kit' ? 'inst' : 'inst-param', { id: trackId, pid });
  }
  // Audition one kit piece (clicking a pad in the editor)
  async auditionDrum(trackId, note, vel = 0.85) {
    if (!(await this.ensureAudio())) return;
    this.engine.post({ type: 'live', ch: trackId, ev: 'on', pitch: note, vel });
    setTimeout(() => this.engine.post({ type: 'live', ch: trackId, ev: 'off', pitch: note }), 150);
  }

  // ------------------------------------------------------------------ LIVE PAD (performance)
  // A newly opened project brings its last key; a playing pad keeps sounding (it is the room's atmosphere).
  liveSync() {
    const L = this.p.live, s = this.liveState;
    if (!L) return;
    if (!s.playing) { s.key = L.lastKey; s.minor = L.lastMinor; }
    s.selSong = null; s.song = null;
    if (this.engine.node) this.engine.livePad('load', { params: Array.from(worshipParamArray(L.patch.params)), xfade: 1.5 });
  }
  toggleLiveView(on = !this.ui.live) {
    this.ui.live = on;
    if (on) this.ui.padEdit = true;
    else { const t = this.selectedTrack; if (t && t.instrument) this.ui.padEdit = false; }
    if (this.engine.node) this.engine.setScope(this.ui.padEdit ? 'livepad' : (this.selectedTrack || {}).id || 'livepad');
    this.uiChanged('live');
  }
  // Runs on its own channel, independent of the arrangement transport.
  liveChord(pc, minor, prev) {
    const pr = this.p.live.patch.params, type = pr['vc.type'] | 0;
    return voiceChord({ root: pc, minor, type, register: pr['vc.reg'] | 0, density: pr['vc.density'], spread: pr['vc.spread'],
      custom: type === VC.CUSTOM ? parseIntervals(this.p.live.patch.custom) : null, prev });
  }
  async liveStart() {
    if (!(await this.ensureAudio())) return;
    this.syncNow();
    const s = this.liveState, c = this.liveChord(s.key, s.minor, null);
    s.chord = c.notes; s.bass = c.root; s.playing = true;
    this.engine.livePad('start', { chord: c.notes, bass: c.root, fadeIn: this.p.live.fadeIn });
    this.uiChanged('live');
  }
  liveStop() {
    const s = this.liveState;
    if (!s.playing) return;
    s.playing = false;
    this.engine.livePad('stop', { fadeOut: this.p.live.fadeOut });
    this.uiChanged('live');
  }
  liveToggle() { if (this.liveState.playing) this.liveStop(); else this.liveStart(); }
  livePanic() {
    this.liveState.playing = false;
    this.engine.livePad('panic');
    toast('Live pad silenced');
    this.uiChanged('live');
  }
  liveSwell() { if (this.liveState.playing) this.engine.livePad('swell'); }
  // Change key (and tonality). While playing, the pad moves there with the chosen transition.
  setLiveKey(pc, minor = this.liveState.minor, opts = {}) {
    const s = this.liveState, L = this.p.live;
    pc = ((pc % 12) + 12) % 12;
    const changed = pc !== s.key || !!minor !== s.minor;
    s.key = pc; s.minor = !!minor;
    L.lastKey = pc; L.lastMinor = !!minor; // remembered with the project (not an undo step)
    if (opts.spell) L.spell = opts.spell;
    if (s.playing && (changed || opts.force)) this.liveRevoice(opts);
    this.uiChanged('live');
  }
  liveRevoice({ mode, time } = {}) {
    const L = this.p.live, s = this.liveState;
    const c = this.liveChord(s.key, s.minor, L.voiceLead ? s.chord : null);
    const m = mode || L.transition, T = Math.max(0.5, time ?? L.transTime);
    const o = m === 'immediate' ? { fadeIn: 0.06, fadeOut: 0.15, trans: 0 }
      : m === 'atmos' ? { fadeIn: T, fadeOut: T * 1.4, trans: T * 1.2 }
      : { fadeIn: T, fadeOut: T, trans: 0 };
    s.chord = c.notes; s.bass = c.root;
    this.engine.livePad('change', { chord: c.notes, bass: c.root, voiceLead: L.voiceLead, ...o });
  }
  setLiveOpt(key, value, label = 'Live pad setting') {
    this.store.do(label, (p) => { p.live[key] = value; }, 'live');
  }
  liveVolLive(db) {
    this.store.live((p) => { p.live.vol = db; }, 'live-param', { id: 'livepad' });
    this.engine.setMix('livepad', 'gain', dbToGain(db));
  }

  // ------------------------------------------------------------------ setlists
  get activeSetlist() { const L = this.p.live; return L.setlists.find((s) => s.id === L.activeSetlist) || null; }
  addSetlist(name = 'Sunday Service') {
    const sl = newSetlist(name);
    this.store.do('New setlist', (p) => { p.live.setlists.push(sl); p.live.activeSetlist = sl.id; }, 'live');
    return sl.id;
  }
  renameSetlist(id, name) { if (name) this.store.do('Rename setlist', (p) => { const s = p.live.setlists.find((x) => x.id === id); if (s) s.name = name; }, 'live'); }
  deleteSetlist(id) {
    this.store.do('Delete setlist', (p) => {
      p.live.setlists = p.live.setlists.filter((x) => x.id !== id);
      if (p.live.activeSetlist === id) p.live.activeSetlist = p.live.setlists[0] ? p.live.setlists[0].id : null;
    }, 'live');
  }
  setActiveSetlist(id) { this.store.do('Choose setlist', (p) => { p.live.activeSetlist = id; }, 'live'); this.liveState.selSong = null; }
  addSong(fields = {}) {
    let setId = this.p.live.activeSetlist;
    if (!setId) setId = this.addSetlist();
    const song = newSong({ key: this.liveState.key, minor: this.liveState.minor, preset: this.p.live.patch.preset, ...fields });
    this.store.do('Add song', (p) => { p.live.setlists.find((x) => x.id === setId).songs.push(song); }, 'live');
    this.liveState.selSong = song.id;
    return song.id;
  }
  updateSong(songId, patch) {
    this.store.do('Edit song', (p) => { for (const sl of p.live.setlists) { const s = sl.songs.find((x) => x.id === songId); if (s) Object.assign(s, patch); } }, 'live');
  }
  removeSong(songId) {
    this.store.do('Remove song', (p) => { for (const sl of p.live.setlists) sl.songs = sl.songs.filter((x) => x.id !== songId); }, 'live');
    if (this.liveState.selSong === songId) this.liveState.selSong = null;
  }
  moveSong(songId, dir) {
    this.store.do('Reorder setlist', (p) => {
      for (const sl of p.live.setlists) {
        const i = sl.songs.findIndex((x) => x.id === songId);
        if (i < 0) continue;
        const j = Math.max(0, Math.min(sl.songs.length - 1, i + dir));
        const [s] = sl.songs.splice(i, 1); sl.songs.splice(j, 0, s);
      }
    }, 'live');
  }
  selectSong(songId) { this.liveState.selSong = songId; this.uiChanged('live'); }
  // Go to a song: its preset (crossfaded), voicing and key (with its transition). Never stops the pad.
  goSong(songId) {
    const sl = this.activeSetlist, song = sl && sl.songs.find((x) => x.id === songId);
    if (!song) return;
    const s = this.liveState;
    s.selSong = song.id; s.song = song.id;
    if (song.preset && song.preset !== this.p.live.patch.preset && worshipPresetByName(song.preset)) this.loadPadPreset('livepad', song.preset);
    if (song.voicing >= 0 && song.voicing !== (this.p.live.patch.params['vc.type'] | 0)) {
      this.store.do('Song voicing', (p) => { p.live.patch.params['vc.type'] = song.voicing; }, 'live');
    }
    this.setLiveKey(song.key, song.minor, { mode: song.transition || undefined, time: song.transTime > 0 ? song.transTime : undefined, spell: song.spell, force: true });
  }
  stepSong(dir) {
    const sl = this.activeSetlist;
    if (!sl || !sl.songs.length) return;
    const ref = this.liveState.song || this.liveState.selSong;
    let i = sl.songs.findIndex((x) => x.id === ref);
    i = i < 0 ? (dir > 0 ? 0 : sl.songs.length - 1) : Math.max(0, Math.min(sl.songs.length - 1, i + dir));
    this.goSong(sl.songs[i].id);
  }

  // ------------------------------------------------------------------ take lanes & comping
  compXfade() { return (COMP_XFADE_SEC * this.p.tempo) / 60; }
  takeLane(trackId, laneId) { const t = findTrack(this.p, trackId); return t && (t.takeLanes || []).find((l) => l.id === laneId); }
  toggleTakes(trackId) {
    const t = findTrack(this.p, trackId);
    if (!t || t.kind !== 'audio') return;
    if (!t.takeLanes.length) { toast('No takes yet. Every take you record on this track is kept here for comping.'); return; }
    const show = !t.showTakes;
    this.store.do(show ? 'Show takes' : 'Hide takes', (p) => { findTrack(p, trackId).showTakes = show; }, 'tracks');
    if (!show && this.ui.audition && this.ui.audition.track === trackId) this.setAudition(null);
  }
  // Use a whole take clip (or, without clipId, every clip of the lane) in the comp.
  compTake(trackId, laneId, clipId = null) {
    const lane = this.takeLane(trackId, laneId);
    if (!lane) return;
    this.store.do(`Use ${lane.name}`, (p) => {
      const t = findTrack(p, trackId), l = t.takeLanes.find((x) => x.id === laneId);
      for (const T of l.clips) if (!clipId || T.id === clipId) compRange(t, l, T, T.start, T.start + T.length, p.tempo, this.compXfade());
    }, 'clips');
  }
  // Comp [a, b) from a lane (used by the arrangement's swipe gesture inside store.live).
  compSwipe(p, trackId, laneId, a, b) {
    const t = findTrack(p, trackId), l = t && t.takeLanes.find((x) => x.id === laneId);
    if (l) compLaneRange(t, l, a, b, p.tempo, this.compXfade());
  }
  renameTakeLane(trackId, laneId, name) {
    if (!name) return;
    this.store.do('Rename take', (p) => { const l = findTrack(p, trackId).takeLanes.find((x) => x.id === laneId); if (l) l.name = name; }, 'clips');
  }
  deleteTakeLanes(trackId, laneIds, label = 'Delete take') {
    const ids = new Set(laneIds);
    if (!ids.size) return;
    this.store.do(label, (p) => {
      const t = findTrack(p, trackId);
      t.takeLanes = t.takeLanes.filter((l) => !ids.has(l.id));
      if (!t.takeLanes.length) t.showTakes = false;
    }, 'clips');
    if (this.ui.audition && ids.has(this.ui.audition.lane)) this.setAudition(null);
  }
  deleteUnusedTakes(trackId) {
    const t = findTrack(this.p, trackId);
    if (!t) return;
    const unused = t.takeLanes.filter((l) => laneUsage(t, l, this.p.tempo) === 0).map((l) => l.id);
    if (!unused.length) { toast('Every take is used somewhere in the comp.'); return; }
    this.deleteTakeLanes(trackId, unused, `Delete ${unused.length} unused take${unused.length > 1 ? 's' : ''}`);
  }
  // Audition: the track plays one take lane instead of its comp (not saved, not exported).
  validAudition() {
    const a = this.ui.audition;
    if (a && !this.takeLane(a.track, a.lane)) this.ui.audition = null;
    return this.ui.audition;
  }
  setAudition(a) { this.ui.audition = a; this.syncNow(); this.uiChanged('takes'); }
  toggleAudition(trackId, laneId) {
    const a = this.ui.audition, lane = this.takeLane(trackId, laneId);
    if (!lane) return;
    const off = a && a.track === trackId && a.lane === laneId;
    this.setAudition(off ? null : { track: trackId, lane: laneId });
    toast(off ? 'Back to the comp' : `Auditioning ${lane.name}: the track plays this take instead of the comp`);
  }

  // ------------------------------------------------------------------ audio input
  async enableInput(deviceId = this.settings.inputDeviceId) {
    if (!(await this.ensureAudio())) return false;
    try { await this.input.enable(deviceId); }
    catch (err) {
      const msg = err && err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it for this site in the browser to record audio.'
        : err && err.name === 'NotFoundError' ? 'No audio input device was found.'
        : 'Could not open the audio input: ' + (err && err.message ? err.message : err);
      toast(msg, 'error', 8000);
      return false;
    }
    const ch = this.input.settings.channelCount;
    toast(`Input on: ${this.input.label}${ch ? ` (${ch} ch)` : ''}`, 'ok');
    return true;
  }
  disableInput() {
    if (this.recording && this.recording.audio.length) this.finishRecording();
    this.input.disable();
  }
  recLatencyMs() {
    const s = this.settings;
    const base = typeof s.recLatencyMs === 'number' ? s.recLatencyMs : this.input.estimateRoundTrip() * 1000;
    return base + (s.recOffsetMs || 0);
  }
  recLatencyFrames() { return Math.max(0, Math.round((this.recLatencyMs() / 1000) * (this.engine.sampleRate || 48000))); }
  saveSettings(patch) { Object.assign(this.settings, patch); writeLS(LS_SETTINGS, this.settings); }

  // ------------------------------------------------------------------ live input
  noteOn(pitch, vel = 0.8, targets = null) {
    const tg = targets || this.liveTargets();
    if (!tg.length) return;
    if (this.engine.state !== 'running') { this.ensureAudio(); }
    for (const t of tg) this.engine.live(t.id, 'on', pitch, vel);
    this.sustained.delete(pitch);
    if (this.recording && this.recording.started && this.engine.playState === 1) this.recording.open.set(pitch, { p: pitch, s: this.recBeat(), v: vel });
    this.emit('note', { pitch, on: true });
  }
  noteOff(pitch, targets = null) {
    if (this.sustain) { this.sustained.add(pitch); return; }
    const tg = targets || this.liveTargets();
    for (const t of tg) this.engine.live(t.id, 'off', pitch);
    if (this.recording) {
      const n = this.recording.open.get(pitch);
      if (n) { this.recording.open.delete(pitch); this.recording.notes.push({ ...n, e: this.recBeat() }); }
    }
    this.emit('note', { pitch, on: false });
  }
  setSustain(on) {
    this.sustain = on;
    if (!on) { for (const p of this.sustained) this.noteOff(p); this.sustained.clear(); }
  }
  pitchBend(v) { for (const t of this.liveTargets()) this.engine.live(t.id, 'bend', 0, 0, v); }
  modWheel(v) { for (const t of this.liveTargets()) this.engine.live(t.id, 'mw', 0, 0, v); }
  releaseKbd() { for (const [, p] of this.kbdHeld) this.noteOff(p); this.kbdHeld.clear(); }
  toggleKbd() { this.ui.kbd = !this.ui.kbd; this.releaseKbd(); this.uiChanged('kbd'); toast(this.ui.kbd ? 'Computer keyboard MIDI on (A–L play notes, Z/X octave, C/V velocity)' : 'Computer keyboard MIDI off'); }

  async enableMidi() {
    if (!navigator.requestMIDIAccess) { toast('Web MIDI is not available in this browser.', 'warn'); return false; }
    try {
      this.midiAccess = await navigator.requestMIDIAccess();
      const bind = () => { for (const input of this.midiAccess.inputs.values()) input.onmidimessage = (m) => this.onMidi(m.data); };
      bind();
      this.midiAccess.onstatechange = bind;
      const n = this.midiAccess.inputs.size;
      toast(n ? `MIDI input enabled (${n} device${n > 1 ? 's' : ''})` : 'MIDI enabled — no input devices found yet.', 'ok');
      this.emit('midi');
      return true;
    } catch (err) { toast('MIDI access was denied.', 'warn'); return false; }
  }
  onMidi(d) {
    const st = d[0] & 0xf0;
    if (st === 0x90 && d[2] > 0) this.noteOn(d[1], d[2] / 127);
    else if (st === 0x80 || (st === 0x90 && d[2] === 0)) this.noteOff(d[1]);
    else if (st === 0xe0) this.pitchBend(((d[2] << 7) | d[1]) / 8192 - 1);
    else if (st === 0xb0 && d[1] === 1) this.modWheel(d[2] / 127);
    else if (st === 0xb0 && d[1] === 64) this.setSustain(d[2] >= 64);
    else if (st === 0xb0 && d[1] === 123) for (const t of this.liveTargets()) this.engine.live(t.id, 'allOff');
  }

  // ------------------------------------------------------------------ keyboard
  onKeyDown(e) {
    if (e.defaultPrevented) return;
    const tgt = e.target;
    if (isTextInput(tgt) && tgt.tagName !== 'SELECT') return;
    if (document.querySelector('.modal-back')) return;
    const k = e.key, lower = k.length === 1 ? k.toLowerCase() : k, mod = e.ctrlKey || e.metaKey;

    if (this.ui.kbd && !mod && !e.altKey) {
      if (lower in KBD_MAP) {
        e.preventDefault();
        if (e.repeat || this.kbdHeld.has(lower)) return;
        const pitch = Math.min(127, (this.ui.kbdOct + 1) * 12 + KBD_MAP[lower]);
        this.kbdHeld.set(lower, pitch);
        this.noteOn(pitch, this.ui.kbdVel);
        return;
      }
      if (lower === 'z' || lower === 'x') { e.preventDefault(); this.releaseKbd(); this.ui.kbdOct = Math.max(0, Math.min(8, this.ui.kbdOct + (lower === 'x' ? 1 : -1))); toast(`Keyboard octave C${this.ui.kbdOct}`); this.uiChanged('kbd'); return; }
      if (lower === 'c' || lower === 'v') { e.preventDefault(); this.ui.kbdVel = Math.max(0.1, Math.min(1, this.ui.kbdVel + (lower === 'v' ? 0.1 : -0.1))); toast(`Keyboard velocity ${Math.round(this.ui.kbdVel * 127)}`); return; }
    }
    if (tgt && tgt.tagName === 'SELECT') return;

    // Live Pad Mode: step through the setlist
    if (this.ui.live && !mod && !e.altKey) {
      if (k === 'ArrowRight') { e.preventDefault(); this.stepSong(1); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); this.stepSong(-1); return; }
      if (k === 'Enter' && this.liveState.selSong) { e.preventDefault(); this.goSong(this.liveState.selSong); return; }
      if (k === 'Escape') { e.preventDefault(); this.toggleLiveView(false); return; }
    }
    // focused component first (piano roll / arrangement)
    if (this.shell.handleKey(e)) { e.preventDefault(); return; }

    if (k === ' ') { e.preventDefault(); this.togglePlay(); return; }
    if (mod && !e.shiftKey && lower === 'z') { e.preventDefault(); const l = this.store.undo(); if (l) toast(`Undo: ${l}`); return; }
    if ((mod && e.shiftKey && lower === 'z') || (mod && lower === 'y')) { e.preventDefault(); const l = this.store.redo(); if (l) toast(`Redo: ${l}`); return; }
    if (mod && lower === 's') { e.preventDefault(); this.saveProject(e.shiftKey); return; }
    if (mod && lower === 'o') { e.preventDefault(); this.openProject(); return; }
    if (mod && e.shiftKey && lower === 'e') { e.preventDefault(); this.shell.openExport(); return; }
    if (mod && e.altKey && lower === 't') { e.preventDefault(); this.addInstrumentTrack(); return; }
    if (mod && e.altKey && lower === 'a') { e.preventDefault(); this.addAudioTrack(); return; }
    if (mod && e.altKey && lower === 'r') { e.preventDefault(); this.addBus(true); return; }
    if (e.altKey && !mod && ['1', '2', '3', '4'].includes(k)) { e.preventDefault(); this.setTab(['mixer', 'editor', 'synth', 'fx'][+k - 1]); return; }
    if (mod || e.altKey) return;
    switch (lower) {
      case 'Enter': case 'Home': e.preventDefault(); this.returnToStart(); return;
      case 'r': e.preventDefault(); this.toggleRecord(); return;
      case 'l': e.preventDefault(); this.toggleLoop(); return;
      case 'k': e.preventDefault(); this.toggleMetronome(); return;
      case 'w': e.preventDefault(); this.toggleAutoArm(); return;
      case 'i': e.preventDefault(); this.togglePunch(); return;
      case 'p': e.preventDefault(); this.toggleLiveView(); return;
      case 'm': e.preventDefault(); this.addMarker(this.isPlaying ? this.engine.position : this.ui.cursor); return;
      case '`': e.preventDefault(); this.toggleKbd(); return;
      case '?': case 'F1': e.preventDefault(); this.shell.openShortcuts(); return;
      case 'Escape': this.selectClips([]); return;
      default:
    }
  }
  onKeyUp(e) {
    const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (this.kbdHeld.has(lower)) { const p = this.kbdHeld.get(lower); this.kbdHeld.delete(lower); this.noteOff(p); }
  }

  // ------------------------------------------------------------------ frame loop
  tick(t) {
    this.autoRec.tick();
    const ps = this.engine.playState;
    if (this.recording && !this.recording.started && ps === 1) { this.recording.started = true; this.recording.startBeat = this.engine.position; }
    if (ps !== this.lastPlayState) {
      if (this.lastPlayState !== 0 && ps === 0 && this.engine.node) { /* stopped by engine (e.g. offline) */ }
      this.lastPlayState = ps;
      this.emit('transport');
    }
    if (this.engine.nanCount > (this.lastNan || 0)) { this.lastNan = this.engine.nanCount; toast('Audio engine recovered from an unstable filter state (output muted briefly).', 'warn', 5000); }
    this.shell.frame(t);
    requestAnimationFrame((tt) => this.tick(tt));
  }
}

function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    if (multiple) inp.multiple = true;
    inp.addEventListener('change', () => { resolve(multiple ? [...inp.files] : inp.files[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}
export { pickFile };
export { MIX_PARAMS, allChannels, newNote };
