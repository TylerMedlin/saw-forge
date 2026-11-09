// LIVE PAD MODE: the performance view for Worship Atmospheres.
//
// A background instrument that runs on its own channel, independent of the
// arrangement transport: one-click start/stop, any of 12 keys in major or
// minor, voicings, key transitions (immediate / gentle / atmospheric with
// voice leading), preset crossfades, layer levels, swells, panic, and a
// setlist that moves the pad from song to song without stopping it.

import { h, Surface, css } from './dom.js';
import { icon } from './icons.js';
import { HSlider, selectEl, dialog, confirmDialog, promptText, contextMenu, Meter } from './widgets.js';
import { WP_DEF, VOICINGS, STRING_TYPES, keyName, altName } from '../shared/worship-params.js';
import { WORSHIP_COLLECTIONS } from '../shared/worship-presets.js';
import { MIX_PARAMS } from '../shared/params.js';

const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
const TRANSITIONS = [['immediate', 'Immediate'], ['gentle', 'Gentle crossfade'], ['atmos', 'Slow atmospheric']];

export class LiveView {
  constructor(app, shell) {
    this.app = app; this.shell = shell;
    this.coll = 0;
    this.sliders = new Map();
    this.build();
  }

  // ------------------------------------------------------------ layout
  build() {
    const app = this.app;
    // header
    this.playBtn = h('button', { class: 'lv-play', title: 'Start / stop the pad (fades in and out)', onClick: () => app.liveToggle() });
    this.keyBig = h('div', { class: 'lv-key-big' });
    this.presetName = h('div', { class: 'lv-preset-name' });
    this.swellBtn = h('button', { class: 'btn lv-swell', title: 'Swell: a slow rise in volume and brightness, then back', onClick: () => app.liveSwell() }, 'Swell');
    this.panicBtn = h('button', { class: 'btn danger lv-panic', title: 'Panic: silence the pad immediately', onClick: () => app.livePanic() }, icon('stop', 12), h('span', null, 'Panic'));
    this.vol = new HSlider({ def: MIX_PARAMS.vol, value: 0, class: 'lv-vol', title: 'Live pad volume',
      onBegin: () => app.store.begin('Live pad volume'), onInput: (v) => app.liveVolLive(v), onEnd: () => app.store.end('live') });
    this.meter = new Meter({ horizontal: true });
    this.editBtn = h('button', { class: 'btn ghost sm', title: 'Edit this sound in the modular editor (bottom panel)', onClick: () => { app.ui.padEdit = true; app.ui.tab = 'synth'; this.shell.setCollapsed(false); app.uiChanged('live'); } }, icon('synth', 13), h('span', null, 'Edit sound'));
    this.closeBtn = h('button', { class: 'ibtn', title: 'Back to the arrangement (P) — the pad keeps playing', onClick: () => app.toggleLiveView(false) }, icon('close', 14));
    const header = h('div', { class: 'lv-head' }, this.playBtn,
      h('div', { class: 'lv-now' }, this.keyBig, this.presetName),
      this.swellBtn, this.panicBtn,
      h('div', { class: 'lv-vol-wrap' }, h('span', { class: 'mini-label' }, 'Volume'), this.vol.el, this.meter.el),
      h('div', { class: 'tb-spacer' }), this.editBtn, this.closeBtn);

    // atmosphere strip: spectrum + sounding notes
    this.cvAtm = h('canvas', { class: 'lv-atm' });
    this.atm = new Surface(this.cvAtm, () => {});

    // keys
    this.keyBtns = FIFTHS.map((pc, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const b = h('button', { class: 'lv-keybtn', style: { left: `${50 + 41 * Math.cos(a)}%`, top: `${50 + 41 * Math.sin(a)}%` },
        onClick: (e) => app.setLiveKey(pc, app.liveState.minor, e.shiftKey ? { mode: 'immediate' } : {}) },
        h('b'), h('small'));
      b.dataset.pc = pc;
      return b;
    });
    this.majBtn = h('button', { class: 'seg-btn', onClick: () => app.setLiveKey(app.liveState.key, false) }, 'Major');
    this.minBtn = h('button', { class: 'seg-btn', onClick: () => app.setLiveKey(app.liveState.key, true) }, 'Minor');
    this.spellSel = selectEl([{ value: 'auto', label: 'Auto spelling' }, { value: 'sharp', label: 'Sharps (♯)' }, { value: 'flat', label: 'Flats (♭)' }], 'auto',
      (v) => app.setLiveOpt('spell', v, 'Key spelling'), 'sel-sm', 'How keys are named');
    const ring = h('div', { class: 'lv-ring' }, ...this.keyBtns,
      h('div', { class: 'lv-ring-center' }, h('div', { class: 'seg lv-tonality' }, this.majBtn, this.minBtn), this.spellSel));

    // voicing
    this.vcBtns = VOICINGS.map((name, i) => h('button', { class: 'chip', onClick: () => app.setPadParam('livepad', 'vc.type', i) }, name));
    this.regBtns = ['Low', 'Mid', 'High'].map((n, i) => h('button', { class: 'seg-btn', onClick: () => app.setPadParam('livepad', 'vc.reg', i) }, n));
    const density = this.slider('vc.density', 'Density');
    this.chordEl = h('div', { class: 'lv-chord' });
    const voicing = this.sec('Harmony', h('div', { class: 'chips' }, this.vcBtns),
      h('div', { class: 'lv-row' }, h('span', { class: 'mini-label' }, 'Register'), h('div', { class: 'seg' }, this.regBtns), density), this.chordEl);

    // transition
    this.trBtns = TRANSITIONS.map(([id, label]) => h('button', { class: 'seg-btn', onClick: () => app.setLiveOpt('transition', id, 'Key transition') }, label));
    this.trTime = new HSlider({ def: { id: 'tt', name: 'Transition time', min: 0.5, max: 60, def: 4, curve: 'exp', unit: 's', short: 'Time' }, value: 4, class: 'lv-slider', title: 'Transition time',
      onBegin: () => app.store.begin('Transition time'), onInput: (v) => app.store.live((p) => { p.live.transTime = v; }, 'ui'), onEnd: () => app.store.end('live') });
    this.vlBtn = h('button', { class: 'pill', title: 'Hold common tones and keep the register when the key changes', onClick: () => app.setLiveOpt('voiceLead', !app.p.live.voiceLead, 'Voice leading') }, 'Voice leading');
    this.xfade = new HSlider({ def: { id: 'xf', name: 'Preset crossfade', min: 0.1, max: 30, def: 4, curve: 'exp', unit: 's', short: 'Crossfade' }, value: 4, class: 'lv-slider', title: 'Crossfade time when changing presets',
      onBegin: () => app.store.begin('Preset crossfade'), onInput: (v) => app.store.live((p) => { p.live.xfade = v; }, 'ui'), onEnd: () => app.store.end('live') });
    this.fadeIn = new HSlider({ def: { id: 'fi', name: 'Fade in', min: 0.1, max: 60, def: 3, curve: 'exp', unit: 's', short: 'Fade in' }, value: 3, class: 'lv-slider', title: 'Start fade-in',
      onBegin: () => app.store.begin('Fade in'), onInput: (v) => app.store.live((p) => { p.live.fadeIn = v; }, 'ui'), onEnd: () => app.store.end('live') });
    this.fadeOut = new HSlider({ def: { id: 'fo', name: 'Fade out', min: 0.5, max: 120, def: 8, curve: 'exp', unit: 's', short: 'Fade out' }, value: 8, class: 'lv-slider', title: 'Stop fade-out',
      onBegin: () => app.store.begin('Fade out'), onInput: (v) => app.store.live((p) => { p.live.fadeOut = v; }, 'ui'), onEnd: () => app.store.end('live') });
    this.keepVcBtn = h('button', { class: 'pill', title: 'Keep the current voicing when changing presets', onClick: () => app.setLiveOpt('keepVoicing', !app.p.live.keepVoicing, 'Keep voicing') }, 'Keep voicing');
    const transition = this.sec('Transitions',
      h('div', { class: 'seg lv-tr' }, this.trBtns),
      h('div', { class: 'lv-row' }, this.lbl('Key change', this.trTime.el), this.vlBtn),
      h('div', { class: 'lv-row' }, this.lbl('Preset crossfade', this.xfade.el), this.keepVcBtn),
      h('div', { class: 'lv-row' }, this.lbl('Fade in', this.fadeIn.el), this.lbl('Fade out', this.fadeOut.el)));

    // layers
    this.strSel = selectEl(STRING_TYPES.map((n, i) => ({ value: i, label: n })), 0, (v) => app.setPadParam('livepad', 'str.type', +v), 'sel-sm', 'String sound');
    const layers = this.sec('Layers',
      this.layer('Pad', null, 'mix.pad'),
      this.layer('Strings', 'str.on', 'str.vol', this.strSel),
      this.layer('Bass foundation', 'bass.on', 'bass.level'),
      this.layer('Air / texture', 'nz.on', 'nz.level'),
      this.layer('Shimmer', 'sh.on', 'sh.amount'),
      this.layer('Reverb', 'rv.on', 'rv.send'),
      this.layer('Evolve', null, 'ev.amount'),
      this.layer('Breathe', null, 'br.amount'),
      this.layer('Auto swell', 'sw.auto', 'sw.depth'));

    // presets
    this.collTabs = WORSHIP_COLLECTIONS.map((c, i) => h('button', { class: 'seg-btn', title: c.name, onClick: () => { this.coll = i; this.renderPresets(); } }, c.name.split(' ').slice(0, 2).join(' ')));
    this.presetGrid = h('div', { class: 'lv-presets' });
    const presets = this.sec('Sounds', h('div', { class: 'seg lv-colls' }, this.collTabs), this.presetGrid);

    // setlist
    this.setSel = h('div', { class: 'lv-setsel' });
    this.songList = h('div', { class: 'lv-songs' });
    this.nowEl = h('div', { class: 'lv-nownext' });
    const setlist = h('div', { class: 'lv-setlist' },
      h('div', { class: 'lv-set-head' }, h('span', { class: 'lv-sec-title' }, 'Setlist'), this.setSel,
        h('button', { class: 'ibtn sm', title: 'Setlist options', onClick: (e) => this.setMenu(e) }, icon('dots', 14))),
      this.songList,
      h('div', { class: 'lv-set-actions' },
        h('button', { class: 'btn sm', onClick: () => this.editSong(null) }, icon('plus', 12), h('span', null, 'Add song')),
        h('div', { class: 'tb-spacer' }),
        h('button', { class: 'btn sm', title: 'Previous song (←)', onClick: () => app.stepSong(-1) }, icon('left', 12)),
        h('button', { class: 'btn primary sm', title: 'Go to the selected song (Enter)', onClick: () => { if (app.liveState.selSong) app.goSong(app.liveState.selSong); else app.stepSong(1); } }, 'Go'),
        h('button', { class: 'btn sm', title: 'Next song (→)', onClick: () => app.stepSong(1) }, icon('right', 12))),
      this.nowEl);

    const main = h('div', { class: 'lv-main' },
      h('div', { class: 'lv-left' }, h('div', { class: 'lv-keys' }, ring, h('div', { class: 'lv-keyside' }, voicing, transition)), h('div', { class: 'lv-lower' }, layers, presets)),
      setlist);
    this.el = h('section', { class: 'live-view' }, header, this.cvAtm, main);
  }

