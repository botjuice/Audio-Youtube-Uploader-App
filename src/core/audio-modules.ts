/**
 * The Audio rules editor's fixed channel strip, expressed as the plugin's generic look.
 *
 * Each module is one plain ffmpeg filter (or, for the reverb, the plugin's parallel convolution shape) with
 * its raw options. The editor shows studio units — dB, Hz, ms, ratio, % — and converts to ffmpeg's own
 * representation on the way out (linear thresholds, "6dB" volume strings, mix 0…1). Nothing here decides
 * anything for the user: a module that is off is a bypassed step with its settings kept.
 *
 * Signal flow (fixed, the order every channel strip uses):
 *   gain → noise reduction → gate → spring tamer → EQ → compressor → de-esser → delay → reverb → limiter → levelling
 *
 * Steps carry stable ids so a saved look maps back onto the strip; a look without ids (one converted
 * from v1, or hand-written) is mapped by filter name, first match wins, and anything the strip cannot
 * show is reported in `unmapped`.
 */
import type { Look, Step } from '../plugins/audio/look'

// ── state ─────────────────────────────────────────────────────────────────────

export interface EqBand { on: boolean; freq: number; gain: number; q: number }
export interface EqPass { on: boolean; freq: number; q: number }
export interface EqShelf { on: boolean; freq: number; gain: number; q: number }
export interface EqState { on: boolean; hp: EqPass; lp: EqPass; ls: EqShelf; hs: EqShelf; bands: EqBand[] }

export interface Modules {
  gain: { on: boolean; db: number }
  nr: { on: boolean; reduction: number; floor: number; type: 'white' | 'vinyl' | 'shellac'; track: boolean; residual: number }
  gate: { on: boolean; threshold: number; range: number; ratio: number; attack: number; release: number; knee: number; makeup: number; detection: 'peak' | 'rms'; link: 'average' | 'maximum' }
  eq: EqState
  comp: { on: boolean; threshold: number; ratio: number; attack: number; release: number; knee: number; makeup: number; mix: number; detection: 'peak' | 'rms'; link: 'average' | 'maximum'; mode: 'downward' | 'upward' }
  deess: { on: boolean; intensity: number; max: number; frequency: number; mode: 'i' | 'o' | 'e' }
  echo: { on: boolean; inGain: number; outGain: number; delay: number; decay: number }
  reverb: { on: boolean; decay: number; predelay: number; brightness: number; amount: number }
  limiter: { on: boolean; ceiling: number; inGain: number; outGain: number; attack: number; release: number; asc: boolean }
  level: { on: boolean; lufs: number; ceiling: number }
  /** Ducks the top band for a moment after each loud burst in it (an "s"), so a reverb that rings on after the burst is softer. */
  spring: { on: boolean; split: number; threshold: number; ratio: number; delay: number; attack: number; release: number }
}

export type ModuleKey = keyof Modules
/** The modules that live in the left column (the EQ has its own editor under the lanes). */
export type StripKey = Exclude<ModuleKey, 'eq'>
/** Left-column order: simplest first. (Processing order is fixed separately, see `toLook`.) */
export const MODULE_ORDER: StripKey[] = ['gain', 'comp', 'gate', 'deess', 'spring', 'nr', 'echo', 'reverb', 'limiter', 'level']
export const MODULE_TITLES: Record<ModuleKey, string> = {
  gain: 'Gain', nr: 'Noise reduction', gate: 'Gate', eq: 'Equaliser', comp: 'Compressor', deess: 'De-esser',
  echo: 'Delay', reverb: 'Reverb', limiter: 'Limiter', level: 'Loudness levelling', spring: 'Spring tamer',
}
export const SIGNAL_FLOW = 'Gain → Noise reduction → Gate → Spring tamer → EQ → Compressor → De-esser → Delay → Reverb → Limiter → Loudness levelling'

