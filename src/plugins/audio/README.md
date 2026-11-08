# Audio plugin — handover notes for the app agent

**Status 2026-11-08:** plugin **built and tested** (`src/plugins/audio/`, plugin 1.0.1, chainVersion 2,
lookVersion 1). **Not integrated** into the app: pipeline, settings, IPC and UI are untouched — that is
the app agent's job (section 6). Spec: `Yoosy Joosy/audio-plugin-spec.md`.

Same rules as the thumbnail plugin: **data in → one file or a reason out**, imports nothing from
`src/main` or `src/core`, never touches the original recording. Do not edit the plugin from the app
side; hand findings to the plugin agent in a report file.

## 1. Files

| file | what |
|---|---|
| `look.ts` | **the knob table** (single source of truth), defaults, `validateLook`, `LOOK_FIELDS`, presets, `controllingToggle`, `describeLook`. **Node-free** — the renderer may import it. |
| `types.ts` | the contract: `AudioJob`, `AudioHost`, `AudioResult`, `AudioAnalysis`, reasons |
| `index.ts` | public surface: `processAudio`, `analyse`, `discard`, `explain`, `manifest`, re-exports |
| `chain.ts` | look → ffmpeg filter graph (pure; exact strings unit-tested) |
| `ir.ts` | reverb impulse response generated in code (seeded, unit-energy, stereo width) |
| `ffmpeg.ts` | runner: progress, cancel, **stall watchdog**, crash detection, probe/ebur128 parsers, filter check |
| `analyse.ts` | loudness, true peak, hot samples (clipping), hiss & rumble measurements, hints |
| `cache.ts` | cache key, file names, atomic writes |
| `cli.ts` | `npm run audio -- process|analyse|explain|batch|sweep …` (plain Node, no Electron) |
| `*.test.ts` | 35 tests, synthetic audio, real bundled ffmpeg (≈7 s) |

Touched outside the plugin: `electron.vite.config.ts` (3rd main entry `audio-cli`), `package.json`
(`audio` script). Nothing else.

## 2. API

```ts
import { processAudio, analyse, discard, LOOK_FIELDS, DEFAULT_LOOK, validateLook, controllingToggle,
         REVERB_PRESETS, LOOK_PRESETS, describeLook, manifest } from '../plugins/audio/index'

const host = { outputDir: `<library>/.yoosyjoosy/audio`, ffmpegPath: ffmpegPath()!, log, signal, onProgress }

// full recording → FLAC the encoder uses instead of the original
const r = await processAudio({ audioPath, look: patch }, host)
// r.ok → { file, cacheKey, cached, after: { durationSec, channels, lufs, truePeak }, gainDb, warnings }
// !r.ok → { reason, message }   — never throws

// editor A/B: processed excerpt, then the original excerpt at the SAME loudness
const p = await processAudio({ audioPath, look: patch, preview: { start: 60, seconds: 45 } }, host)
const o = await processAudio({ audioPath, preview: { start: 60, seconds: 45 }, bypass: true, matchLufs: p.after.lufs }, host)

const a = await analyse(audioPath, { ffmpegPath })   // AudioAnalysis (hints in plain language)
await discard(r.file)                                // after a successful upload: FLAC + sidecar gone
```

- **ffmpeg comes from the host** (`src/main/ffmpeg.ts → ffmpegPath()`); the plugin checks once per
  binary that every filter it needs exists (`FFMPEG_UNUSABLE` otherwise).
- **Progress** 0–100 covers measure (0–40) → render (40–90) → verify (90–100), monotonic.
- **Cancel** via `host.signal` → `CANCELLED`, ffmpeg killed, no part file left.
- **Cache**: `<key>.flac` + `<key>.json` sidecar in `outputDir`; same recording (path+size+mtime) +
  same resolved look = cache hit (`cached: true`, same measurements). IRs cached in `outputDir/ir/`.
