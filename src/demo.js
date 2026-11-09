// Demo session: a 4-bar loop that exercises instruments, audio clips,
// a send bus, master insert and an automation lane.

import { newProject, newTrack, newBus, newInsert, newMidiClip, newAudioClip, newLane, newNote } from './core/project.js';
import { FACTORY_PRESETS } from './shared/presets.js';

const preset = (n) => FACTORY_PRESETS.find((p) => p.name === n);

export async function buildDemoProject(app) {
  const p = newProject('Saw Forge Demo');
  p.tempo = 124;
  p.loop = { on: true, start: 0, end: 16 };
  p.markers = [{ id: 'mrk_a', beat: 0, name: 'Groove' }, { id: 'mrk_b', beat: 8, name: 'Lift' }];

  const verb = newBus(p, 'Reverb Bus');
  verb.inserts.push(newInsert('reverb', { mix: 1, decay: 3.2, size: 0.75, pre: 18 }));
  verb.vol = -4;
  p.buses.push(verb);

  // Chords
  const chords = newTrack(p, 'instrument', { preset: preset('Hyper Supersaw'), name: 'Supersaw Chords' });
  chords.vol = -9;
  p.tracks.push(chords);
  const prog = [[57, 60, 64, 69], [53, 57, 60, 65], [55, 60, 64, 67], [55, 59, 62, 67]];
  const chordNotes = [];
  prog.forEach((ch, bar) => {
    for (const hit of [[0, 1.4], [1.5, 0.9], [2.5, 1.4]]) for (const n of ch) chordNotes.push(newNote(n, bar * 4 + hit[0], hit[1], 0.72));
  });
  chords.clips.push(newMidiClip(0, 16, chordNotes, 'Chords'));
  chords.sends.push({ busId: verb.id, level: -12, pre: false });
  const cut = newLane('inst:flt.cut');
  cut.points = [[0, 0.58], [12, 0.86], [16, 0.97]];
  chords.automation.push(cut);
  chords.showLanes = true;

  // Bass
  const bass = newTrack(p, 'instrument', { preset: preset('Acid Ladder'), name: 'Acid Bass' });
  bass.vol = -5;
  p.tracks.push(bass);
  const roots = [33, 29, 36, 31];
  const pat = [[0, 0, 0.95], [2, 12, 0.6], [3, 0, 0.7], [4, 0, 0.9], [6, 12, 0.65], [7, 7, 0.75], [8, 0, 0.95], [10, 12, 0.6], [11, 0, 0.7], [12, 0, 0.9], [14, 15, 0.75, 0.3], [15, 12, 0.65]];
  const bassNotes = [];
  roots.forEach((r, bar) => { for (const [st, iv, v, l] of pat) bassNotes.push(newNote(r + iv, bar * 4 + st * 0.25, l || 0.2, v)); });
  bass.clips.push(newMidiClip(0, 16, bassNotes, 'Acid Line'));

  // Pluck arpeggio
  const pluck = newTrack(p, 'instrument', { preset: preset('Glass Pluck'), name: 'Glass Arp' });
  pluck.vol = -10;
  p.tracks.push(pluck);
  const arps = [[69, 72, 76, 72, 81, 76, 72, 76], [65, 69, 72, 69, 77, 72, 69, 72], [67, 72, 76, 72, 79, 76, 72, 76], [67, 71, 74, 71, 79, 74, 71, 74]];
  const arpNotes = [];
  arps.forEach((a, bar) => a.forEach((n, i) => arpNotes.push(newNote(n, bar * 4 + i * 0.5, 0.4, i % 2 ? 0.55 : 0.75))));
  pluck.clips.push(newMidiClip(0, 16, arpNotes, 'Arp'));
  pluck.sends.push({ busId: verb.id, level: -6, pre: false });


  // Drums from the factory kit
  const kit = app.factorySamples;
  const kick = kit.find((s) => s.name === 'Forge Kick'), clap = kit.find((s) => s.name === 'Clap'), hat = kit.find((s) => s.name === 'Closed Hat');
  const add = async (s) => {
    const item = await app.assets.add({ id: s.id, name: s.name, bytes: s.bytes, factory: true });
    p.assets.push({ id: s.id, name: s.name, duration: item.duration, factory: true });
    return item;
  };
  const kickA = await add(kick), clapA = await add(clap), hatA = await add(hat);
  const drum = (name, asset, beats, len, vol, send) => {
    const t = newTrack(p, 'audio', { name });
    t.vol = vol;
    for (const b of beats) t.clips.push(newAudioClip(asset, b, len, name));
    if (send) t.sends.push({ busId: verb.id, level: send, pre: false });
    p.tracks.push(t);
  };
  const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  drum('Kick', kickA, range(16, (i) => i), 1, -3);
  drum('Clap', clapA, range(8, (i) => i * 2 + 1), 0.9, -8, -10);
  drum('Hats', hatA, range(16, (i) => i + 0.5), 0.35, -13);

  p.master.inserts.push(newInsert('limiter', { ceil: -0.5, gain: 1 }));
  return p;
}
