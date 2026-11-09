# Saw Forge Studio

A digital audio workstation with a flagship wavetable synthesizer, **Saw Forge**,
built around analog-style, editable sawtooth wavetables. It also has worship pads
with Live Pad Mode, virtual EDM drummers, recording with take comping, and automation.
It runs as a desktop app on Windows and macOS, or in Chrome or Edge.

Free and open source under the [GNU GPL v3 or later](LICENSE).

## Download (Windows and macOS)

Get **Saw Forge Hub** from the [download page](https://tylermedlin.github.io/saw-forge/)
or the [Releases](../../releases) page. The hub installs and updates the Saw Forge
apps, starting with Saw Forge Studio.
- **Windows 10/11 (64-bit):** a setup wizard.
- **macOS 12 or later:** one universal disk image for Apple Silicon and Intel.

The [install guide](site/install.html) walks through every screen.

The desktop app is the same Studio in its own window. It needs no browser and no
Python, and it saves projects to `Documents/Saw Forge/Saw Forge Studio`. The
hub's source code, installers and release pipeline are in [`desktop/`](desktop) and
[`docs/RELEASING.md`](docs/RELEASING.md).

## Run it in a browser (development)

Requirements: Python 3 and Chrome or Edge (Chromium 110+).

```
python serve.py
```

Then open **http://127.0.0.1:8765** and choose *Demo session* (or *New project*).
Browsers need one click before audio can start; the welcome screen handles that.

`serve.py` matters: it sends the cross-origin-isolation headers that enable
lock-free metering through `SharedArrayBuffer`, and correct JavaScript MIME types
(Windows can misreport `.js`). Opening `index.html` from disk will not work.

Checks: open **http://127.0.0.1:8765/tests/** — 46 engine and workflow checks run
against the real audio engine (offline rendering) and report pass/fail.
`python tests/test_serve.py` checks the server's file saving (17 checks, in a temporary folder).

## Saving

When the app runs from `serve.py`, everything is saved to disk next to the app, so nothing
depends on the browser's save dialogs or storage:

| What | Where |
|---|---|
| **Ctrl+S** (Save) | `saves/<project name>.sfproj` |
| Previous versions (last 10 per project) | `saves/.history/<name> <date-time>.sfproj` |
| Unsaved work, written 3 s after each edit and every 15 s | `saves/.autosave/<name>.sfproj` |
| **Export WAV** | `exports/<name>.wav` |

- **First save** of a new project asks for a name, and asks before replacing a different
  project of the same name. After that, Ctrl+S saves straight to the same file.
  **Ctrl+Shift+S** saves a copy under a new name.
- **Opening:** the welcome screen offers *Continue “…”* (the most recently saved project) and
  *Recover “…”* when there is autosaved work newer than its last save. **Ctrl+O** lists everything
  in `saves/` and can still browse for a file elsewhere.
- **Security:** only the app's own page can write. The server refuses requests from other
  sites, and names are cleaned so files can't land outside `saves/` or `exports/`.
- Opened another way (no `serve.py` file store), the app falls back to the browser's save dialog
  or a download, plus the browser-storage autosave.

## Architecture

| Layer | Where it runs | What it does |
|---|---|---|
| UI (`src/ui`, `src/app.js`) | main thread | DOM + Canvas 2D views, store, undo, files |
| Engine bridge (`src/audio/engine.js`) | main thread | AudioContext, project → engine compile, shared-memory meters, offline export |
| Wavetable builder (`src/audio/wavetable-worker.js`) | Web Worker | FFT-based band-limited mip tables |
| Engine (`src/audio/worklet/*`) | real-time audio thread | transport, sequencing, Saw Forge, effects, mixer, metronome |

- **One AudioWorklet hosts the whole graph.** Notes are scheduled sample-accurately inside the
  audio callback, so timing does not depend on UI jank. The same processor renders exports offline,
  so exports match playback (verified bit-identical).
- **`process()` never allocates.** Voices, delay lines, reverb buffers and event queues are
  preallocated. Structural edits (new clip, new track) arrive as messages between render quanta.
- **Meters, playhead and CPU** are read from a `SharedArrayBuffer` written by the audio thread
  (postMessage fallback when not cross-origin isolated).
- **Undo** stores a JSON snapshot per edit; continuous gestures (knob drags) collapse to one step.
- **No third-party dependencies.** Everything is plain ES modules with no build step, so the
  app runs offline.

### Platform choice and tradeoffs

This machine had no Node, CMake, Rust or JUCE, so a native C++/JUCE build was not deliverable
in this session. The Web Audio API's AudioWorklet gives a dedicated real-time audio thread, a
stable output path and a GUI in one runnable package.

Costs of that choice:

- Output latency is higher than ASIO/CoreAudio (shown in the top bar, typically 10–50 ms).
- Plugin hosting is impossible in a browser.
- DSP runs in JavaScript. It is JIT-compiled and allocation-free, but slower than optimized
  native code.

The engine is isolated behind a message/shared-memory boundary, so its DSP can later move to
WebAssembly, or into a native shell, without rewriting the UI.

## Saw Forge

- **Two wavetable oscillators.** Each frame starts from an analog-style saw (ramp curvature,
  reset slope) or a hand-drawn cycle, then is shaped spectrally: 64 harmonic gains, even/odd
  balance and tilt.
- **Up to 8 key frames**, morphed by magnitude/phase interpolation into 30+ rendered frames,
  each stored as a 10-level band-limited mip chain.
- **Wavetable editor:** a 3D frame stack showing the live playing position (drag it to scan),
  plus *Shape*, *Harmonics* (paint gains) and *Draw* (draggable points, linear or smooth) modes.
- **Oscillator controls:** unison (8 voices) with detune, stereo spread, phase and phase
  randomness; octave/semitone/fine; hard sync with polyBLEP-corrected resets; dual-phase
  pulse-width shaping.
- **Analog drift** per voice, plus per-note variance (detune, cutoff, envelope time, level).
- **Sub** (sine/triangle/band-limited square) and **noise** (white/pink).
- **Filters:** LP12, LP24, HP, BP (state-variable) and a zero-delay-feedback ladder, with
  anti-aliased drive.
- **Modulation:** amp, filter and mod ADSRs; two LFOs (7 shapes, tempo sync, retrigger,
  transport lock); an 8-slot mod matrix (11 sources, 22 destinations); velocity and pitch bend.
- **Voice modes:** poly, mono and legato with glide and voice stealing.
- **Built-in FX:** distortion → chorus → delay → reverb → EQ.
- **Presets:** 17 factory presets (bass, lead, pluck, pad, supersaw, keys, FX) plus user
  presets saved in the browser.

Every parameter is smoothed, and modulation updates every 32 samples with per-sample ramps.
Drive uses antiderivative anti-aliasing. There is a NaN/blow-up guard that mutes and resets
instead of screaming.

## What works (milestone 1 — vertical slice)

- **Arrangement:** instrument, audio and return-bus tracks.
  - Clips: create, move (across tracks), resize, loop, trim, split, duplicate, copy/paste,
    mute, rename.
  - Navigation and timing: zoom, auto/fixed snap, loop region, markers.
  - Drag and drop from the browser or the OS.
- **Transport:** play/stop, MIDI record (armed or selected track; overdub into loops),
  tempo, time signature, metronome, 0/1/2-bar count-in.
  - Input sources: computer keyboard (`` ` `` toggles) and Web MIDI (notes, bend, mod wheel,
    sustain).
- **Piano roll:**
  - Notes: draw/select tools, move/resize/duplicate, velocity lane, quantize (strength,
    note ends), transpose, nudge.
  - Clip and keys: keyboard audition, loop-length handle.
- **Mixer:** peak + RMS meters with clip LEDs, faders, pan, mute/solo/arm, inserts (9 effect
  types), sends to buses, output routing, master.
- **Automation:** lanes for volume, pan, sends, every automatable Saw Forge parameter and every
  effect parameter. Draw them by hand, or record them from the controls (see below). Saw Forge
  knobs and mixer faders, pans and sends follow their lanes during playback.
- **Browser:** instruments, presets, effects, a synthesized drum kit, project audio, with search.
- **Files:**
  - `.sfproj` projects bundle the JSON with the original audio files.
  - Audio import (WAV/AIFF/MP3/OGG/FLAC as the browser decodes them).
  - WAV export: 16-bit dithered, 24-bit or 32-bit float; 44.1–96 kHz; whole song or loop;
    with tail.
- **Robustness:**
  - Autosave to `saves/.autosave/` (and the browser's storage) with recovery on next launch
    (see Saving).
  - Missing audio files load as offline clips.
  - Sample-rate, buffering and output-device settings (restarting the engine).
  - The engine recovers from processor errors and device changes.
- **Undo/redo** for every edit, with named steps.

## Audio recording (milestone 2)

- **Arm and record.** Arm an audio track (**R**) and press Record. Arming opens the input; the
  first time, the browser asks for microphone permission. MIDI and audio tracks can record in the
  same pass. Count-in, loop and punch-in while playing all work.
- **Input choice per track:** inputs 1+2 (stereo), input 1 or input 2 (mono), from the track
  header's context menu or the mixer strip. Mono devices always record mono.
- **Monitoring:** the headphones button plays the input through the track (its effects, fader
  and sends) while the track is armed. Use headphones; speakers will feed back.
- **Sample-accurate capture:**
  - The audio thread copies every input sample into a lock-free shared ring, in step with its
    own clock.
  - It marks the exact sample where the take starts (after the count-in) and where it stops.
  - The UI thread drains the ring every 40 ms while recording. If the page stalls for more than
    about 6 s, the gap is filled with silence so the rest stays in time, and the app says so.
- **Latency compensation:**
  - Takes are shifted earlier by the round trip a performer experiences (output + input
    latency).
  - The default is the browser's estimate. **Settings → Measure** plays clicks and listens for
    them (speakers into the mic, or a loopback cable) to measure the real value.
  - A ±100 ms fine adjustment is also available.
- **Loop recording** puts the most recent complete pass in the comp. Every pass is kept as its
  own take (see Take lanes and comping).
- **Overwrite:** a new take replaces the parts of existing audio clips it covers (they are
  split or trimmed), as on a tape track. While recording, the track's old audio is muted over
  the part being replaced, so you hear the input rather than the take you are replacing.
- **Input meter** in the top bar. A live waveform draws into the arranged position while
  recording.
- **Storage and faults:** takes are kept as float audio for playback and stored as 24-bit WAV
  inside the `.sfproj`. Unplugging the device ends the take cleanly and keeps what was recorded.
  The voice processing that browsers apply to microphones (echo cancellation, noise
  suppression, auto gain) is requested off.

## Punch in/out (milestone 2)

- **Set the range.** Press **I** (or the punch button next to Loop) to turn punch on. The red
  strip under the loop strip in the ruler is the punch range: drag in it to set the range, drag its
  edges or body to adjust it, double-click to toggle. The first time it copies the loop range
  (or the two bars at the playhead when the loop is off). The track area shows the range with
  dashed red lines.
- **Record.** With punch on, recording keeps only what happens inside the range. Pressing Record
  from stop starts playback 1 bar before the punch-in by default, so you hear the lead-in. The
  record button pulses while waiting for the punch-in and lights solid inside the range.
- **Pre-roll** (right-click the punch button or the punch strip): 1 bar or 2 bars before the
  punch-in, at the punch-in with the normal count-in, or from the playhead. A pre-roll replaces
  the count-in, since the lead-in is the cue.
- **What you hear while punching:** the track being recorded plays its old take up to the
  punch-in. Inside the range the old take is muted and you hear your input (if monitoring is on),
  then the old take comes back after the punch-out. The switch is a 5 ms crossfade. Old MIDI notes
  inside the range are muted the same way.
- **Audio result:**
  - The new take is cut to the punch range with 10 ms crossfades against the old audio at both
    punch points (when there is recorded audio to fade with).
  - With the loop on, the most recent pass that covered the whole punch range is kept.
  - The take file keeps 2 s either side of the range for adjusting the edits later, not the
    whole pre-roll.
- **MIDI result:** only notes that start inside the range are kept (cut at the punch-out). They
  replace the notes that started inside the range, and notes ringing into it are shortened to the
  punch-in. A looped MIDI clip is first turned into plain notes so the repeats outside the range
  stay as they were.
- **Undo:** each punch take is one undo step.

## Take lanes and comping (milestone 2)

- **Every take is kept.** Each audio recording, and each pass of a loop recording, goes into its
  own take lane under the track (newest on top, named Take 1, Take 2, …). A partial last pass is
  kept if it covers at least half the loop. The track itself holds the comp: what plays.
- **Show the lanes** with the takes button in an audio track's header. They open by themselves
  the first time a track has two or more takes.
- **Comp by swiping.** Drag across a take lane to use that range of it. A click on a take uses the
  whole take; **Use** in the lane header uses the whole lane. Swipes snap to the grid (hold Alt for
  free ranges). Each comp action is one undo step.
- **Clean edits:** every comp edge is a 10 ms crossfade. Where the take has audio past the edge,
  it runs on under the neighbour. Where it doesn't (a take that ends early), the neighbour runs on
  under the take instead. Neighbouring parts of the same take join into one clip, and leftover
  crossfade tails are removed.
- **See what is used:** each lane draws the parts in the comp at full strength and the rest
  faded, and its header shows how much of it is in the comp.
- **Audition** (headphones button in the lane header): the track plays that take instead of the
  comp until you click it again. Auditioning is not saved and does not affect export.
- **Housekeeping:** rename a take (double-click its header), delete it, or *Delete unused takes*
  from the lane's right-click menu. Comp clips keep playing after their take is deleted.
- **Files:** take lanes are saved in the `.sfproj`, including audio used only by takes.
  Duplicating a track duplicates its takes and comp.

## Automation writing (milestone 2)

- **Arm and write.** Press **W** (or the automation button in the top bar) to arm writing, then
  play. Moving any automatable control writes it into its lane at the playhead: Saw Forge
  knobs, effect knobs, and mixer volume, pan and sends. The lane is created and shown
  automatically. The static value is left alone.
- **Touch** (default) writes while you hold the control, overwriting what it passes. On release
  the lane glides back to the curve it had before (or to the static value) over a 1/16 beat.
- **Latch** keeps writing the value you let go at until the transport stops.
- **Loop recording:** holding a control across a loop wrap writes the end and the start of the
  loop, so you can refine a pass on each cycle.
- **What you hear:** the control is audible immediately. The engine marks that lane as
  "touched", so its old points don't fight your hand; playback reads the lane again once you
  let go.
- **Clean results:**
  - Points are thinned while writing and simplified afterwards (anything within 0.4% of the
    range of a straight line is dropped).
  - Holding still writes a flat line with no extra points.
- **Undo:** each touch is one "Write automation" step. A latch tail becomes its own step when
  the transport stops.

## Worship Atmospheres and Live Pad Mode

A second flagship instrument: a continuously sustaining, analog-inspired worship pad synthesizer,
plus a live performance mode and setlists. It sits beside Saw Forge in the browser and uses the
same audio engine, band-limited oscillator tables, filters and effects.

### Live Pad Mode (press **P**, or **LIVE PAD** in the top bar)

The pad runs on its own always-on channel, so it keeps playing whether the DAW transport is
stopped or playing.
- **Start / Stop:** one click, with a smooth fade in and fade out (both adjustable). Stopping
  closes a gate ahead of the effects, so the reverb tail rings out naturally.
- **Keys:** all 12 keys on a circle of fifths, in major or minor. Enharmonic spelling is automatic
  (D♭, F♯, B♭…) or set to sharps or flats.
- **Harmony:** Root + Fifth, Root + Octave, Open Fifths, Triad, Add9, Sus2, Sus4, Seventh (maj7 or
  min7), Wide Worship, or custom intervals. Register (Low/Mid/High) and density are adjustable.
  The voicing engine keeps thirds out of the muddy low register.
- **Key transitions:** Immediate, Gentle crossfade, or Slow atmospheric (a longer fade with a
  brief filter wash), from 0.5 to 60 s.
  - The outgoing chord fades out as the new one fades in, with equal-power curves, so the level
    doesn't build up.
  - With voice leading on, notes the two chords share keep sounding and the new chord is placed
    near the old one.
- **Sounds:** the 40 factory presets in five collections. Changing preset crossfades to the new
  sound (0.1 to 30 s) without changing the key; "Keep voicing" keeps your harmony too.
- **Layers and motion:**
  - Levels for pad, strings (with the string sound picker), bass foundation, air/texture, shimmer
    and reverb.
  - EVOLVE amount, BREATHE amount and auto swell, plus a **Swell** button for a manual swell.
  - **Panic:** silences the pad within 30 ms.
- **Monitoring:** a spectrum of the pad, the notes sounding right now on a keyboard, voice count
  and swell level.
- **Editing the sound:** **Edit sound** opens the modular editor below.

### Setlists

A setlist is an ordered list of songs. Each song has:
- title and artist or team
- key and major/minor, with spelling
- a sound (or "keep current"), a voicing, a transition and its time
- tempo and notes

**Go** (or **Enter**) moves the pad to the selected song, crossfading its sound and moving to its
key. **← →** step through the list. The pad never stops between songs. Setlists are saved with the
project.

### The instrument (modular editor, bottom panel → Instrument)

The signal flows **Sources → Filters → Modulation → Layer mixer → Effects → Master**:
- **Sources:**
  - Four oscillator slots: sine, triangle, saw, square, pulse (PWM), a morph across those shapes,
    or a user-editable wavetable (the Saw Forge wavetable editor).
  - Each slot has unison (up to 7), detune, stereo spread, analog drift, octave, semitone, fine,
    pan and a choice of filter.
  - Also: a noise/air texture, the string ensemble and the bass foundation.
- **Filters:** two shared filters (LP12, LP24, ladder, HP, BP) with drive, key tracking and swell
  amount.
  - They are paraphonic: every note in a layer shares its filter, like classic string machines,
    so a whole chord breathes together and big chords stay affordable.
- **Modulation:**
  - Swell envelope: attack 0.1–60 s, release 0.5–120 s, adjustable curve, sustain and intensity.
  - Auto swell repeats with adjustable depth. Its depth is capped at 85% and the bass foundation
    ignores it, so the harmony never goes silent.
  - Two LFOs (free or tempo-synced) and a six-slot matrix.
  - **EVOLVE:** slow, non-repeating random motion of morph, cutoff, detune, stereo, strings and
    level.
  - **BREATHE:** each note of the chord fades softly in and out on its own clock, so voices of a
    held chord come and go independently. Controls:
    - **Amount** and **Speed** (0.02–1 Hz).
    - **Floor:** the lowest level a note dips to, so it never disappears.
    - **Hold root:** keeps the lowest note steady.
    The average level is compensated, so turning it up doesn't make the pad quieter. Eight presets
    use it gently: Still Waters, Open Heavens, Sacred Silence, Resting Place, Infinite Grace,
    Ocean of Peace, Whispering Spirit and Endless Worship.
- **String ensemble:**
  - Ten sounds: Warm, Soft Violins, Cinematic, Lush Ensemble, Ambient, Slow Swell, Chamber, Deep
    Cellos, High Strings and Analog String Machine.
  - Each has its own volume, attack/release/sustain, swell, width, brightness, vibrato, ensemble
    movement, octave, cutoff, reverb send and pad blend.
  - These are synthesized (detuned saw sections, bowed vibrato, body resonances and string-machine
    chorus), not sampled orchestral recordings.
- **Bass foundation:** root only, with its own level, octave and low-pass. It sits below the pad's
  low cut so the pad stays clear of the bass guitar and kick.
- **Effects and master:** saturation, chorus, delay, reverb and octave-up shimmer (both as sends,
  so tails survive key and preset changes), stereo width and motion, low cut, 3-band EQ, output
  trim and a safety limiter.
- **Visuals:** waveform previews, filter curves, the swell shape with live level, live LFO
  positions, EVOLVE activity, layer meters, stereo width and a spectrum.

On a track, it plays like any instrument from the piano roll, a MIDI keyboard or the computer
keyboard:
- **Notes:** play as normal.
- **Chord from root:** one key plays the full voiced chord.
- **Hold:** infinite sustain until the next chord.

Its parameters can be automated (drawn or written) like Saw Forge's.

### Factory presets (40)

- **Warm Analog Foundations:** Warm Sanctuary, Golden Presence, Vintage Worship, Deep Foundation,
  Analog Heaven, Soft Ember, Cathedral Warmth, Midnight Analog.
- **Ethereal Worship Atmospheres:** Heavenly Atmosphere, Holy Ground, Eternal Light, Still Waters,
  Open Heavens, Glory Cloud, Quiet Presence, Endless Horizon.
- **Cinematic Strings and Synth Hybrids:** Celestial Strings, Majestic Swell, Worship Orchestra,
  Emotional Strings, Eternal Symphony, Warm String Cloud, Glorious Rise, Tender Strings.
- **Deep Ambient and Prayer Pads:** Prayer Room, Deep Peace, Sacred Silence, Resting Place, Mercy
  Flow, Infinite Grace, Ocean of Peace, Whispering Spirit.
- **Modern Worship and Powerful Swells:** Anthem Rise, Radiant Worship, Awakening, Kingdom
  Atmosphere, Mountain of Glory, Living Hope, Eternal Anthem, Endless Worship.

Every preset is its own synthesis configuration: oscillators, filters, envelopes, modulation,
layers, voicing and effects. A test checks that no two are identical. Each is loudness-calibrated
so switching presets doesn't jump in level.

## Drummer (virtual EDM drummers)

A Drummer track is a synthesized EDM drum kit plus a virtual drummer who plays it, in the spirit
of GarageBand's Drummer. Add one with **+ Drummer** in the arrangement toolbar, or double-click
**Drummer** or any drummer under **EDM Drummers** in the Browser. You get an 8-bar region to start.

### Pick a drummer by personality

Nine drummers, each with their own grooves, favourite fills and a matching kit:

| Drummer | Style | Personality | Natural tempo |
|---|---|---|---|
| Nova | Big Room | Bold, Energetic | 128 |
| Jax | Deep House | Laid-back, Groovy | 122 |
| Vex | Techno | Hypnotic, Precise | 130 |
| Sol | Trance | Uplifting, Precise | 138 |
| Kira | Future Bass | Playful, Dreamy | 150 (half-time feel) |
| Ace | Trap | Swagger, Aggressive | 140 (half-time feel) |
| Riot | Dubstep | Aggressive, Heavy | 140 (half-time feel) |
| Zed | Drum & Bass | Nimble, Energetic | 174 |
| Milo | Lo-Fi / Chill | Mellow, Laid-back | 85 |

In the Drummer editor (bottom panel → **Instrument**), filter the list by **Personality** and sort it
by loudness, fills, technique or speed. Each card shows the drummer's natural Fill, Speed, Loudness
and Technique. Clicking a drummer gives the whole track to them, switches to their kit, and loads
their natural feel into the region you're editing. **Use N BPM** sets the project to their tempo.

### Shape how they play (per region)

- **Technique × Loudness pad:** left–right goes from simple to complex; down–up goes from soft to
  loud. The dashed ring marks the drummer's natural spot.
  - **Technique** adds optional hits, ghost notes, extra percussion and (for Kira and Ace) hi-hat rolls.
  - **Loudness** raises velocities, opens the hats, layers snare on clap and adds crashes and ride.
- **Fills:** at 0 there are none. Turning it up adds fills more often (every 8 bars, then every 4) and
  makes them longer (one beat up to a full bar). Near the top you also get pickups, and on regions of
  8+ bars a two-bar build with a snare roll, a riser and a short silence before the drop.
- **Speed:** Half time, Normal or Double time for the kick and snare. The hats stay in tempo.
- **Swing** (straight to triplet shuffle), **Feel** (pushed ahead of the kick, or laid back behind
  it) and **Humanize** (timing and velocity looseness).
- **Parts:** Kick & Snare, Hi-Hats, Percussion, Cymbals & FX. Each can be switched on or off and has
  four pattern variations. The lights flash as each piece plays.
- **Groove** shows the bar under the playhead as a step grid.
- **New take** re-rolls the variations and fills with the same settings. **Convert to MIDI** turns
  the region into an ordinary MIDI clip you can edit note by note (Ctrl+Z brings the region back).

Regions behave like clips: move, resize, split, duplicate, copy and mute them. Double-clicking an
empty part of a drum track adds a region with the settings of the one before it. Ordinary MIDI clips
on a drum track play the kit too, and the piano roll labels rows with the kit pieces (General MIDI
layout: Kick 36, Snare 38, Clap 39, Closed Hat 42, Open Hat 46, Crash 49, Ride 51, toms 41/45/48,
Shaker 70, Perc 56; risers on 84/85/86 sweep for 1, 2 or 4 bars).

### The kit

Every sound is synthesized live on the audio thread, with no samples. Kicks are pitch-swept sines,
snares are tone plus noise, claps are multi-burst noise, and hats and cymbals use six detuned square
waves. Percussion is FM, and risers are a sweeping noise band-pass.

There are nine kits: Festival, House, Techno, Trance, Future, Trap, Heavy, Breaks and Lo-Fi. The
**Kit Sound** controls are kick tune/decay/punch, snare tune/snap/decay, hat decay/tone, cymbal
decay, tom tune, six group levels, width, drive, tone, velocity sensitivity and output. A closed hat
chokes the open hat. Click any pad to hear it. All kit controls can be automated.

## Validation (tests page, all passing)

| Check | Result |
|---|---|
| Wavetable mips out-of-band energy | −151 dB |
| C7 sawtooth at 48 kHz, alias power | −94 dB |
| Hard sync +19 st, alias power | −62 dB |
| Note onset accuracy | within 2 samples |
| Every factory preset, 4-note chord | below 0 dBFS, audible, no NaN |
| Sample-rate independence (44.1 vs 96 kHz) | 0.00 dB |
| Offline render repeatability | bit-identical |
| Edit → save → reopen → export | bit-identical |
| Mixer gain, mute/solo, sends, automation | exact |
| All effects at extreme settings | bounded, finite |
| Input capture vs engine clock | exact, every sample |
| Take start after a 1-bar count-in | exact sample |
| Input monitoring routes the chosen channel only | exact |
| Take placement: straight, loop passes, wraparound, overwrite | exact |
| Punch takes: trim, crossfades, loop passes, MIDI replace with looped clips | exact |
| Punch playback: old take → input → old take at the punch points | no step larger than the signal's own |
| In-app audio punch over an older take (220 Hz take, 660 Hz punch), rendered | 220 / 660 / 220 Hz, no clicks |
| Take lanes: passes → takes, swipe comp, joins, shorter takes, audition, save/reload, duplicate | exact |
| Comp crossfades between takes, rendered | no step larger than the signal's own, no dip |
| In-app loop recording (4 passes, a different tone each) comped by mouse, rendered | each range plays its pass, no clicks |
| In-app recording through a fixed input path (6 beat clicks) | 0 samples error |
| Recorded project: save → reopen → export | bit-identical |
| Automation write: touch + return, overwrite, latch hold, loop wrap, undo steps | exact |
| In-app written cutoff sweep, read back by the engine | follows the lane |
| Worship presets: 40 distinct configurations, sustained chord | no NaN, peak < 1, loudness within 3 dB, brightest centroid ≈ 2.5 kHz |
| Worship key change G → D (3 s, voice leading) | level stays within the pad's own movement; no click; common tones held |
| Worship preset crossfade, stop fade, reverb tail, panic | no dropout; tail rings ~2.5 s after stop; panic → silence |
| Worship live pad through the audio engine with the transport stopped | plays |
| Worship on a track: notes, chord-from-root, hold | exact |
| Worship breathe (24 s, full amount) | notes move independently (mean correlation ≈ 0.24); lowest note steady; dips stay above the floor; average level within 0.1 dB; no clicks |
| In-app Live Pad Mode: start, key ring click, setlist ← → with preset + key change | works; 10–16% audio-thread load |
| Drummer: 9 drummers, valid patterns, deterministic takes | every drummer has kick + backbeat; same seed → same groove |
| Drummer controls (Technique, Loudness, Fills, Speed, Swing, Feel, parts) | 97 → 295 hits; velocity 0.35 → 0.72; claps 8 / 16 / 32 for half / normal / double; swing lands on the triplet |
| Drummer builds | 2-bar riser, accelerating snare roll with crescendo, half-beat gap before the drop, crash after each fill |
| Drum kit: 9 kits × 13 pieces | no NaN, peaks below 0 dBFS; open hat choked by the closed hat; riser sweeps up |
| Drummer region through the audio engine; save and reload; MIDI conversion | kick on the beat; region survives a round-trip; conversion keeps every hit |

Measured cost of an 8-voice, 14-oscillator supersaw with FX: about 5% of one CPU core.
The full demo session runs at about 10% audio-thread load. The heaviest Worship Atmospheres
preset (Endless Worship, 7-voice chord, strings, shimmer) uses about 10% of one core; a preset
crossfade briefly runs two.

## Limits and deferred work

- **No VST3/AU/CLAP hosting.** Not possible in a browser; it needs the native shell (milestone 4).
- **Worship Atmospheres limits:**
  - Strings are synthesized, not sampled.
  - Filters are paraphonic (one filter per layer, shared by its notes), by design.
  - User presets for Worship Atmospheres are not built yet: edits are saved with the project, and
    there are the 40 factory presets.
  - The live pad is not part of WAV export (it is a live instrument). To record it, put Worship
    Atmospheres on a track.
  - Setlist songs can't yet be triggered by MIDI program change or a foot switch.
  - The setlist part of the brief was cut off in the message received; what's built covers
    title, artist, key, major/minor and the extras listed above.
- **Recording limits:**
  - Takes are held in memory until the project is saved: about 23 MB per minute of stereo at
    48 kHz.
  - Take lanes are for audio tracks only. MIDI recording still merges into a clip (or replaces
    the punch range); there are no MIDI take lanes.
  - Comp edges can't be dragged directly: re-swipe to move an edge. There is no "next/previous
    take" key for a comp section yet.
  - Punch takes keep 2 s of handle either side of the range in their file, not the whole
    pre-roll.
  - Punch applies to the whole recording; there is no per-track punch.
  - In loop recording, a punch point that sits exactly on the loop start or end is a plain cut
    with the engine's short declick, not a 10 ms crossfade (the neighbouring audio belongs to
    another pass).
  - Software monitoring adds the device round trip. For zero-latency monitoring, use your
    interface's direct monitoring.
  - Latency through the browser's audio path can differ between sessions. Re-measure if takes
    sound early or late.
  - Browsers may still process some microphones despite the request to turn processing off.
  - Device permission prompts and real-hardware latency were not exercised in automated
    testing (a synthetic input was used).
- **Single tempo and time signature per project.** No tempo map. Audio clips play at native
  speed (no time-stretch).
- **Automation writing limits:**
  - Touch and Latch only: no "Write" mode that overwrites untouched lanes, and no per-track
    modes.
  - Enum and on/off parameters (filter mode, LFO shape, toggles) cannot be automated.
  - Points land where the engine is rendering, so they match what you heard live.
  - Lanes edited by hand while they are being written are overwritten by the write.
- **Missing editing UI:** sends are post-fader with no pre/post toggle in the UI; clip fades
  exist in the engine but have no drag handles; buses cannot feed other buses.
- **Missing MIDI features:** no MIDI file import/export and no CC lanes.
- **Chromium-specific APIs:** output-device selection, in-place save (File System Access) and
  Web MIDI are Chromium features. Other browsers fall back to downloads, or the feature is
  unavailable.
- **Audio-thread messages:** project edits and parameter moves reach the audio thread as
  messages. That deserialization happens between render calls, not inside `process()`.
  A shared-memory parameter ring would remove even that.

## Roadmap

- **Milestone 2** (audio input recording, automation writing, punch in/out and take lanes done):
  - Recording: MIDI take lanes; draggable comp edges.
  - Editing: pre/post send toggle; clip fade and gain handles.
  - MIDI: MIDI file import/export; CC/pitch-bend lanes in the piano roll.
- **Milestone 3:**
  - Tempo and audio: tempo map; audio warping.
  - Mixing: group/VCA tracks; sidechain compression.
  - Performance and export: track freeze; stem export.
  - DSP: move to WebAssembly.
- **Milestone 4:** desktop shell (Tauri) with a native audio backend (ASIO/WASAPI exclusive,
  CoreAudio) and VST3/CLAP hosting.

## Layout

```
serve.py                 local server (headers, MIME types, file saving for saves/ and exports/)
saves/, exports/         your projects, their history and autosaves; WAV exports
index.html, styles/      app shell and theme
src/app.js               controller: actions, transport, recording, files, autosave
src/core/                project model, store/undo, .sfproj I/O, recovery, assets
src/audio/               engine bridge, compiler, input capture + take planning, WAV, samples, table worker
src/audio/worklet/       audio-thread engine, Saw Forge, Worship Atmospheres (worship.js), drum kit (drums.js), effects
src/shared/              parameter definitions, wavetable math, presets, DSP helpers, drum kits (drums.js), drummers + groove generator (drummers.js)
src/ui/                  arrangement, piano roll, mixer, Saw Forge / Worship / Drummer editors, Live Pad Mode, effects, browser
tests/                   engine & workflow checks (open /tests/ in the browser); test_serve.py
desktop/                 Saw Forge Hub: Electron shell, hub UI, app packer, installers (see docs/RELEASING.md)
site/                    download website (GitHub Pages)
.github/workflows/       CI self-test on Windows + macOS; tag → signed-when-configured release
```

## Desktop architecture

- **Saw Forge Hub** (Electron 45) is the only thing users install.
  - It serves its UI and every installed app from a private `sawforge://` scheme, with
    the cross-origin-isolation headers the audio engine needs (SharedArrayBuffer).
  - It answers the apps' `/__store/*` save requests from `Documents/Saw Forge/<App>`,
    a Node port of `serve.py`.
- **App packages:** each app is a reproducible zip of its web files plus `.sawforge/app.json`.
  - The packages and their SHA-256 are listed in `catalog.json`, both in the hub and on the website.
  - The hub verifies the checksum before unpacking, installs per user, adds Start-menu
    shortcuts on Windows, and keeps projects when an app is updated or removed.
- **App windows** are sandboxed (no Node), with microphone and MIDI permissions for Saw Forge apps only.
  - Closing with unsaved work asks first.
  - On macOS, Cmd+Z goes to the app's own undo.
- **Installers:**
  - Windows: an NSIS wizard (license page, per-user or all users, folder choice, shortcuts, uninstaller that also removes hub-installed apps).
  - macOS: a universal DMG with drag-to-Applications.
  - Auto-update comes from GitHub Releases.
- **Checks:** `npm run selftest` installs and boots every app headlessly. It checks
  isolation, the audio worklet, save/list/read-back and uninstall.

Press `?` in the app for the full shortcut list.