  sec(title, ...body) { return h('div', { class: 'lv-sec' }, h('div', { class: 'lv-sec-title' }, title), ...body); }
  lbl(label, el) { return h('div', { class: 'lv-lbl' }, h('span', { class: 'mini-label' }, label), el); }
  slider(pid, label) {
    const app = this.app, def = WP_DEF[pid];
    const s = new HSlider({ def, value: def.def, class: 'lv-slider', title: def.name,
      onBegin: () => app.padBegin('livepad', `Change ${def.name}`), onInput: (v) => app.padLive('livepad', pid, v), onEnd: () => app.padEnd() });
    this.sliders.set(pid, s);
    return this.lbl(label, s.el);
  }
  layer(label, onPid, pid, extra = null) {
    const app = this.app;
    const tog = onPid ? h('button', { class: 'power', title: `${label} on/off`, onClick: () => app.setPadParam('livepad', onPid, app.p.live.patch.params[onPid] >= 0.5 ? 0 : 1) }, icon('power', 11)) : h('span', { class: 'power-sp' });
    const def = WP_DEF[pid];
    const s = new HSlider({ def, value: def.def, class: 'lv-slider', title: def.name,
      onBegin: () => app.padBegin('livepad', `Change ${def.name}`), onInput: (v) => app.padLive('livepad', pid, v), onEnd: () => app.padEnd() });
    this.sliders.set(pid, s);
    const row = h('div', { class: 'lv-layer' }, tog, h('span', { class: 'lv-layer-name' }, label), s.el, extra);
    if (onPid) this.sliders.set(onPid, { set: (v) => { tog.classList.toggle('on', v >= 0.5); row.classList.toggle('off', v < 0.5); } });
    return row;
  }