export const EQ_BANDS = 4
export function defaultModules(): Modules {
  return {
    gain: { on: false, db: 0 },
    nr: { on: false, reduction: 12, floor: -50, type: 'white', track: false, residual: -38 },
    gate: { on: false, threshold: -18, range: -24, ratio: 2, attack: 20, release: 250, knee: 2.83, makeup: 0, detection: 'rms', link: 'average' },
    eq: {
      on: false,
      hp: { on: false, freq: 80, q: 0.707 }, lp: { on: false, freq: 16000, q: 0.707 },
      ls: { on: false, freq: 100, gain: 0, q: 0.5 }, hs: { on: false, freq: 3000, gain: 0, q: 0.5 },
      bands: [{ on: false, freq: 250, gain: 0, q: 1 }, { on: false, freq: 1000, gain: 0, q: 1 }, { on: false, freq: 3000, gain: 0, q: 1 }, { on: false, freq: 8000, gain: 0, q: 1 }],
    },
    comp: { on: false, threshold: -18, ratio: 2, attack: 20, release: 250, knee: 2.83, makeup: 0, mix: 100, detection: 'rms', link: 'average', mode: 'downward' },
    deess: { on: false, intensity: 0, max: 50, frequency: 50, mode: 'o' },
    echo: { on: false, inGain: 0.6, outGain: 0.3, delay: 1000, decay: 0.5 },
    reverb: { on: false, decay: 1.2, predelay: 15, brightness: 5500, amount: -16 },
    limiter: { on: false, ceiling: -1, inGain: 0, outGain: 0, attack: 5, release: 50, asc: false },
    level: { on: false, lufs: -14, ceiling: -1.5 },
    spring: { on: false, split: 4500, threshold: -40, ratio: 2, delay: 250, attack: 40, release: 700 },
  }
}

// ── knob metadata (studio units + the normal editing limits) ─────────────────

export interface Knob {
  key: string
  label: string
  desc: string
  kind: 'number' | 'choice' | 'toggle'
  unit?: string
  min?: number; max?: number; step?: number
  /** slider scale */
  log?: boolean
  choices?: { value: string; label: string }[]
}

