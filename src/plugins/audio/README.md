# Audio plugin v2 — handover for the app designer

**Status 2026-11-16:** plugin **v2.1.0** in `src/plugins/audio/`. It is a **generic audio editor over
ffmpeg**: a look is a rack of any ffmpeg audio filters with any of their options, at ffmpeg's own
limits. v1's fixed knobs (cleanup / tone / dynamics / reverb / …) are gone; `lookFromV1` converts a
saved v1 look into the same filters. 2.1.0 adds the calls the app's audio rules are built on
(`measure`, `ring`, `ringSplit`, `levellingGain`, `AudioJob.gainDb` / `rate`).

Same rules as before: **data in → one file or a reason out**, imports nothing from `src/main` or
`src/core`, never touches the original recording. Don't edit the plugin from the app side; hand
findings to the plugin agent.

---

## 1. The idea in one picture

```
recording ─▶ [ step ] ─▶ [ step ] ─▶ [ split ─┬─ branch rack ─┐ merge ] ─▶ [ step ] ─▶ (levelling) ─▶ FLAC
                                              └─ branch rack ─┘
                 ▲ extra inputs: a copy of the signal (sidechain key), a file (impulse response),
                   or generated audio (sine, noise, aevalsrc) — each through its own little rack
```

- **Catalog** (`catalog.json`, generated from the bundled ffmpeg): every audio filter — 139 of them —
  with every option: type, exact min/max, default, named choices, aliases, description. **This is
  what the UI draws knobs from.** Nothing is hand-written; regenerate with `npm run audio -- catalog`
  if ffmpeg is ever upgraded (the plugin refuses to run against another ffmpeg release until you do).
  The app ships **ffmpeg 6.0 on every system** (`ffmpeg-static` pinned to 5.2.0: its newer releases give
  Windows 6.1.1 while macOS stays on 6.0). The builds come from different builders, so the plugin compares
  the release number, not the whole version line, and reads which filters the build at hand has: a look
  that needs one it was made without is refused on that step (`INVALID_LOOK`).
- **Look** = `{ chain: Step[], level?: { lufs, ceiling } }`. A step = one ffmpeg filter + the options
  the user changed. Unset options stay at ffmpeg's defaults.
- **Levelling** (`level`) is the only plugin-owned stage: measure → one fixed gain → true-peak limiter
  at 4× rate. Optional. Everything else is pure ffmpeg.

## 2. Files

| file | what | renderer may import? |
|---|---|---|
| `catalog.ts` + `catalog.json` | the filter catalog, `filterInfo`, `optionInfo`, `filtersByCategory`, `padCount`, `FILTER_NEEDS` | **yes** |
| `look.ts` | `Look`/`Step`/`Source` types, `validateLook`, `describeLook`, `walkSteps`, `coerceOption`, `LEVEL_FIELDS`, `LIMITS` | **yes** |
| `presets.ts` | `LOOK_PRESETS` (plain looks) | **yes** |
| `v1.ts` | `isV1Look`, `lookFromV1` | **yes** |
| `types.ts` | the contract: `AudioJob`, `AudioHost`, `AudioResult`, `LookCheck`, reasons, `Measure`, `RingMeasure`, `RingSplit`, `AudioError`, `MEASURE_BANDS`, `MEASURE_VERSION`, `RING_VERSION` | yes (types and constants) |
| `index.ts` | public surface: `processAudio`, `checkLook`, `levellingGain`, `analyse`, `measure`, `ring`, `ringSplit`, `discard`, `explain`, `manifest`, re-exports | main only |
| `measure.ts` | tone and level behaviour of a recording from one streamed decode (`Measurer`) | main only |
| `ring.ts` | ringing after "s" sounds: bursts, what is left after them, where it starts | main only |
| `graph.ts` | look → one `-filter_complex` graph; value escaping; ffmpeg errors → step paths | main only |
| `ffmpeg.ts` | runner (progress, cancel, stall watchdog, hard time limit, crash detection), parsers, version check | main only |
| `catalog-gen.ts` | builds `catalog.json` from `ffmpeg -filters` / `-h filter=…` | main only |
| `analyse.ts`, `cache.ts`, `cli.ts` | measurements; cache keys; command line | main only |
| `*.test.ts` | 73 tests on synthetic audio with the real bundled ffmpeg (~30 s) | — |