  // ------------------------------------------------------------ refresh
  refresh() {
    const app = this.app, L = app.p.live, s = app.liveState, p = L.patch.params;
    this.el.classList.toggle('playing', s.playing);
    this.playBtn.replaceChildren(icon(s.playing ? 'stop' : 'play', 18), h('span', null, s.playing ? 'Stop' : 'Start'));
    this.playBtn.classList.toggle('on', s.playing);
    this.keyBig.replaceChildren(h('b', null, keyName(s.key, false, L.spell)), h('span', null, s.minor ? 'minor' : 'major'));
    this.presetName.textContent = `${L.patch.preset} · ${VOICINGS[p['vc.type'] | 0]}`;
    if (!this.vol.dragging) this.vol.set(L.vol);
    this.keyBtns.forEach((b) => {
      const pc = +b.dataset.pc;
      b.firstChild.textContent = keyName(pc, s.minor, L.spell);
      b.lastChild.textContent = L.spell === 'auto' ? altName(pc).replace(' / ', '/') : '';
      b.classList.toggle('on', pc === s.key);
    });
    this.majBtn.classList.toggle('on', !s.minor); this.minBtn.classList.toggle('on', s.minor);
    this.spellSel.value = L.spell;
    this.vcBtns.forEach((b, i) => b.classList.toggle('on', i === (p['vc.type'] | 0)));
    this.regBtns.forEach((b, i) => b.classList.toggle('on', i === (p['vc.reg'] | 0)));
    const chord = app.liveChord(s.key, s.minor, null);
    const nm = (n) => keyName(n % 12, false, L.spell) + (Math.floor(n / 12) - 1);
    this.chordEl.textContent = `${chord.notes.map(nm).join(' · ')}${p['bass.on'] >= 0.5 ? `  + bass ${nm(chord.root + 12 * p['bass.oct'])}` : ''}`;
    this.trBtns.forEach((b, i) => b.classList.toggle('on', TRANSITIONS[i][0] === L.transition));
    for (const [sl, v] of [[this.trTime, L.transTime], [this.xfade, L.xfade], [this.fadeIn, L.fadeIn], [this.fadeOut, L.fadeOut]]) if (!sl.dragging) sl.set(v);
    this.trTime.el.classList.toggle('disabled', L.transition === 'immediate');
    this.vlBtn.classList.toggle('on', !!L.voiceLead); this.keepVcBtn.classList.toggle('on', !!L.keepVoicing);
    for (const [pid, sl] of this.sliders) if (!sl.dragging) sl.set(p[pid]);
    this.strSel.value = String(p['str.type'] | 0);
    this.renderPresets();
    this.renderSetlist();
  }