export const KNOBS: Record<StripKey, Knob[]> = {
  gain: [
    { key: 'db', label: 'Gain', desc: 'Raises or lowers the whole signal before anything else. ffmpeg volume filter.', kind: 'number', unit: 'dB', min: -60, max: 24, step: 0.1 },
  ],
  nr: [
    { key: 'reduction', label: 'Reduction', desc: 'How much steady background noise is lowered. Above about 18 dB long notes can start to sound watery. ffmpeg afftdn noise_reduction.', kind: 'number', unit: 'dB', min: 0.01, max: 97, step: 0.5 },
    { key: 'floor', label: 'Noise floor', desc: 'Level the denoiser treats as noise. Set it just above the hiss between phrases. afftdn noise_floor.', kind: 'number', unit: 'dB', min: -80, max: -20, step: 1 },
    { key: 'residual', label: 'Residual floor', desc: 'How much noise is allowed to remain; higher keeps more of the room and fewer artefacts. afftdn residual_floor.', kind: 'number', unit: 'dB', min: -80, max: -20, step: 1 },
    { key: 'type', label: 'Noise type', desc: 'The spectrum shape the denoiser assumes for the noise. afftdn noise_type.', kind: 'choice', choices: [{ value: 'white', label: 'White (hiss, fans)' }, { value: 'vinyl', label: 'Vinyl' }, { value: 'shellac', label: 'Shellac' }] },
    { key: 'track', label: 'Track noise', desc: 'Re-learn the noise continuously so the denoiser follows a changing room. afftdn track_noise.', kind: 'toggle' },
  ],
  gate: [
    { key: 'threshold', label: 'Threshold', desc: 'Signal below this level is turned down. agate threshold (stored as a linear value).', kind: 'number', unit: 'dB', min: -90, max: 0, step: 0.5 },
    { key: 'range', label: 'Range', desc: 'The most the gate turns the signal down when closed. −90 dB is effectively silence. agate range.', kind: 'number', unit: 'dB', min: -90, max: 0, step: 0.5 },
    { key: 'ratio', label: 'Ratio', desc: 'How strongly signal below the threshold is reduced. agate ratio.', kind: 'number', unit: ':1', min: 1, max: 20, step: 0.1 },
    { key: 'attack', label: 'Attack', desc: 'How fast the gate opens when the signal passes the threshold. agate attack.', kind: 'number', unit: 'ms', min: 0.01, max: 2000, step: 0.1, log: true },
    { key: 'release', label: 'Release', desc: 'How fast the gate closes again. agate release.', kind: 'number', unit: 'ms', min: 0.01, max: 9000, step: 1, log: true },
    { key: 'knee', label: 'Knee', desc: 'Softness of the transition around the threshold: 1 is hard, 8 is very soft. agate knee.', kind: 'number', unit: '', min: 1, max: 8, step: 0.01 },
    { key: 'makeup', label: 'Make-up gain', desc: 'Gain added after gating. agate makeup (stored as a linear value).', kind: 'number', unit: 'dB', min: 0, max: 36, step: 0.1 },
    { key: 'detection', label: 'Detection', desc: 'Measure the signal by its peaks or by its average power. agate detection.', kind: 'choice', choices: [{ value: 'rms', label: 'RMS (average)' }, { value: 'peak', label: 'Peak' }] },
    { key: 'link', label: 'Channel link', desc: 'With stereo input, gate both channels from their average or from the louder one. agate link.', kind: 'choice', choices: [{ value: 'average', label: 'Average' }, { value: 'maximum', label: 'Maximum' }] },
  ],
  comp: [
    { key: 'threshold', label: 'Threshold', desc: 'Signal above this level is turned down. acompressor threshold (stored as a linear value).', kind: 'number', unit: 'dB', min: -60, max: 0, step: 0.5 },
    { key: 'ratio', label: 'Ratio', desc: 'How strongly: 2:1 is gentle, 4:1 firm, 20:1 is limiting. acompressor ratio.', kind: 'number', unit: ':1', min: 1, max: 20, step: 0.1 },
    { key: 'attack', label: 'Attack', desc: 'How fast it reacts. Faster tames sudden peaks but can dull letters. acompressor attack.', kind: 'number', unit: 'ms', min: 0.01, max: 2000, step: 0.1, log: true },
    { key: 'release', label: 'Release', desc: 'How fast it lets go. Too short sounds pumpy on long notes. acompressor release.', kind: 'number', unit: 'ms', min: 0.01, max: 9000, step: 1, log: true },
    { key: 'knee', label: 'Knee', desc: 'Softness of the transition around the threshold: 1 is hard, 8 is very soft. acompressor knee.', kind: 'number', unit: '', min: 1, max: 8, step: 0.01 },
    { key: 'makeup', label: 'Make-up gain', desc: 'Gain added after compression to bring the level back up. acompressor makeup (stored as a linear value).', kind: 'number', unit: 'dB', min: 0, max: 36, step: 0.1 },
    { key: 'mix', label: 'Mix', desc: 'Blend of compressed and untouched signal: 100 % is fully compressed (parallel compression below that). acompressor mix.', kind: 'number', unit: '%', min: 0, max: 100, step: 1 },
    { key: 'detection', label: 'Detection', desc: 'Measure the signal by its peaks or by its average power. acompressor detection.', kind: 'choice', choices: [{ value: 'rms', label: 'RMS (average)' }, { value: 'peak', label: 'Peak' }] },
    { key: 'link', label: 'Channel link', desc: 'With stereo input, compress both channels from their average or from the louder one. acompressor link.', kind: 'choice', choices: [{ value: 'average', label: 'Average' }, { value: 'maximum', label: 'Maximum' }] },
    { key: 'mode', label: 'Mode', desc: 'Downward turns loud parts down (normal). Upward turns quiet parts up. acompressor mode.', kind: 'choice', choices: [{ value: 'downward', label: 'Downward' }, { value: 'upward', label: 'Upward' }] },
  ],
  deess: [
    { key: 'intensity', label: 'Intensity', desc: 'How hard sibilants are reduced. 0 does nothing. Keep it low: ص س ش ز must stay articulated. deesser i.', kind: 'number', unit: '%', min: 0, max: 100, step: 1 },
    { key: 'max', label: 'Maximum reduction', desc: 'The most a sibilant can be turned down. deesser m.', kind: 'number', unit: '%', min: 0, max: 100, step: 1 },
    { key: 'frequency', label: 'Frequency', desc: 'Where the sibilant band sits, as a fraction of the audible range: higher values target higher "s" sounds. deesser f.', kind: 'number', unit: '%', min: 0, max: 100, step: 1 },
    { key: 'mode', label: 'Listen to', desc: 'Output the processed signal, the untouched input, or only what is being removed (to tune by ear). deesser s.', kind: 'choice', choices: [{ value: 'o', label: 'Processed output' }, { value: 'i', label: 'Input (bypass)' }, { value: 'e', label: 'Removed part only' }] },
  ],
  echo: [
    { key: 'delay', label: 'Delay', desc: 'Time before the echo is heard. aecho delays.', kind: 'number', unit: 'ms', min: 1, max: 5000, step: 1, log: true },
    { key: 'decay', label: 'Decay', desc: 'How much of the signal each echo keeps: 0.5 halves it every repeat, 1 never dies away. aecho decays.', kind: 'number', unit: '', min: 0, max: 1, step: 0.01 },
    { key: 'inGain', label: 'Input gain', desc: 'Level of the signal going into the echo. aecho in_gain.', kind: 'number', unit: '', min: 0, max: 1, step: 0.01 },
    { key: 'outGain', label: 'Output gain', desc: 'Level of the echoes mixed back in. aecho out_gain.', kind: 'number', unit: '', min: 0, max: 1, step: 0.01 },
  ],
  reverb: [
    { key: 'amount', label: 'Amount', desc: 'Echo level relative to the voice: −16 dB is subtle, −10 dB clearly audible, −4 dB very wet. Sets the impulse level in the parallel afir branch.', kind: 'number', unit: 'dB', min: -30, max: -3, step: 0.5 },
    { key: 'decay', label: 'Decay', desc: 'How long the echo takes to die away: about 1 s small room, 2 s hall, 3 to 4 s large masjid. Length of the generated impulse.', kind: 'number', unit: 's', min: 0.3, max: 6, step: 0.1 },
    { key: 'predelay', label: 'Pre-delay', desc: 'Gap before the echo starts. Larger keeps the voice clearer and makes the space feel bigger. adelay on the impulse.', kind: 'number', unit: 'ms', min: 0, max: 120, step: 1 },
    { key: 'brightness', label: 'Brightness', desc: 'Top frequency of the echo. Lower is darker, like stone and carpet. lowpass on the impulse.', kind: 'number', unit: 'Hz', min: 1500, max: 12000, step: 100, log: true },
  ],
  limiter: [
    { key: 'ceiling', label: 'Ceiling', desc: 'Peaks never go above this level. alimiter limit (stored as a linear value).', kind: 'number', unit: 'dB', min: -24, max: 0, step: 0.1 },
    { key: 'inGain', label: 'Input gain', desc: 'Gain before the limiter: push into it harder for a louder, denser result. alimiter level_in.', kind: 'number', unit: 'dB', min: -36, max: 36, step: 0.1 },
    { key: 'outGain', label: 'Output gain', desc: 'Gain after limiting. alimiter level_out.', kind: 'number', unit: 'dB', min: -36, max: 36, step: 0.1 },
    { key: 'attack', label: 'Attack', desc: 'Lookahead time the limiter uses to catch peaks. alimiter attack.', kind: 'number', unit: 'ms', min: 0.1, max: 80, step: 0.1 },
    { key: 'release', label: 'Release', desc: 'How fast gain comes back after a peak. alimiter release.', kind: 'number', unit: 'ms', min: 1, max: 8000, step: 1, log: true },
    { key: 'asc', label: 'Auto release (ASC)', desc: 'Smooths the release depending on how long the signal stays over the ceiling. alimiter asc.', kind: 'toggle' },
  ],
  spring: [
    { key: 'split', label: 'From', desc: 'Only the sound above this frequency is ducked; everything below passes untouched. acrossover split (48 dB per octave).', kind: 'number', unit: 'Hz', min: 1000, max: 12000, step: 50, log: true },
    { key: 'threshold', label: 'Threshold', desc: 'How loud a burst in that top band (an “s” or ص) must be to set the ducking off. Set it under the “s” sounds and over the ringing that follows them. sidechaincompress threshold (stored as a linear value).', kind: 'number', unit: 'dB', min: -70, max: 0, step: 0.5 },
    { key: 'ratio', label: 'Ratio', desc: 'How far the top band is turned down after a burst: 2:1 brings the ring down to about the room’s normal level; much more leaves an audible hole after every “s”. sidechaincompress ratio.', kind: 'number', unit: ':1', min: 1, max: 20, step: 0.1 },
    { key: 'delay', label: 'Delay', desc: 'How long after a burst starts the ducking begins. It must be longer than the “s” itself (they last up to about 230 ms), or the end of the “s” is swallowed. adelay on the key.', kind: 'number', unit: 'ms', min: 20, max: 1000, step: 5, log: true },
    { key: 'attack', label: 'Attack', desc: 'How fast the ducking sets in. Slow (tens of ms) so it is not heard as a step. sidechaincompress attack.', kind: 'number', unit: 'ms', min: 0.01, max: 2000, step: 0.1, log: true },
    { key: 'release', label: 'Release', desc: 'How long the top band stays down before it comes back. sidechaincompress release.', kind: 'number', unit: 'ms', min: 0.01, max: 9000, step: 1, log: true },
  ],
  level: [
    { key: 'lufs', label: 'Target loudness', desc: 'Integrated loudness the whole recording is brought to after everything else. YouTube plays back at −14. Plugin stage: measure, one fixed gain, true-peak limiter.', kind: 'number', unit: 'LUFS', min: -70, max: 0, step: 0.1 },
    { key: 'ceiling', label: 'True-peak ceiling', desc: 'Limit applied after the gain, measured on the true (inter-sample) peak at 4× oversampling.', kind: 'number', unit: 'dBTP', min: -20, max: 0, step: 0.1 },
  ],
}