The renderer already compiles `look.ts`; everything it imports (catalog, JSON) comes along. The
catalog JSON is ~345 KB.

## 3. Data model

```ts
interface Look { chain: Step[]; level?: { lufs: number; ceiling: number } | null }

interface Step {
  id?: string            // your stable React key; ignored by processing and the cache
  label?: string         // user's name for the step; ignored by processing and the cache
  filter: string         // a catalog filter name
  options?: Record<string, string | number | boolean>   // only what the user changed
  bypass?: boolean       // the step's on/off switch: true = as if absent
  enable?: string        // timeline expression, only for filters with `timeline: true`
  inputs?: Source[]      // extra inputs (filters with role 'multi-input')
  outputs?: Step[][]     // one sub-rack per output (filters with role 'split')
  merge?: Step           // joins >1 outputs back into one (amix, amerge, join, …)
}

type Source =
  | { kind: 'signal'; chain?: Step[] }                         // copy of the signal at this point
  | { kind: 'file'; path: string; chain?: Step[] }             // absolute path
  | { kind: 'generate'; filter: string; options?: {…}; chain?: Step[] }   // a 'source' filter
```

**Filter roles** (`CATALOG.filters[name].role`) decide how a step is drawn:

| role | count | step shape | examples |
|---|---|---|---|
| `effect` | 111 | plain step | highpass, equalizer, afftdn, acompressor, deesser, aecho, atempo, volume |
| `multi-input` | 15 | step + `inputs` (`padCount(f, opts, 'in') − 1` of them) | sidechaincompress, sidechaingate, afir, amix, anlms |
| `split` | 5 | step + `outputs` (`padCount(f, opts, 'out')` sub-racks) + `merge` | acrossover, asplit, channelsplit, aselect, asegment |
| `source` | 8 | only as `{ kind: 'generate' }` | sine, anoisesrc, aevalsrc, afirsrc, sinc |

Plugin limits (`LIMITS`): 500 steps per look, 8 levels of nesting, 64 extra inputs or outputs per
step, 10 000 characters per text option. Everything else is ffmpeg's own limit.

`padCount` returns null when the count depends on the input (e.g. `channelsplit` on an unknown layout).
Then let the user choose the number of branches, and `checkLook` confirms it with ffmpeg.

**Paths** name every place in a look, and every error carries one:
`chain[2]`, `chain[2].options.frequency`, `chain[0].outputs[1][0]`, `chain[0].merge`,
`chain[3].inputs[0].chain[1]`, `chain[3].inputs[0].path`, `level.lufs`. `walkSteps(look, fn)` visits
every step with its path.

## 4. API

```ts
// renderer + main (Node-free)
validateLook(x): { ok: true, look } | { ok: false, errors: { path, message }[] }   // instant, strict, normalises
describeLook(look): string            // "highpass frequency=75 poles=2 → afftdn … · level -14 LUFS, ceiling -1.5 dBTP"
CATALOG, filterInfo(name), optionInfo(filter, nameOrAlias), filtersByCategory(), padCount(filter, opts, 'in'|'out')
LOOK_PRESETS: { none, cleanup, springTamer, reverbRoom, reverbHall } → { label, desc, look }
LEVEL_FIELDS: { lufs: { min -70, max 0, default -14, step 0.1, unit 'LUFS' }, ceiling: { min -20, max 0, default -1.5, … } }
isV1Look(x), lookFromV1(x)

// main only
processAudio(job, host): Promise<AudioResult>     // never throws
checkLook(look, host, { audioPath?, seconds?, channels? }): Promise<LookCheck>   // ffmpeg's verdict, ~10–200 ms
levellingGain(audioPath, look, host)              // never throws: { ok, gainDb, rackLufs, rackPeak, rate } | { ok: false, reason, message, errors? }
analyse(audioPath, host): Promise<AudioAnalysis>                              // these four hand back numbers
measure(audioPath, host, look?, span?): Promise<Measure | null>               // and throw AudioError { reason, message, errors? }
ring(audioPath, host, splitHz = 4500, look?, span?): Promise<RingMeasure | null>
ringSplit(audioPath, host, span?): Promise<RingSplit>
discard(file), explain(look) → { graph, files }
```