  renderPresets() {
    const cur = this.app.p.live.patch.preset;
    this.collTabs.forEach((b, i) => { b.classList.toggle('on', i === this.coll); b.classList.toggle('has', WORSHIP_COLLECTIONS[i].presets.some((p) => p.name === cur)); });
    const key = this.coll + '|' + cur;
    if (key === this.presetKey) return;
    this.presetKey = key;
    this.presetGrid.replaceChildren(...WORSHIP_COLLECTIONS[this.coll].presets.map((pr) => h('button', { class: 'lv-preset' + (pr.name === cur ? ' on' : ''), title: pr.desc,
      onClick: () => this.app.loadPadPreset('livepad', pr.name) }, h('b', null, pr.name), h('span', null, pr.desc))));
  }

  renderSetlist() {
    const app = this.app, L = app.p.live, s = app.liveState, sl = app.activeSetlist;
    const opts = L.setlists.map((x) => ({ value: x.id, label: x.name }));
    this.setSel.replaceChildren(opts.length ? selectEl(opts, L.activeSetlist, (v) => app.setActiveSetlist(v), 'sel-sm', 'Setlist') : h('span', { class: 'mini-label' }, 'No setlist yet'));
    if (!sl || !sl.songs.length) {
      this.songList.replaceChildren(h('div', { class: 'lv-empty' }, sl ? 'No songs yet. Add the songs for this service in order; each one remembers its key, sound and transition.' : 'Create a setlist for your service: add songs in order, then step through them with Go / ← →. The pad never stops between songs.'));
    } else {
      this.songList.replaceChildren(...sl.songs.map((song, i) => {
        const row = h('div', { class: 'lv-song' + (song.id === s.song ? ' playing' : '') + (song.id === s.selSong ? ' sel' : ''), title: 'Click to select · double-click (or Go) to move the pad to this song',
          onClick: () => app.selectSong(song.id), onDblclick: () => app.goSong(song.id) },
          h('span', { class: 'lv-song-n' }, String(i + 1)),
          h('div', { class: 'lv-song-main' }, h('b', null, song.title), h('span', null, [song.artist, song.preset || null, song.tempo ? `${song.tempo} BPM` : null].filter(Boolean).join(' · '))),
          h('span', { class: 'lv-song-key' }, keyName(song.key, song.minor, song.spell)),
          h('div', { class: 'lv-song-btns' },
            h('button', { class: 'ibtn xs', title: 'Move up', onClick: (e) => { e.stopPropagation(); app.moveSong(song.id, -1); } }, '↑'),
            h('button', { class: 'ibtn xs', title: 'Move down', onClick: (e) => { e.stopPropagation(); app.moveSong(song.id, 1); } }, '↓'),
            h('button', { class: 'ibtn xs', title: 'Edit song', onClick: (e) => { e.stopPropagation(); this.editSong(song); } }, icon('pencil', 11))));
        return row;
      }));
    }
    const idx = sl ? sl.songs.findIndex((x) => x.id === s.song) : -1;
    const now = idx >= 0 ? sl.songs[idx] : null, next = sl && idx + 1 < sl.songs.length ? sl.songs[idx + 1] : (sl && idx < 0 && sl.songs[0]) || null;
    this.nowEl.replaceChildren(
      h('div', null, h('span', { class: 'mini-label' }, 'Now'), now ? `${now.title} — ${keyName(now.key, now.minor, now.spell)}` : '—'),
      h('div', null, h('span', { class: 'mini-label' }, 'Next'), next ? `${next.title} — ${keyName(next.key, next.minor, next.spell)}` : '—'));
  }