// ── conversions ───────────────────────────────────────────────────────────────

const lin = (db: number) => Math.pow(10, db / 20)
const dbOf = (v: number) => 20 * Math.log10(Math.max(1e-9, v))
const r = (v: number, d = 4) => Number(v.toFixed(d))
const num = (v: unknown, fallback: number): number => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : fallback }
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : v === undefined ? fallback : String(v))
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'string' ? v === 'true' || v === '1' : fallback)

/** Reverb level: the plugin's v1 calibration — `amount` means dB relative to the voice for a decaying-noise impulse of this length. */
const reverbScale = (amount: number, decay: number) => Number((Math.pow(10, (amount - (1.9 + 0.8 * decay)) / 20) / Math.sqrt(1158 * decay)).toPrecision(4))
const reverbAmount = (scale: number, decay: number) => 20 * Math.log10(scale * Math.sqrt(1158 * decay)) + (1.9 + 0.8 * decay)

const bq = (id: string, filter: string, on: boolean, options: Record<string, string | number | boolean>): Step => ({ id, filter, options, ...(on ? {} : { bypass: true }) })

/** The strip as a plugin look, in the fixed signal order. Modules that are off become bypassed steps so their settings survive. */
export function toLook(m: Modules): Look {
  const chain: Step[] = []
  chain.push(bq('gain', 'volume', m.gain.on, { volume: `${r(m.gain.db, 2)}dB` }))
  chain.push(bq('nr', 'afftdn', m.nr.on, { noise_reduction: m.nr.reduction, noise_floor: m.nr.floor, noise_type: m.nr.type, track_noise: m.nr.track, residual_floor: m.nr.residual }))
  chain.push(bq('gate', 'agate', m.gate.on, { threshold: r(lin(m.gate.threshold), 6), range: r(lin(m.gate.range), 6), ratio: m.gate.ratio, attack: m.gate.attack, release: m.gate.release, knee: m.gate.knee, makeup: r(lin(m.gate.makeup), 4), detection: m.gate.detection, link: m.gate.link }))
  const sp = m.spring
  chain.push({
    id: 'spring', filter: 'acrossover', options: { split: String(Math.round(sp.split)), order: '8th' }, ...(sp.on ? {} : { bypass: true }),
    outputs: [[], [{
      filter: 'sidechaincompress', options: { threshold: r(lin(sp.threshold), 6), ratio: sp.ratio, attack: sp.attack, release: sp.release, knee: 2.83, detection: 'rms' },
      // the key is the top band itself, delayed: a burst sets the ducking off only after it has passed
      inputs: [{ kind: 'signal', chain: [{ filter: 'adelay', options: { delays: String(Math.max(1, Math.round(sp.delay))), all: true } }] }],
    }]],
    merge: { filter: 'amix', options: { inputs: 2, normalize: false } },
  })
  const eqOn = m.eq.on
  chain.push(bq('eq:hp', 'highpass', eqOn && m.eq.hp.on, { frequency: m.eq.hp.freq, poles: 2, width_type: 'q', width: m.eq.hp.q }))
  chain.push(bq('eq:ls', 'lowshelf', eqOn && m.eq.ls.on, { frequency: m.eq.ls.freq, gain: m.eq.ls.gain, width_type: 'q', width: m.eq.ls.q }))
  m.eq.bands.forEach((b, i) => chain.push(bq(`eq:b${i + 1}`, 'equalizer', eqOn && b.on, { frequency: b.freq, width_type: 'q', width: b.q, gain: b.gain })))
  chain.push(bq('eq:hs', 'highshelf', eqOn && m.eq.hs.on, { frequency: m.eq.hs.freq, gain: m.eq.hs.gain, width_type: 'q', width: m.eq.hs.q }))
  chain.push(bq('eq:lp', 'lowpass', eqOn && m.eq.lp.on, { frequency: m.eq.lp.freq, poles: 2, width_type: 'q', width: m.eq.lp.q }))
  chain.push(bq('comp', 'acompressor', m.comp.on, { threshold: r(lin(m.comp.threshold), 6), ratio: m.comp.ratio, attack: m.comp.attack, release: m.comp.release, knee: m.comp.knee, makeup: r(lin(m.comp.makeup), 4), mix: r(m.comp.mix / 100, 3), detection: m.comp.detection, link: m.comp.link, mode: m.comp.mode }))
  chain.push(bq('deess', 'deesser', m.deess.on, { i: r(m.deess.intensity / 100, 3), m: r(m.deess.max / 100, 3), f: r(m.deess.frequency / 100, 3), s: m.deess.mode }))
  chain.push(bq('echo', 'aecho', m.echo.on, { in_gain: m.echo.inGain, out_gain: m.echo.outGain, delays: String(m.echo.delay), decays: String(m.echo.decay) }))
  const rv = m.reverb
  chain.push({
    id: 'reverb', filter: 'asplit', options: { outputs: 2 }, ...(rv.on ? {} : { bypass: true }),
    outputs: [[], [{
      filter: 'afir', options: { gtype: 'none' },
      inputs: [{
        kind: 'generate', filter: 'aevalsrc', options: { exprs: `(random(0)*2-1)*exp(-6.9078*t/${rv.decay})*${reverbScale(rv.amount, rv.decay)}`, sample_rate: 48000, duration: rv.decay },
        chain: [{ filter: 'lowpass', options: { frequency: rv.brightness } }, { filter: 'adelay', options: { delays: String(Math.max(1, Math.round(rv.predelay))), all: true } }],
      }],
    }]],
    merge: { filter: 'amix', options: { inputs: 2, normalize: false } },
  })
  chain.push(bq('limiter', 'alimiter', m.limiter.on, { limit: r(lin(m.limiter.ceiling), 5), level_in: r(lin(m.limiter.inGain), 4), level_out: r(lin(m.limiter.outGain), 4), attack: m.limiter.attack, release: m.limiter.release, asc: m.limiter.asc }))
  return { chain, level: m.level.on ? { lufs: m.level.lufs, ceiling: m.level.ceiling } : null }
}