- **Output**: FLAC 24-bit 48 kHz, mono (stereo when reverb is on; stereo sources stay stereo).
- Reasons: `INVALID_JOB`, `INVALID_LOOK` (every bad knob named), `AUDIO_UNREADABLE`, `SILENT_INPUT`,
  `FFMPEG_UNUSABLE`, `PROCESS_FAILED` (ffmpeg's last lines, or "crashed (SIGSEGV)"), `TIMEOUT`,
  `CANCELLED`, `DURATION_MISMATCH`, `SILENT_OUTPUT`, `LOUDNESS_OFF_TARGET`.

## 3. The knobs (for the editor)

Generated from `LOOK_FIELDS` — build the UI from `LOOK_FIELDS` at runtime, not from this table.

| Knob (path) | Label | Kind | Range | Step | Default | Greyed out by | What it does |
|---|---|---|---|---|---|---|---|
| `cleanup.declip.enabled` | Repair clipping | toggle | on / off |  | off |  | Rebuilds peaks that were flattened by a recorder or PA turned up too far. Slow (≈2 s per minute of audio); only worth it when analysis reports clipping. |
| `cleanup.clicks.enabled` | Remove clicks | toggle | on / off |  | on |  | Removes short clicks and pops (mic bumps, digital glitches). Leaves the voice untouched. |
| `cleanup.rumble.enabled` | Cut rumble | toggle | on / off |  | on |  | Removes low hum and rumble (air conditioning, PA, traffic) below the cut-off. |
| `cleanup.rumble.frequency` | Cut-off | number | 40 … 150 Hz (log) | 1 | 75 Hz | `cleanup.rumble.enabled` | Everything below this is removed (24 dB/octave). A male voice reaches down to about 85–100 Hz, so keep it below 90 Hz unless the hum is higher. |
| `cleanup.hiss.enabled` | Reduce hiss | toggle | on / off |  | on |  | Lowers steady background noise (hiss, fans, room tone). The noise is learned continuously, so it adapts as the room changes. |
| `cleanup.hiss.amount` | Reduction | number | 1 … 30 dB | 0.5 | 12 dB | `cleanup.hiss.enabled` | How much the noise is lowered. Above ~18 dB long drawn-out notes (madd) can start to sound washed or watery. |
| `tone.enabled` | Tone (EQ) | toggle | on / off |  | off |  | Shapes the colour of the voice. Off = the voice keeps its recorded tone. |
| `tone.mud.gain` | Warmth / mud | number | -9 … 3 dB | 0.5 | -1.5 dB | `tone.enabled` | Negative removes boxy, muddy sound; positive adds body. |
| `tone.mud.frequency` | Warmth frequency | number | 120 … 600 Hz (log) | 5 | 250 Hz | `tone.enabled` | Centre of the warmth band. |
| `tone.presence.gain` | Clarity | number | -6 … 9 dB | 0.5 | 2.5 dB | `tone.enabled` | Positive makes letters clearer and brings the voice forward. |
| `tone.presence.frequency` | Clarity frequency | number | 1500 … 6000 Hz (log) | 50 | 3000 Hz | `tone.enabled` | Centre of the clarity band. |
| `tone.air.gain` | Air | number | -6 … 6 dB | 0.5 | 0 dB | `tone.enabled` | Brightness of the very top. Positive also raises any remaining hiss. |
| `tone.air.frequency` | Air frequency | number | 6000 … 14000 Hz (log) | 100 | 9000 Hz | `tone.enabled` | Everything above this frequency is raised or lowered. |
| `tone.deesser` | De-esser | number | 0 … 1 | 0.05 | 0 | `tone.enabled` | Softens harsh "s" sounds. 0 = off. Keep low: س ص ش ز must stay articulated for tajweed. |
| `dynamics.enabled` | Compressor | toggle | on / off |  | off |  | Evens out loud and soft passages. Most recordings are already even (mosque PA), so this is off by default. |
| `dynamics.threshold` | Threshold | number | -40 … -5 dB | 0.5 | -20 dB | `dynamics.enabled` | Passages louder than this are turned down. |
| `dynamics.ratio` | Ratio | number | 1 … 8 :1 | 0.1 | 2 :1 | `dynamics.enabled` | How strongly: 2:1 is gentle, 4:1 firm, 8:1 heavy. |
| `dynamics.attack` | Attack | number | 1 … 200 ms | 1 | 20 ms | `dynamics.enabled` | How fast it reacts. Faster tames sudden peaks but can dull letters. |
| `dynamics.release` | Release | number | 20 … 1500 ms | 10 | 250 ms | `dynamics.enabled` | How fast it lets go. Too short sounds pumpy on long notes. |
| `reverb.enabled` | Reverb | toggle | on / off |  | off |  | Adds a sense of space. Recordings already carry the masjid's own echo, so use it subtly. Turning it on makes the audio stereo. |
| `reverb.amount` | Amount | number | -30 … -3 dB | 0.5 | -16 dB | `reverb.enabled` | Echo level relative to the voice: −16 dB = subtle, −10 dB = clearly audible, −4 dB = very wet. |
| `reverb.decay` | Size (decay) | number | 0.3 … 6 s | 0.1 | 1.2 s | `reverb.enabled` | How long the echo takes to fade away: about 1 s small room, 2 s hall, 3–4 s large masjid. |
| `reverb.predelay` | Pre-delay | number | 0 … 120 ms | 1 | 15 ms | `reverb.enabled` | Gap before the echo starts. Larger keeps the voice clearer and makes the space feel bigger. |
| `reverb.tone` | Echo brightness | number | 1500 … 12000 Hz (log) | 100 | 5500 Hz | `reverb.enabled` | Top frequency of the echo. Lower = darker, softer echo like stone and carpet. |
| `reverb.width` | Width | number | 0 … 1 | 0.05 | 0.8 | `reverb.enabled` | 0 = echo in the centre, 1 = fully spread left/right. |
| `loudness.enabled` | Even out volume | toggle | on / off |  | on |  | Brings every recording to the same loudness, so videos don't jump in volume one after another. |
| `loudness.target` | Target loudness | number | -24 … -10 LUFS | 0.5 | -14 LUFS | `loudness.enabled` | −14 is YouTube's playback reference: louder uploads are turned down by YouTube anyway. |
| `limiter.ceiling` | Peak ceiling | number | -6 … -0.5 dB | 0.1 | -1.5 dB |  | Peaks never go above this. Always applied, even with volume levelling off, so the file can never clip. |
| `fades.in` | Fade in | number | 0 … 5 s | 0.1 | 0.5 s |  | Fade at the start. 0 = none. |
| `fades.out` | Fade out | number | 0 … 10 s | 0.1 | 1.5 s |  | Fade at the end. 0 = none. |

How to build controls from a field:

- `kind: 'number'` → slider + numeric box. `min`/`max`/`step`; show `unit` after the value (decimals =
  decimals of `step`). `scale: 'log'` → move the slider logarithmically (frequencies).
- `kind: 'toggle'` → switch. Sections are switched by their `enabled` toggle; grey out a knob when
  `controllingToggle(path)` is off. `limiter.ceiling` and `fades.*` have no switch (always active;
  fades use 0 = none).
- `label` = the control's name, `desc` = tooltip / help text (plain language, tajweed caveats included).
- **Store patches, not resolved looks** (only knobs that differ from `DEFAULT_LOOK`), exactly like
  thumbnail looks, so plugin default changes reach users. Validate with `validateLook(patch)` before
  saving; its errors carry the dotted key.
- **Presets** are patches to merge into the look: `REVERB_PRESETS.room|hall|masjid` (one click sets
  decay, pre-delay, brightness, amount, width), `LOOK_PRESETS.standard|strong|original`.
- `describeLook(look)` gives a one-line summary for cards and logs, e.g.
  `remove clicks · cut rumble < 75 Hz · reduce hiss 12 dB · level to -14 LUFS · fades 0.5/1.5 s`.

Chain order is fixed: **cleanup (declip → clicks → rumble → hiss) → tone → compressor → reverb →
loudness → limiter → fades.** The factory look (empty patch) = clicks + rumble 75 Hz + hiss 12 dB +
−14 LUFS + −1.5 dB ceiling + 0.5/1.5 s fades. Tone, compressor, reverb, declip are off.

## 4. What was verified

- **35 unit/integration tests** (`npx vitest run src/plugins/audio`, ≈7 s): every knob's range/step/
  default; validation errors; canonical cache form; exact filter strings; IR length, unit energy,
  decay, width 0 → identical / 1 → independent channels, determinism; probe/ebur128 parsers;
  end-to-end level to −14 ±0.5 LUFS under the ceiling with exact length; cache hit; reverb → stereo;
  A/B pair level-matched within 0.5 LU; preview past the end; every refusal reason; silent input;
  cancel leaves nothing; **watchdog kills a stalled ffmpeg**; clipping detected on a clipped AAC and
  not on a normal one.
- **Sweep** (`npm run audio -- sweep <file>`) on a real recording: every knob at min and max (with all
  sections on), every reverb preset, everything off — **56/56 ok**, all at target loudness, peaks
  under the ceiling. This is the guard against the ffmpeg 6.0 crash-on-bad-option.
- **Analyse** on all 53 real recordings (table: `npm run audio -- analyse <folder>`).
- **Batch** (`npm run audio -- batch <folder>`), factory look, all **53 real recordings (≈8 h of audio)**:
  **53/53 ok**, loudness −14.0 to −14.3 LUFS (sources were −25.6 to −13.5), every length exact, 17.7 min
  in total (≈2.2 s per minute of audio incl. verify). That run found true peaks 0.1–0.8 dB over the
  ceiling on 8 files → limiter now runs at 4× rate (chainVersion 2); those 8 re-run at exactly −1.5 dBTP.

## 5. Things learned the hard way (do not undo)

1. **No `loudnorm`.** In our ffmpeg 6.0 it hangs forever after the reverb mix (reproduced). Levelling
   is two-pass: ebur128 measure → fixed `volume` gain → `alimiter`. Exact on every file so far.
2. **ffmpeg 6.0 segfaults on an unknown filter option** (e.g. `afir=irnorm=1`). Only validated numbers
   reach the graph; new knobs must go through `sweep`.
3. **`amix` must be `duration=longest`.** `duration=first` cut 0.16 s (the convolution latency) off
   every reverb file — the duration check caught it.
4. **Reverb level**: even a unit-energy IR makes recitation's echo 2–5 dB louder than the voice, more
   with longer decays. `reverbLevelOffset(decay) = 1.9 + 0.8·decay` (fit on 3 recordings × 3 decays,
   ±0.5 dB) makes `reverb.amount` mean "dB relative to the voice".
5. **Limiter at 4× rate** (`aresample=192000` around `alimiter`): at 48 kHz it only caps sample peaks
   and 8 of 53 files ended above the ceiling in true peak. Verify now warns if that ever recurs.
6. **Clipping on AAC**: astats' peak count is 2 on every file and the flat tops are smeared by the
   codec, so clipping = share of samples above −0.5 dBFS (`hotSamplesPct`). Real recordings 0–0.015 %,
   clipped AAC ≈50 %; flagged above 0.1 %. **No really clipped recording was available** — revisit
   the threshold when one turns up.
7. `hissDb` / `rumbleDb` are raw measurements, no verdicts: recitation has no pauses to measure
   noise in, and there is no ground truth yet for "too noisy". Show them as numbers / bars.

## 6. Integrating (app agent's job)

1. `settings.audio = { enabled }` (default **on** — factory look = clean-up + levelling + fades).
2. Pipeline stage **`audio`** after `thumbnail`, before `encode`; `encodeVideo({ audio: r.file, … })`.
   Failure → hold the upload with the reason (like thumbnails) + per-record "Upload with the original
   audio anyway".
3. **Video key** = `frameKey + '|' + audioKey` (audio key = `r.cacheKey`, or `'original'`) so a look
   change re-encodes not-yet-uploaded videos and switching processing off does too.
4. After a successful upload: `discard(r.file)` (FLAC ≈150 MB/h mono, ≈300 MB/h with reverb).
5. Where audio looks live and how they are chosen (Default look + per-reciter, or full rules like
   thumbnails) is open — spec Q2.
6. Editor playback: the renderer can't load `file://` in dev; previews are FLAC (45 s stereo ≈ 6 MB),
   so stream them through a custom protocol or IPC → Blob URL rather than base64 data URLs.
7. Speed: ≈13 s per 7.5 min of audio on Umo's Mac (measure + render + verify); repair-clipping adds
   ≈1.5 s per minute.