  setMenu(e) {
    const app = this.app, sl = app.activeSetlist;
    contextMenu(e.clientX, e.clientY, [
      { label: 'New setlist…', action: async () => { const n = await promptText('New setlist', 'Sunday Service'); if (n) app.addSetlist(n); } },
      sl ? { label: 'Rename setlist…', action: async () => { const n = await promptText('Rename setlist', sl.name); if (n) app.renameSetlist(sl.id, n); } } : null,
      sl ? { sep: true } : null,
      sl ? { label: 'Delete setlist', danger: true, action: async () => { if (await confirmDialog('Delete setlist?', `“${sl.name}” and its ${sl.songs.length} song(s) will be removed (undo brings them back).`, 'Delete', true)) app.deleteSetlist(sl.id); } } : null,
    ]);
  }

  // Song editor dialog (null = new song).
  editSong(song) {
    const app = this.app, L = app.p.live, s = app.liveState;
    const v = song ? { ...song } : { title: '', artist: '', key: s.key, minor: s.minor, spell: L.spell, preset: L.patch.preset, voicing: -1, transition: '', transTime: 0, tempo: 0, notes: '' };
    const input = (val, ph) => { const el = h('input', { class: 'text-input', value: val || '', placeholder: ph || '', spellcheck: false }); el.addEventListener('keydown', (e) => e.stopPropagation()); return el; };
    const title = input(v.title, 'Song title'), artist = input(v.artist, 'Artist or worship team');
    const keySel = selectEl(Array.from({ length: 12 }, (_, pc) => ({ value: pc, label: keyName(pc, false, 'auto') + (altName(pc) ? `  (${altName(pc)})` : '') })), v.key, () => {}, 'sel-sm');
    const tonSel = selectEl([{ value: 0, label: 'Major' }, { value: 1, label: 'Minor' }], v.minor ? 1 : 0, () => {}, 'sel-sm');
    const spellSel = selectEl([{ value: 'auto', label: 'Auto' }, { value: 'sharp', label: 'Sharps' }, { value: 'flat', label: 'Flats' }], v.spell || 'auto', () => {}, 'sel-sm');
    const presetSel = selectEl([{ value: '', label: 'Keep the current sound' }, ...WORSHIP_COLLECTIONS.map((c) => ({ group: c.name, options: c.presets.map((p) => ({ value: p.name, label: p.name })) }))], v.preset || '', () => {}, 'sel-sm');
    const vcSel = selectEl([{ value: -1, label: 'Sound’s own voicing' }, ...VOICINGS.map((n, i) => ({ value: i, label: n }))], v.voicing, () => {}, 'sel-sm');
    const trSel = selectEl([{ value: '', label: 'Default transition' }, ...TRANSITIONS.map(([id, l]) => ({ value: id, label: l }))], v.transition || '', () => {}, 'sel-sm');
    const trTime = input(v.transTime ? String(v.transTime) : '', 'default'), tempo = input(v.tempo ? String(v.tempo) : '', 'optional');
    const notes = h('textarea', { class: 'text-input', rows: 2, placeholder: 'Notes (intro, cues…)' }, v.notes || '');
    notes.addEventListener('keydown', (e) => e.stopPropagation());
    const row = (label, ...els) => h('label', { class: 'field' }, h('span', null, label), h('div', { class: 'field-row' }, ...els));
    const body = h('div', { class: 'song-form' },
      row('Title', title), row('Artist / team', artist),
      row('Key', keySel, tonSel, spellSel),
      row('Sound', presetSel), row('Voicing', vcSel),
      row('Transition', trSel, trTime, h('span', { class: 'mini-label' }, 's')),
      row('Tempo', tempo, h('span', { class: 'mini-label' }, 'BPM')),
      row('Notes', notes));
    const collect = () => ({
      title: title.value.trim() || 'Untitled song', artist: artist.value.trim(), key: +keySel.value, minor: tonSel.value === '1', spell: spellSel.value,
      preset: presetSel.value, voicing: +vcSel.value, transition: trSel.value, transTime: Math.max(0, Math.min(60, parseFloat(trTime.value) || 0)),
      tempo: Math.max(0, Math.min(400, parseFloat(tempo.value) || 0)), notes: notes.value,
    });
    const actions = [
      song ? { label: 'Delete', danger: true, action: () => { app.removeSong(song.id); } } : null,
      { label: 'Cancel', value: null },
      { label: song ? 'Save' : 'Add song', primary: true, action: () => { if (song) app.updateSong(song.id, collect()); else app.addSong(collect()); } },
    ].filter(Boolean);
    dialog({ title: song ? 'Edit song' : 'Add song', body, width: 460, actions, className: 'song-dialog' });
    setTimeout(() => title.focus(), 30);
  }