/** Steps the strip could not represent (reported to the user when a look is loaded). */
export interface FromLook { modules: Modules; unmapped: string[] }

/** Read a look back onto the strip. Ids first; without ids (v1 conversions, hand-made looks) the first step of each filter is taken. */
export function fromLook(look: Look | null | undefined): FromLook {
  const m = defaultModules()
  const unmapped: string[] = []
  const steps = look?.chain ?? []
  const used = new Set<Step>()
  const take = (id: string, filter: string): Step | undefined => {
    const byId = steps.find((s) => s.id === id)
    if (byId) { used.add(byId); return byId }
    if (steps.some((s) => s.id)) return undefined   // a look with ids: missing id = module off
    const s = steps.find((x) => x.filter === filter && !used.has(x))   // first not yet taken
    if (s) used.add(s)
    return s
  }
  const on = (s: Step | undefined) => !!s && !s.bypass
  const o = (s: Step | undefined) => s?.options ?? {}

  let s = take('gain', 'volume')
  if (s) { const v = str(o(s).volume, '0dB'); const db = v.endsWith('dB') ? Number(v.slice(0, -2)) : Number.isFinite(Number(v)) ? dbOf(Number(v)) : 0; m.gain = { on: on(s), db: r(db, 2) } }
  s = take('nr', 'afftdn')
  if (s) m.nr = { on: on(s), reduction: num(o(s).noise_reduction ?? o(s).nr, 12), floor: num(o(s).noise_floor ?? o(s).nf, -50), type: (['white', 'vinyl', 'shellac'] as const).find((t) => t === str(o(s).noise_type ?? o(s).nt, 'white')) ?? 'white', track: bool(o(s).track_noise ?? o(s).tn, false), residual: num(o(s).residual_floor ?? o(s).rf, -38) }
  s = take('gate', 'agate')
  if (s) m.gate = { on: on(s), threshold: r(dbOf(num(o(s).threshold, 0.125)), 2), range: r(dbOf(num(o(s).range, 0.06125)), 2), ratio: num(o(s).ratio, 2), attack: num(o(s).attack, 20), release: num(o(s).release, 250), knee: num(o(s).knee, 2.82843), makeup: r(dbOf(num(o(s).makeup, 1)), 2), detection: str(o(s).detection, 'rms') === 'peak' ? 'peak' : 'rms', link: str(o(s).link, 'average') === 'maximum' ? 'maximum' : 'average' }
  s = steps.find((x) => x.id === 'spring')   // only by id: an acrossover from elsewhere is not the strip's tamer
  if (s) {
    used.add(s)
    const sc = s.outputs?.[1]?.find((x) => x.filter === 'sidechaincompress')
    const dl = sc?.inputs?.[0]?.chain?.find((x) => x.filter === 'adelay')
    if (sc) m.spring = { on: on(s), split: num(String(o(s).split ?? '4500').split(/[ |]/)[0], 4500), threshold: r(dbOf(num(o(sc).threshold, 0.01)), 2), ratio: num(o(sc).ratio, 2), delay: dl ? num(String(dl.options?.delays ?? '250').split('|')[0], 250) : 250, attack: num(o(sc).attack, 40), release: num(o(sc).release, 700) }
    else unmapped.push('a crossover that is not the strip’s spring tamer')
  }
  // EQ: without ids, highpass steps may be doubled (v1 used two for 24 dB/oct) — the extras are noted
  const hp = take('eq:hp', 'highpass'); const ls = take('eq:ls', 'lowshelf'); const hs = take('eq:hs', 'highshelf'); const lp = take('eq:lp', 'lowpass')
  const bands: (Step | undefined)[] = []
  for (let i = 0; i < EQ_BANDS; i++) bands.push(take(`eq:b${i + 1}`, 'equalizer'))
  const anyEq = [hp, ls, hs, lp, ...bands].some(Boolean)
  if (anyEq) {
    const eqOn = [hp, ls, hs, lp, ...bands].some((x) => on(x))
    m.eq.on = eqOn
    if (hp) m.eq.hp = { on: on(hp), freq: num(o(hp).frequency ?? o(hp).f, 3000), q: num(o(hp).width ?? o(hp).w, 0.707) }
    if (lp) m.eq.lp = { on: on(lp), freq: num(o(lp).frequency ?? o(lp).f, 500), q: num(o(lp).width ?? o(lp).w, 0.707) }
    if (ls) m.eq.ls = { on: on(ls), freq: num(o(ls).frequency ?? o(ls).f, 100), gain: num(o(ls).gain ?? o(ls).g, 0), q: num(o(ls).width ?? o(ls).w, 0.5) }
    if (hs) m.eq.hs = { on: on(hs), freq: num(o(hs).frequency ?? o(hs).f, 3000), gain: num(o(hs).gain ?? o(hs).g, 0), q: num(o(hs).width ?? o(hs).w, 0.5) }
    bands.forEach((b, i) => { if (b) m.eq.bands[i] = { on: on(b), freq: num(o(b).frequency ?? o(b).f, m.eq.bands[i]!.freq), gain: num(o(b).gain ?? o(b).g, 0), q: num(o(b).width ?? o(b).w, 1) } })
  }
  s = take('comp', 'acompressor')
  if (s) m.comp = { on: on(s), threshold: r(dbOf(num(o(s).threshold, 0.125)), 2), ratio: num(o(s).ratio, 2), attack: num(o(s).attack, 20), release: num(o(s).release, 250), knee: num(o(s).knee, 2.82843), makeup: r(dbOf(num(o(s).makeup, 1)), 2), mix: r(num(o(s).mix, 1) * 100, 1), detection: str(o(s).detection, 'rms') === 'peak' ? 'peak' : 'rms', link: str(o(s).link, 'average') === 'maximum' ? 'maximum' : 'average', mode: str(o(s).mode, 'downward') === 'upward' ? 'upward' : 'downward' }
  s = take('deess', 'deesser')
  if (s) m.deess = { on: on(s), intensity: r(num(o(s).i, 0) * 100, 1), max: r(num(o(s).m, 0.5) * 100, 1), frequency: r(num(o(s).f, 0.5) * 100, 1), mode: (['i', 'o', 'e'] as const).find((x) => x === str(o(s).s, 'o')) ?? 'o' }
  s = take('echo', 'aecho')
  if (s) m.echo = { on: on(s), inGain: num(o(s).in_gain, 0.6), outGain: num(o(s).out_gain, 0.3), delay: num(String(o(s).delays ?? '1000').split('|')[0], 1000), decay: num(String(o(s).decays ?? '0.5').split('|')[0], 0.5) }
  s = take('reverb', 'asplit')
  if (s) {
    const afir = s.outputs?.[1]?.find((x) => x.filter === 'afir')
    const gen = afir?.inputs?.find((i) => i.kind === 'generate') as { kind: 'generate'; options?: Record<string, unknown>; chain?: Step[] } | undefined
    if (afir && gen) {
      const decay = num(gen.options?.duration, 1.2)
      const scaleMatch = /\*([0-9.e+-]+)\s*$/.exec(str(gen.options?.exprs, ''))
      const amount = scaleMatch ? reverbAmount(Number(scaleMatch[1]), decay) : -16
      const lp2 = gen.chain?.find((x) => x.filter === 'lowpass'), dl = gen.chain?.find((x) => x.filter === 'adelay')
      m.reverb = { on: on(s), decay: r(decay, 2), predelay: dl ? num(String(dl.options?.delays ?? '0').split('|')[0], 0) : 0, brightness: lp2 ? num(lp2.options?.frequency ?? lp2.options?.f, 5500) : 5500, amount: r(Math.min(-3, Math.max(-30, amount)), 1) }
    } else unmapped.push('a split that is not the strip’s reverb')
  }
  s = take('limiter', 'alimiter')
  if (s) m.limiter = { on: on(s), ceiling: r(dbOf(num(o(s).limit, 1)), 2), inGain: r(dbOf(num(o(s).level_in, 1)), 2), outGain: r(dbOf(num(o(s).level_out, 1)), 2), attack: num(o(s).attack, 5), release: num(o(s).release, 50), asc: bool(o(s).asc, false) }
  if (look?.level) m.level = { on: true, lufs: look.level.lufs, ceiling: look.level.ceiling }
  for (const st of steps) if (!used.has(st)) unmapped.push(st.filter)
  return { modules: m, unmapped }
}

export function countOn(m: Modules): number {
  let n = 0
  for (const k of MODULE_ORDER) if ((m[k] as { on: boolean }).on) n++
  if (m.eq.on && [m.eq.hp, m.eq.lp, m.eq.ls, m.eq.hs, ...m.eq.bands].some((b) => b.on)) n++
  return n
}