**One contract for failures.** `processAudio`, `checkLook` and `levellingGain` return the reason. The four
measuring calls throw an `AudioError` carrying the same reasons (`INVALID_JOB` for a bad path, `span` or `splitHz`;
`AUDIO_UNREADABLE`; `INVALID_LOOK` with `errors[]` on the steps; `TIMEOUT`; `CANCELLED`, message "Cancelled";
`FFMPEG_UNUSABLE`; `PROCESS_FAILED`). Every one of them takes `host.signal` and `host.stallMs`, runs through the same
runner as a render, and is cut at max(2 × input, input + 60 s) when a look never ends. `discard` only removes files
named as `processAudio` names its outputs.

**`measure(audioPath, host, look?, span?)`** (reads only, changes no audio). One 32 kHz mono decode, streamed, in
64 ms frames: `tone` and `quiet` per third-octave band (`MEASURE_BANDS`), `voiceDb`, `floorDb`, frame-level
percentiles, `peakDb`, `sibilance`. Everything except `voiceDb` is relative to the recording's own voice level.
`null` = nothing to measure: silent (also when the look removes the signal) or under two seconds. Bump
`MEASURE_VERSION` when the meaning of a number changes: the app keeps what it measured in
`<library>/.yoosyjoosy/audio-facts.json` and in its rules' targets, and redoes both on a version change.

**`ring(audioPath, host, splitHz = 4500, look?, span?)`** (reads only). Finds the loud bursts in the band above
`splitHz` (100…20000 Hz; "s" sounds) and how far the band stays above its level from before after each one: burst
length and level, the leftover at 50…1500 ms, how fast it dies away. `null` = under 30 s; `burstMs: 0` = too few bursts
to say. **`ringSplit(audioPath, host, span?)`** says where that ring starts: it reads the bands between 3, 3.75, 4.5,
5.5 and 7 kHz after each burst and returns the lower edge of the lowest one that rings (`splitHz`), what it found in
each (`bands`) and how many bursts it could use (`bursts`; under 6 there is nothing to go on and `splitHz` is 4500).
All three read the mono downmix. Bump `RING_VERSION` when `ring` / `ringSplit` change what their numbers mean.

`measure` and `ring` also take a `look` (they then measure what that look's rack makes of the recording, levelling left
out) and a `span` (`{ start, seconds }`: only that stretch). With both, the rack runs in recording time, exactly as a
render of that stretch does (6.3). That is how the app's Auto-set checks its own settings: process, measure, correct
(`src/main/audio-autoset.ts`; the decisions are in `src/core/audio-steer/`).

Audio rules (the app, not the plugin: `src/core/audio-rules.ts`, `src/main/audio-rules.ts`, `src/main/audio-stage.ts`) are built
on these calls: a rule's target is captured by measuring its reference recordings through their looks, and at upload
each recording is steered to that target, rendered with `processAudio`, and the FLAC handed to the video encoder.