  // ------------------------------------------------------------ frame
  frame() {
    if (!this.el.isConnected || !this.app.ui.live) return;
    const app = this.app, e = app.engine;
    const b = e.meterBase('livepad');
    if (b >= 0) { const m = e.meters; this.meter.draw(m[b], m[b + 1], m[b + 2], m[b + 3], m[b + 4]); }
    if ((this.tick = (this.tick || 0) + 1) % 2) return;
    this.drawAtmosphere();
  }

  drawAtmosphere() {
    const s = this.atm, c = s.ctx, app = this.app, e = app.engine, st = app.liveState;
    if (s.w < 4) return;
    s.clear();
    const w = s.w, hh = s.h;
    const g = c.createLinearGradient(0, 0, 0, hh);
    g.addColorStop(0, '#13161a'); g.addColorStop(1, '#0d0f11');
    c.fillStyle = g; c.fillRect(0, 0, w, hh);
    // spectrum glow
    const an = e.analyser;
    if (an && e.state === 'running') {
      if (!this.spec || this.spec.length !== an.frequencyBinCount) this.spec = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(this.spec);
      const bin = e.sampleRate / an.fftSize;
      c.beginPath(); c.moveTo(0, hh);
      for (let x = 0; x <= w; x += 3) {
        const f0 = 40 * Math.pow(16000 / 40, x / w), f1 = 40 * Math.pow(16000 / 40, (x + 3) / w);
        let m = -140;
        for (let k = Math.floor(f0 / bin); k <= Math.ceil(f1 / bin) && k < this.spec.length; k++) if (this.spec[k] > m) m = this.spec[k];
        c.lineTo(x, hh - Math.max(0, Math.min(1, (m + 100) / 75)) * (hh - 6));
      }
      c.lineTo(w, hh); c.closePath();
      const sg = c.createLinearGradient(0, 0, 0, hh);
      sg.addColorStop(0, st.playing ? 'rgba(255,170,90,0.55)' : 'rgba(143,184,255,0.35)'); sg.addColorStop(1, 'rgba(255,143,60,0.02)');
      c.fillStyle = sg; c.fill();
    }
    // keyboard C2..C7 with the sounding notes
    const lo = 36, hi = 96, kw = w / (hi - lo + 1), ky = hh - 14;
    for (let n = lo; n <= hi; n++) {
      const black = [1, 3, 6, 8, 10].includes(n % 12);
      c.fillStyle = black ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.16)';
      c.fillRect((n - lo) * kw + 0.5, ky + (black ? 0 : 4), Math.max(1, kw - 1), black ? 6 : 10);
    }
    const accent = css('--accent') || '#ff8f3c';
    if (st.playing && st.chord) {
      c.fillStyle = accent;
      for (const n of st.chord) if (n >= lo && n <= hi) c.fillRect((n - lo) * kw, ky - 2, Math.max(2, kw), 14);
      const bn = st.bass + 12 * (app.p.live.patch.params['bass.oct'] | 0);
      if (app.p.live.patch.params['bass.on'] >= 0.5 && bn >= lo) { c.fillStyle = '#8fb8ff'; c.fillRect((bn - lo) * kw, ky - 2, Math.max(2, kw), 14); }
    }
    const t = e.padTele, info = e.state === 'running' ? `${Math.round(t[0])} voices · swell ${Math.round(t[6] * 100)}%${t[18] > 0.01 ? ' · transitioning' : ''}` : 'audio off — press Start';
    c.fillStyle = '#9aa3ab'; c.font = '10.5px var(--font-mono, monospace)';
    c.fillText(info, 10, 14);
  }
}

