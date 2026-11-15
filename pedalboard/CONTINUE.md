# Worship Pedalboard: build status

Spec: the "Saw Forge Hub — Worship Guitar Pedalboard" brief (14 Nov 2026).

## Done: Milestone 1, live guitar engine (app 0.1.0)
- New Hub app `worship-pedalboard`, self-contained in `pedalboard/` (own index.html, no build step). Registered in `desktop/apps.json`; icon drawn by `make-assets.mjs`.
- Audio graph (`src/audio/engine.js`): guitar input → **pre** worklet (input gain, channel pick, noise gate, pedals before the amp in mono, amp, L/R) → ConvolverNode cabinet (crossfaded bypass) → **post** worklet (pedals after the amp in stereo, volume, width/mono, mute, limiter at −1 dBFS, runaway-feedback protection) → output.
- One worklet file (`src/audio/pedalboard-processor.js`) runs both sections; DSP lives in `src/dsp/` (`core.js` filters/oversampler, `effects.js`, `amp.js`); definitions in `src/shared/defs.js` (pedals, voices, 7 amps, 6 cabs).
- Pedals so far: studio-comp, transparent-od, midhump-od, digital-delay, dotted-delay, analog-delay, hall-reverb, plate-reverb.
- Board model and storage in `src/board.js` (localStorage, versioned `sawforge-pedalboard` format v1, import/export as JSON, corrupt data falls back to the starter board).
- Audio never starts by itself; the TEST SIGNAL (Karplus-Strong plucks) is clearly labelled.
- Selftest: `main.js` uses `window.__sawforgeWorklet` so each app names its own worklet.

## Tested here
- `node tests/pedalboard-dsp.mjs`: all pass (dynamics, drive harmonics + pick sensitivity, 450 ms dotted-eighth at 100 bpm, bounded feedback, RT60, stereo width, spillover, every amp model, reorder changes output).
- Headless Chrome with a simulated audio interface playing a guitar recording: input reaches the app, output is processed, drive/bypass/amp-off/mute/tap tempo/persistence/reload-stays-silent all work. Packed zip is reproducible and boots from its own root.
- NOT tested: a real guitar and interface, real latency, MIDI, listening quality.

## Next: Milestone 2 (editor)
1. Drag-and-drop reorder (pointer events on `.pedal`, the amp block is draggable too); keep ◀ ▶ as keyboard fallback.
2. Undo/redo: snapshot `board` JSON per edit (same approach as Studio's `src/core/store.js`).
3. Duplicate, rename, reset pedal, copy/paste pedal settings, pedal library panel with search and family filter.
4. Saved boards list (several named boards) via the Hub file store `/__store` (check which save kinds `serve.py` and `handleStore` in `desktop/main/main.js` accept), keeping localStorage as the current-board cache.
Then M3 (remaining effect types), M4 (30 factory boards), M5 (scenes + MIDI), M6 (routing + setlists), M7 (testing).