**`levellingGain(audioPath, look, host)`** → `{ ok, gainDb, rackLufs, rackPeak, rate }`: the one gain levelling gives
the WHOLE recording with this look (pass 1 only, nothing rendered; `gainDb: null` without levelling). `gainDb` is to
0.01 dB and within −30…+24 dB, as a render applies it; `rackPeak` is the rack's highest sample before any gain (the true
peak can be a little higher); `rate` is the rack's output sample rate.
**`AudioJob.gainDb`** makes `processAudio` use a given gain instead of measuring its own span; with **`AudioJob.rate`**
(8000…384000 Hz, the rate `levellingGain` reported) it skips the measuring pass altogether. Together they are how an
editor previews levelling honestly: an excerpt levelled on its own gets a different gain than the recording will, and a
quiet one is pushed into the limiter. An excerpt rendered this way lands wherever that gain puts it (only the ceiling
is checked); a whole recording rendered this way is still checked against the loudness target, like any other.

**`AudioJob`** `{ audioPath, look?, preview?: { start, seconds }, bypass?, level?: Level | null, gainDb?, rate? }`
– `bypass`: ignore the rack and the look's levelling (just cut the excerpt).
– `level`: override the look's levelling for this job (`null` = none). `bypass + level` = a
  level-matched original for A/B.

**`AudioResult`** ok → `{ file, cacheKey, cached, after: { durationSec, sampleRate, channels, lufs,
truePeak, samplePeak }, inputSec, gainDb, warnings }`. Failure → `{ reason, message, errors? }`.

| reason | when | show |
|---|---|---|
| `INVALID_LOOK` | `validateLook` failed, **or ffmpeg refused a value** (bad expression, band list, layout …) | `errors[]` on the steps they name |
| `AUDIO_UNREADABLE` | the recording or a `file` source can't be read (`errors[].path` → `…inputs[n].path`) | |
| `SILENT_INPUT` | levelling asked for, but the excerpt is silent after the rack | |
| `SILENT_OUTPUT` | the rack removed the signal | |
| `LOUDNESS_OFF_TARGET` | levelling > 3 LU off (ceiling holding it down) | |
| `TIMEOUT` / `CANCELLED` / `PROCESS_FAILED` / `FFMPEG_UNUSABLE` / `INVALID_JOB` | as named | |

**Warnings** to surface next to the A/B player (they matter there):
- *"Output is X s, the input Y s: a step changes the length"* — atempo, asetrate, silenceremove, apad,
  atrim … The processed side **no longer lines up** with the original; say so, and don't pretend the
  playheads are in sync.
- *"Output was cut at N s"* — a step never ends (a `sine` without `duration`, `aloop=-1`); outputs are
  capped at max(2× input, input + 60 s).
- *"Peaks reach full scale: the processed copy is clipped"* — no levelling and the rack is too hot.
- levelling: gain capped (also a given gain outside −30…+24 dB) / landed off target / true peak over ceiling.

## 5. Building the editor UI from the catalog

**One knob per option, drawn from `CatalogOption`:**

| `type` | control | value to store |
|---|---|---|
| `int` with `choices` | dropdown of `constants` (`name`, `desc`); aliases are alternative spellings | the constant's `name` (string) |
| `int` / `double` / `float` | number field + slider | number |
| `boolean` | switch | `true`/`false` |
| `flags` | multi-select chips of `constants` | names joined with `+`, e.g. `"a+b"` |
| `duration` | seconds field | number (seconds) — strings like `"1:30.5"`, `"250ms"` also valid |
| `string` | text field (often an **expression**, a list or a curve — show `desc` as help) | string |
| `channel_layout` | combobox: mono, stereo, 2.1, 5.1, 7.1, FL+FR, … (free text allowed) | string |
| `sample_fmt` | dropdown: u8 s16 s32 s64 flt dbl + planar u8p s16p s32p s64p fltp dblp | string |
| `rational` | text `"num/den"` | string |

**Limits are ffmpeg's, exactly** (`min`/`max`). Many are enormous (`INT_MAX` = 2147483647,
`DBL_MAX` ≈ 1.8e308, `999999` Hz). So:
- always offer a **typed number field** — that's the only control that reaches the full range;
- add a slider only where the span is reasonable (say `max − min ≤ 10 000` or the option has a small
  range); use a **log slider** when `min > 0 && max / min ≥ 100`;
