// Board data model, the starter board, and saving/loading (versioned format).

import { PEDALS, AMPS, ampById, pedalDefaults, ampDefaults } from './shared/defs.js';

export const FORMAT = 'sawforge-pedalboard';
export const VERSION = 1;
const KEY_BOARD = 'sawforge.pedalboard.board.v1';
const KEY_SETTINGS = 'sawforge.pedalboard.settings.v1';

let uidN = 0;
export const newUid = () => `p${Date.now().toString(36)}${(uidN++).toString(36)}`;

export function newPedal(type, over = {}) {
  return { uid: newUid(), type, on: true, name: '', params: { ...pedalDefaults(type), ...over } };
}
export function newAmp(model = 'chime30', over = {}) {
  const m = ampById(model);
  return { model: m.id, on: true, cabOn: true, cab: m.cab, cabB: m.cabB || null, mic: 35, dist: 20, params: { ...ampDefaults(), ...over } };
}

// The Milestone 1 starter board (a first version of "Sanctuary Clean").
export function starterBoard() {
  return {
    format: FORMAT, version: VERSION, name: 'Sanctuary Clean (starter)', bpm: 72,
    chain: [
      newPedal('studio-comp', { sustain: -28, ratio: 3.5, attack: 15, release: 220, level: 5, blend: 65 }),
      newPedal('transparent-od', { drive: 22, tone: 55, level: -1, clean: 40 }),
      { uid: 'amp', type: 'amp' },
      newPedal('dotted-delay', { feedback: 30, mix: 24, tone: 5000, lowcut: 250, mod: 8, mode: 1 }),
      newPedal('hall-reverb', { decay: 3.8, mix: 24, predelay: 30, size: 75, tone: 5500, lowcut: 250, mod: 35 }),
    ],
    amp: newAmp('chime30', { gain: 28, bass: 4.5, mid: 5.5, treble: 5.5, presence: 4.5, master: 45, sag: 45, bright: 35, output: 0 }),
  };
}

export const defaultSettings = () => ({ inputId: '', outputId: '', channel: 0, inputGain: 0, gateOn: true, gateThr: -64, gateRel: 120, volume: -6, width: 100, mono: false, seenIntro: false });

// Validate anything loaded from storage or a file; throws with a readable message.
export function cleanBoard(b) {
  if (!b || typeof b !== 'object') throw new Error('This is not a pedalboard file.');
  if (b.format !== FORMAT) throw new Error('This is not a Saw Forge pedalboard file.');
  if (typeof b.version !== 'number' || b.version > VERSION) throw new Error(`This board was made by a newer version (format ${b.version}). Update Worship Pedalboard to open it.`);
  const chain = [];
  let amp = false;
  for (const x of Array.isArray(b.chain) ? b.chain : []) {
    if (x && x.type === 'amp') { if (!amp) { chain.push({ uid: 'amp', type: 'amp' }); amp = true; } continue; }
    if (!x || !PEDALS[x.type]) continue; // unknown pedal types are skipped, not fatal
    const def = pedalDefaults(x.type), params = {};
    for (const q of PEDALS[x.type].params) {
      const v = x.params && Number(x.params[q.k]);
      params[q.k] = Number.isFinite(v) ? (q.enum ? Math.max(0, Math.min(q.options.length - 1, Math.round(v))) : Math.max(q.min, Math.min(q.max, v))) : def[q.k];
    }
    chain.push({ uid: typeof x.uid === 'string' && x.uid ? x.uid : newUid(), type: x.type, on: x.on !== false, name: typeof x.name === 'string' ? x.name.slice(0, 40) : '', params });
  }
  if (!amp) chain.push({ uid: 'amp', type: 'amp' });
  const a = b.amp || {}, m = ampById(a.model);
  const amp2 = newAmp(m.id);
  for (const k of Object.keys(amp2.params)) { const v = a.params && Number(a.params[k]); if (Number.isFinite(v)) amp2.params[k] = v; }
  amp2.on = a.on !== false; amp2.cabOn = a.cabOn !== false;
  if (typeof a.cab === 'string') amp2.cab = a.cab;
  if (typeof a.cabB === 'string' || a.cabB === null) amp2.cabB = a.cabB;
  for (const k of ['mic', 'dist']) if (Number.isFinite(Number(a[k]))) amp2[k] = Math.max(0, Math.min(100, Number(a[k])));
  const bpm = Number(b.bpm);
  return { format: FORMAT, version: VERSION, name: String(b.name || 'Untitled board').slice(0, 60), bpm: Number.isFinite(bpm) ? Math.max(40, Math.min(240, bpm)) : 120, chain, amp: amp2 };
}

export function loadBoard() {
  try { const raw = localStorage.getItem(KEY_BOARD); if (raw) return { board: cleanBoard(JSON.parse(raw)) }; }
  catch (err) { return { board: starterBoard(), warning: `Your saved board couldn't be read (${err.message}), so the starter board was loaded.` }; }
  return { board: starterBoard() };
}
export function saveBoard(board) { try { localStorage.setItem(KEY_BOARD, JSON.stringify(board)); } catch {} }
export function loadSettings() {
  try { const s = JSON.parse(localStorage.getItem(KEY_SETTINGS) || 'null'); if (s && typeof s === 'object') return { ...defaultSettings(), ...s }; } catch {}
  return defaultSettings();
}
export function saveSettings(s) { try { localStorage.setItem(KEY_SETTINGS, JSON.stringify(s)); } catch {} }

export function exportBoardFile(board) {
  const blob = new Blob([JSON.stringify(board, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${board.name.replace(/[^\w\- ]+/g, '').trim() || 'board'}.sfboard.json`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export { AMPS };