- int: step 1. double/float: free decimals (no rounding — the plugin doesn't round).
- validation messages already quote the limits: *"frequency is above the maximum (ffmpeg allows 0 to 999999)"*.

**Defaults & reset.** Show `default` (ffmpeg's text: `"0.5"`, `"peak"`, `"true"`) as the knob's
resting value. "Reset" = **delete the key** from `options` — never write the default back (keeps
looks small and readable).

**Filter the noise.** Hide `deprecated` options. Put options with a `group` (aresample's
`SWResampler` set) under "Advanced". `live: true` means ffmpeg could change it while playing — unused
today, a hook for a future live preview.

**Filters that need a setting first** (`FILTER_NEEDS`): aeval (an expression), pan (a layout + channel
definitions), chorus (delays/decays/speeds/depths), channelmap, asegment, asendcmd, asidedata,
astreamselect, headphone, arnndn (a model file). Pre-fill something sensible when the user adds one,
and show `why` until it's set — validation refuses them otherwise (two of them crash ffmpeg 6.0 without).

**Adding a step:** a picker grouped by `filtersByCategory()` (EQ & filters, Dynamics, Noise & repair,
Reverb/delay/space, Modulation, Tone & character, Time & pitch, Channels & mixing, Analysis, Math &
custom, Format & plumbing), searchable by name and `description`.
Per step: on/off (`bypass`), drag to reorder, rename (`label`), duplicate, delete.
Filters with `timeline: true` can get an **"only between … s and … s"** helper → `enable: 'between(t,A,B)'`
(in recording time — see 6.3).

**Split steps:** draw `outputs` as nested racks side by side (bands / branches) with a merge selector
underneath (default `amix` with `inputs` = branch count, `normalize: false`). When the user edits the
option that decides the branch count (`acrossover.split`, `asplit.outputs`, `aselect.outputs`), resize
`outputs` to `padCount(...)` and update the merge's `inputs`.
**Multi-input steps:** an "inputs" list; each input is a kind picker (copy of signal / file / generator)
with its own small rack. Files: absolute paths — copy picked files into the library like rule fonts.

**Validation flow:**
1. every edit → `validateLook` in the renderer (instant): mark `errors[].path`.
2. edits settle (~300 ms) → IPC → `checkLook(look, host, { audioPath })` in main: ffmpeg's own
   verdict, mapped to steps (expressions, lists, channel layouts, branch counts). Also returns the
   rack's output `sampleRate`/`channels` — show "→ 48 kHz stereo".
3. only then render A/B chunks.

**Presets** are plain looks — "Load preset" replaces the rack (or inserts its steps). Users see and
can change everything in them.

## 6. Processing details the app must know

1. **Output:** FLAC, 32-bit, at the rack's own rate and channel count (stereo if a step makes it
   stereo, 96 kHz if the user resamples, …). Anything ≥ 0 dBFS is clipped in the file unless
   levelling is on.
2. **Cache key** = recording identity + **the exact ffmpeg graph** + extra files' size/mtime +
   levelling + preview window + a given gain (to 0.01 dB) and rate. So ids, labels and bypassed steps never
   re-render; any audible change does.
3. **Previews run in recording time.** For `preview: { start }` the rack sees `t` = time in the
   recording (the plugin shifts timestamps in and back out). A fade-in at `t=0`, an
   `enable='between(t,60,90)'` or an `atrim` acts at the same moment in a 5 s chunk as in the whole
   file. Filters still start **cold** at the chunk's first sample, so keep the pre-roll (4 s is fine
   for EQ/dynamics/denoise; long reverbs, `dynaudnorm`, `loudnorm`, `afftdn` noise learning want more).
4. **Whole-file filters** behave differently per chunk no matter what: `areverse`, `silenceremove`,
   `loudnorm`, `dynaudnorm`, `aloop`, `apad`. Fine for uploads; in the A/B player they're approximate.
5. **Levelling per chunk:** a chunk with `level` and no `gainDb` is levelled on its own and returns its
   `gainDb`. Give every chunk the whole recording's gain (`levellingGain` → `AudioJob.gainDb` + `rate`) and
   the preview is what a full render sounds like; the app does this.
6. **Fade-out** needs the recording's length (`afade type=out start_time=<len − d>`), which a look
   shared by all recordings doesn't know — leave it to a future "smart setting" in the app.
7. Progress: 0–40 measure (only with levelling, and not when `gainDb` + `rate` are given), →90 render,
   →100 verify. `host.stallMs` (default 30 s) kills ffmpeg when audio stops moving, in renders and in the
   measuring calls alike; `checkLook` also has a 30 s hard limit; reading a file's header or ffmpeg's
   version is stopped after 20 s. A cancelled ffmpeg that does not stop within 2 s is killed.

## 7. How the app uses it

| app file | what it calls |
|---|---|
| `src/main/audio.ts` | `processAudio` for the A/B player's chunks (with the whole recording's gain and rate), `levellingGain` (kept per chain), `analyse` |
| `src/main/audio-facts.ts` | `measure`, `analyse`, `ringSplit`, `ring` once per recording, kept in `audio-facts.json` under `MEASURE_VERSION` and `RING_VERSION` |
| `src/main/audio-autoset.ts` | `measure` and `ring` through a look (over a stretch for long recordings), `levellingGain` |
| `src/main/audio-rules.ts` | the same, to capture a rule's target from its reference recordings |
| `src/main/audio-stage.ts` | `processAudio` on the whole recording for an upload, `discard` once the video is uploaded |
| `src/core/audio-modules.ts` | the editor's fixed channel strip as a look (`toLook`), read back with `fromLook` |

`npm run audio` runs the CLI from the built app (`npm run build` first).

## 8. Command line

```
npm run audio -- catalog                       regenerate catalog.json from the bundled ffmpeg
npm run audio -- filters [category|filter]     browse; `filters afftdn` lists every option with limits
npm run audio -- process <file> [--look look.json | --preset cleanup] [--preview 60:30] [--bypass] [--level -14:-1.5 | --no-level]
npm run audio -- explain | check [--file f]    the exact graph | ffmpeg's verdict per step
npm run audio -- analyse <file|folder> · batch <folder> [--preset …] · sweep [--filter name] [--report out.json]
npm run audio -- measure <file> [--look … | --preset …] [--span 60:30]     tone and level behaviour, as JSON
npm run audio -- ring <file> [--split 4500] [--look …] [--span 60:240]    ringing after "s"; without --split it is searched for first
npm run audio -- gain <file> [--look … | --preset …]                       the whole recording's levelling gain
```

## 9. What was verified

- **Unit + end-to-end tests:** 73 in the plugin (catalog parsing, validation paths, graph strings,
  escaping round-trips through ffmpeg, every preset, sidechain/split/file/generate inputs, recording-time
  previews, v1 conversion, levelling, refusals, cancel, both watchdog cases; for the measuring calls: what they
  refuse, cancel, stall, endless sources, stereo, a given gain and rate; the bundled build against the catalog). Whole repo: 247 pass.
- **2.1.0 against 2.0.0 on real recordings** (2026-11-15: a 37 s and a 3.8 min mono recording and a stereo file;
  `measure`, `ring`, `ringSplit`, `analyse`, `levellingGain`, `processAudio`, plain, through a look and over a
  stretch, 33 results): identical, except that `levellingGain` now rounds its gain and `ringSplit` reads both
  channels of the stereo file. `MEASURE_VERSION` stayed 1.
- **Sweep of everything ffmpeg offers** (`npm run audio -- sweep`, 12 s): all 139 filters at their
  defaults, then every option at its min, its max (capped at ±1e6 for the test only — 50 values) and
  every named choice → **2 015 runs: 1 992 ok, 23 refused by ffmpeg with its own reason, 0 crashes.**
  The refusals are real ffmpeg rules the editor should just show: e.g. `aphaser delay=0` "delay is too
  small", `surround lfe_low ≥ lfe_high`, `firequalizer accuracy=0`, `afir maxir=0.1` "too big number of
  coefficients", `aiir` format/processing combinations, `join inputs=1`, `arealtime speed≈0` (TIMEOUT),
  the 64-branch limit, `ametadata` without a key, `arnndn` without a model, `headphone` without a map,
  `hdcd` (needs HDCD-encoded CD audio). The first sweep found 3 crashes (now refused by validation).
- **Real recordings:** the `cleanup` preset (= v1's default chain + levelling) on all 53 AbdullahAlMousa
  recordings (~8 h): **53/53 ok, −14.0 to −14.3 LUFS, true peak ≤ −1.5 dBTP, length within 0.03 s,
  no warnings**, 14.2 min (v1: 17.7 min). Same numbers as v1.
- **Presets on a real recording** (Isha Al Imran 0:55–1:25): every preset checks in 10–40 ms and
  renders; reverbs keep the voice level (−17.8 LUFS in → −17.8 out, reverb ~17 dB under); the spring
  tamer targets 4.8–5.75 kHz, the band where the tail after "s" sits highest and lasts longest
  (measured over 62 "s" sounds in Isha Al Imran: +7–8 dB above the singing for 0.5 s, still +4–5 dB
  at 0.4–0.9 s). Over the whole recording: that band's tail −4.2 dB, the "s" itself −0.2 dB above 4.5 kHz,
  6–9 kHz −0.3 dB, voice below 4.5 kHz 0.0 dB, normal singing −0.3 dB. The 20th-order crossover matters:
  at the default 4th order the neighbouring bands leak into such a narrow band and ducking stalls at ~−3 dB.

## 10. ffmpeg 6.0 gotchas (learned the hard way — keep)

1. **Unknown filter options crash ffmpeg (SIGSEGV)** instead of erroring → every option is checked
   against the catalog first, and the catalog must match the binary's release (checked by the release
   number in its version line; a test on each system checks the build has every catalog filter with the
   same options).
2. **After a filter refuses its settings, ffmpeg sometimes crashes while cleaning up.** When it named
   the filter while setting up the graph, the plugin reports `INVALID_LOOK` on that step, not a crash.
3. **`afir` outputs only the wet signal** — its `dry` option scales what goes *into* the convolution.
   A reverb is `asplit → (dry | afir) → amix` (see the presets).
4. `loudnorm` after an `afir`/`amix` mix **hangs forever** → the stall watchdog turns it into TIMEOUT.
5. **A filter can talk forever without moving** (`arealtime` at a near-zero speed). The watchdog
   counts messages as life only before audio starts; after that only progress counts.
6. `amix duration=first` cut 0.16 s off every v1 reverb file; the default (`longest`) is right.
7. `alimiter` only sees samples; at 48 kHz 8 of 53 files ended 0.1–0.8 dB over the true-peak ceiling.
   Levelling runs it at 4× the rack's rate.
8. Option values go through **two** parsers (graph, then filter arguments): `graph.ts` escapes
   `\ ' :` then `\ ' [ ] , ;`, plus leading/trailing spaces. Round-trip tested through ffmpeg with
   quotes, colons, commas, brackets, backslashes, spaces and non-ASCII.
9. ffmpeg's number parser also accepts suffixes (`-20dB` → 0.1, `1k` → 1000); the plugin stores plain
   numbers, so a dB-style UI must convert (e.g. acompressor `threshold` is linear 0.000976563…1).
10. **Settings that crash ffmpeg 6.0**, found by the sweep and refused by validation: `aeval` without
    `exprs`, `arnndn` without `model`, `afir` with `ir` ≥ `nbirs`. `aphasemeter` switches on a video
    output by default — the plugin always writes `video=false` (`pinned` in the catalog).
11. A step count isn't enough of a limit: `asplit outputs=2147483647` is one step with two billion
    branches. Hence the 64-branch limit.
12. ffmpeg cuts very long stream lines short (a 64-channel layout) — the parsers don't rely on the
    trailing comma.
