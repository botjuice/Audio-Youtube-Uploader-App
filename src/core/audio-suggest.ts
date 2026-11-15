/**
 * "Auto-set": strip settings suggested from measurements, never from fixed numbers about any one reciter.
 *
 * Two inputs, both measured by the app on the user's own files (plugin `measure()`):
 *   - the reciter's profile: what is typical across all of that reciter's recordings (median + quartiles), and
 *   - this recording's own measurement.
 * The profile sets the reciter's usual range (tone, where the voice starts); the recording itself
 * decides the tweaks (how far its tone is off, how much its level jumps, whether its noise can be measured).
 *
 * The aim (Umo, 2026-11-13): the clearest result, as if heard through a very good sound system. So besides
 * consistency there is a clarity lift (the reciter's typical tone against the usual slope of a clear voice), the
 * compressor is always on gently, and reverb is only added to recordings that are actually dry.
 *
 * Every decision is returned as a note with the numbers behind it, and nothing is hidden: the result is
 * plain strip settings the user can see and change. Every module is set.
 */
import { MEASURE_BANDS, MEASURE_VERSION, type Measure, type RingMeasure } from '../plugins/audio/types'
import { defaultModules, type EqState, type ModuleKey, type Modules } from './audio-modules'
import { eqResponseDb } from './eq-response'
import builtIn from './reciter-profiles.json'

/** A reciter needs at least this many measured recordings before "typical" means anything. */
export const MIN_PROFILE_RECORDINGS = 8

export interface Quartiles { p25: number; p50: number; p75: number }
export interface ReciterProfile {
  /** Recordings the profile was built from. */
  count: number
  /** Typical tone per MEASURE_BANDS entry, dB relative to the voice level. */
  tone: Quartiles[]
  sibilance: Quartiles
}
export interface SuggestNote { module: ModuleKey; text: string }
export interface Suggestion { modules: Modules; notes: SuggestNote[] }

const quart = (values: number[]): Quartiles => {
  const s = [...values].sort((a, b) => a - b)
  const at = (q: number) => { const i = q * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo]! + (s[hi]! - s[lo]!) * (i - lo) }
  return { p25: at(0.25), p50: at(0.5), p75: at(0.75) }
}

export function buildProfile(measures: Measure[]): ReciterProfile | null {
  const ms = measures.filter((m) => m.tone.length === MEASURE_BANDS.length)
  if (ms.length < MIN_PROFILE_RECORDINGS) return null
  return {
    count: ms.length,
    tone: MEASURE_BANDS.map((_, b) => quart(ms.map((m) => m.tone[b]!))),
    sibilance: quart(ms.map((m) => m.sibilance)),
  }
}

/** Profiles shipped with the app, for reciters every user records: used until a library has enough recordings of
 *  its own. Made by scripts/reciter-profile.ts from real measurements; keyed by reciterKey(folder). */
const BUILT_IN = builtIn as unknown as Record<string, { reciter: string; measureVersion: number; profile: ReciterProfile; target?: ReciterTarget }>
export function builtInProfile(key: string | null | undefined): ReciterProfile | null {
  const hit = key ? BUILT_IN[key] : undefined
  return hit && hit.measureVersion === MEASURE_VERSION ? hit.profile : null
}

/**
 * The sound every recording of a reciter is steered towards: how the reciter's best recordings measure AFTER the
 * settings approved by ear (scripts/reciter-target.ts makes it: process, measure, take the median).
 */
export interface ReciterTarget {
  /** Recordings it was measured on. */
  count: number
  /** High-pass of the approved settings, Hz. */
  hp: number
  /** Tone of the processed recordings per MEASURE_BANDS entry, dB relative to the voice level (median). */
  tone: number[]
  /** How far their loudest moments (99th percentile) sit above their typical level after processing, dB (median). */
  over: number
  /** Their quiet moments per MEASURE_BANDS entry after processing, dB relative to the voice level (median): how much static the best recordings have. */
  quiet: number[]
  /** What is left of the ring after an “s” in them after processing (100–150 ms after it), dB over the room’s level (median). */
  ring: number
  /** Their loudness as recorded, LUFS (median): what every release is brought to. */
  lufs: number
  /** A rule made by the user also carries the settings it came from: the modules that are taste, not measured (gain,
   *  gate, de-esser, delay, reverb, limiter), are taken from here. The target that ships with the app has none. */
  base?: Modules
  baseVoiceDb?: number
  /** How quiet the references' quietest moments are after processing, dB under the voice (mean): how much room they have
   *  in them. With a rule that uses reverb, each recording's reverb is set to reach this. */
  floorDb?: number
}
export function builtInTarget(key: string | null | undefined): ReciterTarget | null {
  const hit = key ? BUILT_IN[key] : undefined
  const t = hit?.target
  return t && hit.measureVersion === MEASURE_VERSION && t.tone.length === MEASURE_BANDS.length && t.quiet?.length === MEASURE_BANDS.length && Number.isFinite(t.lufs) && Number.isFinite(t.ring) ? t : null
}

// ── tone ──────────────────────────────────────────────────────────────────────

/** Differences smaller than this are left alone, dB. */
const TONE_DEADBAND = 1
/** The most any band is asked to change, dB. */
const TONE_MAX = 6
/** A band is only boosted when the voice in it stands this far above the recording's quiet moments, dB (else the boost raises noise). */
const BOOST_MIN_CLEARANCE = 10
/** Bands compared: below ~100 Hz is under the voice, above 10 kHz depends on the file format more than on the sound. */
const FIT_LO = 100, FIT_HI = 10000

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(4))
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 : 0 }

/** Where the reciter's voice starts: the lowest band within 24 dB of the strongest one, across the profile. */
export function voiceLowEdge(profile: ReciterProfile): number {
  const top = Math.max(...profile.tone.map((q) => q.p50))
  const i = profile.tone.findIndex((q) => q.p50 >= top - 24)
  return MEASURE_BANDS[Math.max(0, i)]!
}

/** The change each band should get (dB, per MEASURE_BANDS entry; 0 outside the compared range). */
export function toneTarget(m: Measure, profile: ReciterProfile, lowEdge = voiceLowEdge(profile)): number[] {
  const use = MEASURE_BANDS.map((f) => f >= Math.max(FIT_LO, lowEdge) && f <= FIT_HI)
  const raw = MEASURE_BANDS.map((_, b) => profile.tone[b]!.p50 - m.tone[b]!)
  // an overall offset is loudness, not tone (levelling handles it)
  const off = median(raw.filter((_, b) => use[b]))
  const d = raw.map((v) => v - off)
  // inside the reciter's usual range (the middle half of their recordings) a band is left alone; outside it,
  // the band is moved back to the edge of that range. Where the reciter's own recordings differ a lot (the bands
  // that follow the pitch of the recitation), the range is wide and little is touched.
  const out = d.map((v, b) => {
    const q = profile.tone[b]!
    return v > 0 ? Math.max(0, v - (q.p50 - q.p25)) : Math.min(0, v + (q.p75 - q.p50))
  })
  // smooth over neighbouring bands: one third-octave on its own is not a tone problem
  const sm = out.map((v, b) => { const a = use[b - 1] ? out[b - 1]! : v, c = use[b + 1] ? out[b + 1]! : v; return 0.25 * a + 0.5 * v + 0.25 * c })
  return sm.map((v, b) => {
    if (!use[b]) return 0
    let c = clamp(v, -TONE_MAX, TONE_MAX)
    if (Math.abs(c) < TONE_DEADBAND) c = 0
    if (c > 0 && m.tone[b]! - m.quiet[b]! < BOOST_MIN_CLEARANCE) c = 0
    return c
  })
}

// ── clarity ───────────────────────────────────────────────────────────────────

/** A clear close-miked voice falls about this much per octave above 500 Hz in its long-term spectrum (the standard
 *  speech spectrum used for intelligibility work falls 5 to 6 dB per octave there). Third-octave band levels. */
const CLEAR_SLOPE = 5.5
const CLEAR_FROM = 500
/** How much of a reciter's shortfall against that slope is made up. Not all of it: recitation is long vowels, which are
 *  naturally darker than speech, and every dB of lift also lifts what the microphone picked up besides the voice. */
const CLARITY_SHARE = 0.5
/** The most the clarity lift adds to any band, dB. */
const CLARITY_MAX = 8
/** The most the EQ as a whole (clarity + this recording's correction) asks of any band, dB. */
const EQ_MAX = 9

/** The clear-voice line for a tone (per band, same units as the tone): level with its 400–630 Hz body, falling CLEAR_SLOPE per octave above 500 Hz. */
function clearLine(tone: number[]): number[] {
  const body = MEASURE_BANDS.map((f, b) => (f >= 400 && f <= 630 ? tone[b]! : null)).filter((v): v is number => v !== null)
  const ref = body.reduce((a, v) => a + v, 0) / body.length
  return MEASURE_BANDS.map((f) => ref - CLEAR_SLOPE * Math.log2(Math.max(f, CLEAR_FROM) / CLEAR_FROM))
}

/** Lift per band (dB, ≥ 0) that brings the reciter's typical tone part of the way to a clear voice. From the profile, so
 *  it is the same for every recording of the reciter. */
export function clarityLift(profile: ReciterProfile): number[] {
  const typical = profile.tone.map((q) => q.p50), clear = clearLine(typical)
  const raw = MEASURE_BANDS.map((f, b) => (f <= CLEAR_FROM || f > FIT_HI ? 0 : clamp((clear[b]! - typical[b]!) * CLARITY_SHARE, 0, CLARITY_MAX)))
  // a lift is a broad tilt, not a band-by-band repair
  return raw.map((v, b) => (MEASURE_BANDS[b]! <= CLEAR_FROM || MEASURE_BANDS[b]! > FIT_HI ? 0 : 0.25 * (raw[b - 1] ?? v) + 0.5 * v + 0.25 * (raw[b + 1] ?? v)))
}

interface FitParam { get: () => number; set: (v: number) => void; lo: number; hi: number; step: number; mul: boolean }

/** Fit the strip's low shelf, bells and high shelf to a per-band target, with as few bells as do the job.
 *  Returns the EQ (high-pass and low-pass untouched) and the error left, dB RMS. */
export function fitEq(base: EqState, target: number[]): { eq: EqState; rms: number } {
  const idx = MEASURE_BANDS.map((f, b) => (f >= FIT_LO && f <= FIT_HI ? b : -1)).filter((b) => b >= 0)
  const d = defaultModules().eq
  const rmsOf = (eq: EqState) => {
    let e = 0
    for (const b of idx) { const x = eqResponseDb(eq, MEASURE_BANDS[b]!) - target[b]!; e += x * x }
    return Math.sqrt(e / idx.length)
  }
  const fitWith = (bells: number): { eq: EqState; rms: number } => {
    const eq: EqState = {
      ...base, on: true, hp: { ...base.hp, on: false }, lp: { ...base.lp, on: false },
      ls: { on: true, freq: 200, gain: 0, q: 0.7 }, hs: { on: true, freq: 4000, gain: 0, q: 0.7 },
      bands: base.bands.map((_, i) => ({ on: i < bells, freq: 1000, gain: 0, q: 1.4 })),
    }
    let active = eq.bands.filter((x) => x.on)
    // squared error, plus a little for every dB of EQ so that two fits about as good resolve to the gentler one
    const error = () => {
      let g = Math.abs(eq.ls.gain) + Math.abs(eq.hs.gain)
      for (const band of active) g += Math.abs(band.gain)
      // two bells on top of each other only fight or stack past the limit: keep them at least half an octave apart
      for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
        const ratio = active[i]!.freq / active[j]!.freq
        if (ratio < 1.41 && ratio > 1 / 1.41) g += 1000
      }
      return rmsOf(eq) ** 2 + 0.02 * g
    }
    const residualAt = (b: number) => target[b]! - eqResponseDb(eq, MEASURE_BANDS[b]!)
    const mean = (bs: number[]) => (bs.length ? bs.reduce((s, b) => s + target[b]!, 0) / bs.length : 0)
    eq.ls.gain = clamp(mean(idx.filter((b) => MEASURE_BANDS[b]! <= 200)), -EQ_MAX, EQ_MAX)
    eq.hs.gain = clamp(mean(idx.filter((b) => MEASURE_BANDS[b]! >= 5000)), -EQ_MAX, EQ_MAX)
    for (const band of active) {
      let worst = idx[0]!
      for (const b of idx) if (Math.abs(residualAt(b)) > Math.abs(residualAt(worst))) worst = b
      band.freq = clamp(MEASURE_BANDS[worst]!, 200, 8000)
      if (active.some((o) => o !== band && o.gain !== 0 && o.freq / band.freq < 1.41 && band.freq / o.freq < 1.41)) { band.on = false; continue }
      band.gain = clamp(residualAt(worst), -EQ_MAX, EQ_MAX)
    }
    active = active.filter((x) => x.on)
    const params: FitParam[] = [
      { get: () => eq.ls.gain, set: (v) => { eq.ls.gain = v }, lo: -EQ_MAX, hi: EQ_MAX, step: 1, mul: false },
      { get: () => eq.ls.freq, set: (v) => { eq.ls.freq = v }, lo: 100, hi: 400, step: 1.25, mul: true },
      { get: () => eq.hs.gain, set: (v) => { eq.hs.gain = v }, lo: -EQ_MAX, hi: EQ_MAX, step: 1, mul: false },
      { get: () => eq.hs.freq, set: (v) => { eq.hs.freq = v }, lo: 2000, hi: 8000, step: 1.25, mul: true },
      ...active.flatMap((band): FitParam[] => [
        { get: () => band.gain, set: (v) => { band.gain = v }, lo: -EQ_MAX, hi: EQ_MAX, step: 1, mul: false },
        { get: () => band.freq, set: (v) => { band.freq = v }, lo: 200, hi: 8000, step: 1.25, mul: true },
        { get: () => band.q, set: (v) => { band.q = v }, lo: 0.6, hi: 2, step: 1.3, mul: true },
      ]),
    ]
    // pattern search: try each setting a step up and down, keep what helps, then halve the steps
    let best = error()
    for (let scale = 1; scale > 0.05; scale /= 2) {
      for (let sweep = 0; sweep < 12; sweep++) {
        let improved = false
        for (const p of params) {
          const cur = p.get()
          for (const dir of [1, -1]) {
            const next = clamp(p.mul ? cur * Math.pow(p.step, dir * scale) : cur + dir * p.step * scale, p.lo, p.hi)
            if (next === cur) continue
            p.set(next)
            const e = error()
            if (e < best - 1e-6) { best = e; improved = true; break }
            p.set(cur)
          }
        }
        if (!improved) break
      }
    }
    // tidy: knob-sized values, and anything too small to hear is switched off
    const tidy = <T extends { on: boolean; freq: number; gain: number; q: number }>(x: T, def: T): T => {
      const gain = round(x.gain, 0.1)
      return !x.on || Math.abs(gain) < 0.5 ? { ...def, on: false } : { ...x, on: true, gain, freq: Math.round(x.freq), q: round(x.q, 0.01) }
    }
    eq.ls = tidy(eq.ls, d.ls); eq.hs = tidy(eq.hs, d.hs)
    const kept = eq.bands.map((b, i) => tidy(b, d.bands[i]!)).filter((b) => b.on).sort((a, b) => a.freq - b.freq)
    eq.bands = d.bands.map((def, i) => kept[i] ?? { ...def, on: false })
    return { eq, rms: rmsOf(eq) }
  }
  // the fewest bells that get within 0.15 dB of the best fit
  const fits = base.bands.map((_, i) => fitWith(i)).concat(fitWith(base.bands.length))
  const bestRms = Math.min(...fits.map((f) => f.rms))
  const pick = fits.find((f) => f.rms <= bestRms + 0.15)!
  return { eq: { ...pick.eq, hp: base.hp, lp: base.lp }, rms: pick.rms }
}

// ── dynamics, noise, sibilance ────────────────────────────────────────────────

/** Where the gentle compressor aims to hold the loudest moments (99th percentile) above the recording's typical level, dB. */
const PEAK_OVER_TYPICAL = 4
/** Pauses must get this quiet (dB under the voice) before a recording counts as dry enough to add reverb to. */
const DRY_PAUSES = 35
/** Quiet moments must drop this far below the voice before they count as background noise rather than quiet voice, dB. */
const NOISE_MEASURABLE = 30
/** Background this far under the voice is clean enough to leave alone, dB. */
const NOISE_CLEAN = 55

/** afftdn removes the asked amount when its noise floor is set this far above the measured quiet level, dB (measured: at +0 it
 *  removes about two thirds, at +6 and above all of it, with the voice's tone unchanged). */
const NOISE_FLOOR_OVER = 6

const f1 = (v: number) => v.toFixed(1)
const signed = (v: number) => `${v > 0 ? '+' : ''}${f1(v)}`
const hz = (f: number) => (f >= 1000 ? `${Number((f / 1000).toFixed(1))} kHz` : `${Math.round(f)} Hz`)

/** Settings for one recording from the reciter's profile alone: for a reciter who has no target sound yet. */
export function suggest(current: Modules, m: Measure, profile: ReciterProfile, lufs?: number, ring?: RingMeasure | null): Suggestion {
  const out: Modules = JSON.parse(JSON.stringify(current)) as Modules
  const notes: SuggestNote[] = []
  const note = (module: ModuleKey, text: string) => notes.push({ module, text })

  // gain: levelling at the end sets the loudness, so nothing is needed in front
  out.gain = { on: false, db: 0 }
  note('gain', 'Off: loudness levelling at the end sets the level.')

  // noise reduction: only when the background can actually be measured
  const snr = -m.floorDb
  if (snr < NOISE_MEASURABLE) {
    out.nr.on = false
    note('nr', `Off: there is no pause quiet enough to measure the background (the quietest moments are only ${f1(snr)} dB under the voice), and guessing would eat into the voice.`)
  } else if (snr >= NOISE_CLEAN) {
    out.nr.on = false
    note('nr', `Off: the background is ${f1(snr)} dB under the voice, which is clean.`)
  } else {
    const d = defaultModules().nr
    out.nr = { ...d, on: true, reduction: round(clamp(NOISE_CLEAN - snr, 3, 12), 0.5), floor: Math.round(clamp(m.voiceDb + m.floorDb + NOISE_FLOOR_OVER, -80, -20)), track: false }
    note('nr', `On, ${f1(out.nr.reduction)} dB: the background sits ${f1(snr)} dB under the voice (at ${out.nr.floor} dB); the reduction brings it towards ${NOISE_CLEAN} dB under and is capped at 12 dB so long notes stay natural.`)
  }

  out.gate.on = false
  note('gate', 'Off: a gate cuts breaths and the tails of long notes in recitation.')

  // EQ: high-pass under the reciter's voice, a clarity lift for the reciter, and this recording back into the reciter's range
  const lowEdge = voiceLowEdge(profile)
  const hpFreq = round(clamp(lowEdge / 1.6, 40, 150), 5)
  const own = toneTarget(m, profile, lowEdge)
  // no lift where this recording has more background than voice
  const lift = clarityLift(profile).map((v, b) => (m.tone[b]! - m.quiet[b]! < BOOST_MIN_CLEARANCE ? 0 : v))
  // above 500 Hz the clear line is the limit both ways: a recording that is brighter than the reciter's usual but still
  // under the line is not darkened back, and nothing is lifted past the line
  const clear = clearLine(m.tone)
  const want = own.map((v, b) => {
    let c = v + lift[b]!
    if (MEASURE_BANDS[b]! > CLEAR_FROM && MEASURE_BANDS[b]! <= FIT_HI) {
      const room = clear[b]! - m.tone[b]!   // how far this recording is under the line (negative = over it)
      c = c > 0 ? Math.min(c, Math.max(0, room)) : Math.max(c, Math.min(0, room))
    }
    return clamp(c, -EQ_MAX, EQ_MAX)
  })
  const fit = fitEq(out.eq, want)
  out.eq = { ...fit.eq, on: true, hp: { on: true, freq: hpFreq, q: 0.707 }, lp: { ...out.eq.lp, on: false } }
  const moves = [
    ...(out.eq.ls.on ? [`low shelf ${signed(out.eq.ls.gain)} dB at ${hz(out.eq.ls.freq)}`] : []),
    ...out.eq.bands.filter((b) => b.on).map((b) => `${signed(b.gain)} dB at ${hz(b.freq)}`),
    ...(out.eq.hs.on ? [`high shelf ${signed(out.eq.hs.gain)} dB at ${hz(out.eq.hs.freq)}`] : []),
  ]
  const liftTop = Math.max(...lift), liftAt = MEASURE_BANDS[lift.indexOf(liftTop)]!
  const ownMoves = own.some((v) => v !== 0)
  note('eq', `High-pass at ${hz(hpFreq)}: this reciter’s voice starts around ${hz(lowEdge)} across ${profile.count} recordings, so only rumble is below it.`)
  note('eq', liftTop >= TONE_DEADBAND
    ? `Clarity: across ${profile.count} recordings this reciter’s sound is darker above ${hz(CLEAR_FROM)} than a clear voice (which falls about ${CLEAR_SLOPE} dB per octave there). Half of the shortfall is made up, most at ${hz(liftAt)} (${signed(liftTop)} dB).`
    : `Clarity: this reciter’s typical tone is already as bright as a clear voice; no lift.`)
  note('eq', ownMoves ? 'This recording is also brought back inside the reciter’s usual range where it was outside it, except where it was simply brighter and still under the clear-voice line.' : 'This recording is inside the reciter’s usual range, so it gets nothing beyond that.')
  note('eq', moves.length ? `Together: ${moves.join(', ')}.` : 'No tone change needed.')

  // compressor: always on, gently; firmer only when this recording jumps more
  const over = m.levels.p99 - m.levels.p50
  out.comp = { ...defaultModules().comp, on: true, threshold: round(clamp(m.voiceDb + m.levels.p50, -60, 0), 0.5), ratio: round(clamp(over / PEAK_OVER_TYPICAL, 1.5, 3), 0.1), attack: 15, release: 250, makeup: 0 }
  note('comp', `On, ${f1(out.comp.ratio)}:1 above ${f1(out.comp.threshold)} dB (this recording’s typical level). Its loudest moments are ${f1(over)} dB above that; the aim is about ${PEAK_OVER_TYPICAL} dB, never gentler than 1.5:1 or firmer than 3:1.`)

  // de-esser: measured on real recitation (2026-11-13), ffmpeg's deesser does not pick out the "s" sounds: up to about
  // 40 % it changes nothing, above that it dulls everything over 4 kHz by several dB while the sharpest "s" stay as sharp.
  // That works against clarity, so it stays off; a recording with unusually sharp "s" is said so instead.
  out.deess.on = false
  const sib = profile.sibilance, spread = sib.p75 - sib.p25
  const excess = spread > 0 ? m.sibilance - (sib.p75 + spread) : 0
  note('deess', excess > 0
    ? `Off, but listen for the “s” sounds: they are ${f1(excess)} dB sharper here than in this reciter’s usual recordings. The de-esser is not used because on recitation it dulls the whole top end instead of only the “s”.`
    : 'Off: the “s” sounds are within this reciter’s usual range, and on recitation this de-esser dulls the whole top end instead of only the “s”.')

  out.echo.on = false
  note('echo', 'Off: a repeating echo works against clarity.')

  // reverb: only for a recording that is actually dry
  if (snr < DRY_PAUSES) {
    out.reverb.on = false
    note('reverb', `Off: between phrases the level only falls ${f1(snr)} dB below the voice, so the recording already carries its room (or its noise). More reverb would blur it.`)
  } else {
    out.reverb = { on: true, decay: 1.6, predelay: 25, brightness: 5000, amount: -18 }
    note('reverb', `On, subtle (1.6 s, ${f1(out.reverb.amount)} dB under the voice, 25 ms pre-delay so words stay clear): the recording is dry (pauses fall ${f1(snr)} dB below the voice).`)
  }

  out.limiter.on = false
  note('limiter', 'Off: loudness levelling already ends in a true-peak limiter; a second one only adds distortion.')
  const tamer = tamerFor(ring)
  out.spring = tamer.spring
  note('spring', tamer.text)
  setLevel(out, note, lufs)
  return { modules: out, notes }
}

/** Levelling target = the loudness the recording already has: pushing it up to a fixed −14 drove the limiter hard enough to hear. */
function setLevel(out: Modules, note: (module: ModuleKey, text: string) => void, lufs: number | undefined): void {
  if (lufs !== undefined && Number.isFinite(lufs)) {
    out.level = { on: true, lufs: round(clamp(lufs, -70, 0), 0.1), ceiling: -1 }
    note('level', `On at ${f1(out.level.lufs)} LUFS, the loudness this recording already has, so the level stays where it was (Match loudness reads about 0). True-peak ceiling −1 dBTP; the limiter then only touches the odd peak.`)
  } else {
    out.level = { ...out.level, on: true }
    note('level', `On at ${f1(out.level.lufs)} LUFS (this recording’s own loudness could not be measured).`)
  }
}

// ── ringing after "s" sounds ──────────────────────────────────────────────────

/** A ring under this (dB over the level just before the burst) is left alone. */
const RING_MIN = 1.5
/** The tamer never ducks deeper than this, however much rings: deeper is heard as a hole after the "s". */
const RING_MAX_DEPTH = 8
/** Share of the level above the threshold that is taken off when the recording does not say (ratio 2.5:1). */
const TAMER_SLOPE = 0.6
/** The share is taken from the recording (how much more a louder "s" rings) only within these limits: 1.7:1 … 3.3:1.
 *  Firmer than that (tried: 5:1) left the loudest "s" sounds up to 2 dB under the room's level, the start of a hole. */
const TAMER_SLOPE_MIN = 0.4, TAMER_SLOPE_MAX = 0.7
/** A measured relation flatter than this is noise, not a relation. */
const TAMER_SLOPE_TRUST = 0.2
/** Measured on recordings from −27 to −47 dBFS burst level (2026-11-13): the ducker reacts as if a typical burst were this
 *  much above the burst level `ring()` reports, so depth ≈ (burst level + this − threshold) × share. */
const TAMER_SEES = 1.5

/** Spring tamer settings that counter the ring `ring()` found, every one from this recording: where the ring lives (its
 *  split), as deep as the ring stands out just after an "s" (threshold), growing with louder "s" sounds the way the ring
 *  itself does (ratio), starting once a typical "s" has passed (delay), letting go as fast as the ring dies away (release). */
export function tamerFor(ring: RingMeasure | null | undefined): { spring: Modules['spring']; text: string } {
  const off = { ...defaultModules().spring, on: false }
  if (!ring || !ring.burstMs) return { spring: off, text: `Off: too few “s” bursts were found above ${hz(ring?.splitHz ?? off.split)} to measure a ring (${ring?.bursts ?? 0}).` }
  const at = (ms: number) => ring.excessDb[ring.offsets.indexOf(ms)] ?? 0
  const depth = clamp((at(100) + at(150)) / 2, 0, RING_MAX_DEPTH)
  const where = ring.bands?.length
    ? ` (looked between ${hz(ring.bands[0]!.fromHz)} and ${hz(ring.bands.at(-1)!.fromHz)}: ${ring.bands.map((b) => `${f1(b.excessDb)} dB from ${hz(b.fromHz)}`).join(', ')})`
    : ''
  if (depth < RING_MIN) return { spring: { ...off, split: ring.splitHz }, text: `Off: no ring to speak of. After an “s” the band above ${hz(ring.splitHz)} is back at its level from before within about 0.1 s (${f1(depth)} dB over it)${where}.` }
  const share = ring.slope >= TAMER_SLOPE_TRUST ? clamp(ring.slope, TAMER_SLOPE_MIN, TAMER_SLOPE_MAX) : TAMER_SLOPE
  const spring: Modules['spring'] = {
    on: true, split: ring.splitHz, ratio: round(1 / (1 - share), 0.1),
    threshold: round(clamp(ring.burstDb + TAMER_SEES - depth / share, -70, 0), 0.5),
    delay: round(clamp(ring.burstMs, 100, 300), 10), attack: 70,
    release: round(clamp(ring.halfMs * 1.3, 400, 1500), 50),
  }
  const grows = ring.slope >= TAMER_SLOPE_TRUST ? `a 1 dB louder “s” rings ${f1(ring.slope)} dB more, so ${spring.ratio.toFixed(1)}:1` : `no clear relation between how loud an “s” is and how much it rings, so the usual ${spring.ratio.toFixed(1)}:1`
  return { spring, text: `On above ${hz(ring.splitHz)}, where the ring starts in this recording${where}. ${ring.bursts} “s” bursts found (${f1(ring.perMin)} a minute); after each, that band stays ${f1(depth)} dB above its level from before and takes about ${(ring.halfMs / 1000).toFixed(1)} s to fall halfway back. So it is turned down by about that much (threshold ${f1(spring.threshold)} dB; ${grows}), starting ${spring.delay} ms after the “s” begins (a typical one has passed by then), easing in over 70 ms, and let go over ${spring.release} ms.` }
}

// ── steering a recording to the target ────────────────────────────────────────

const idxFit = MEASURE_BANDS.map((f, b) => (f >= FIT_LO && f <= FIT_HI ? b : -1)).filter((b) => b >= 0)
/** Bands in which static is heard: above the voice's body, where a lift brings it up. */
const STATIC_BANDS = MEASURE_BANDS.map((f, b) => (f >= 5000 && f <= 10000 ? b : -1)).filter((b) => b >= 0)
/** Static under this (dB more than the rule’s recordings have) is left alone: the rule’s recordings are the cleanest ones, a
 *  typical recording has about 2 dB more, and that is not heard as static. */
const STATIC_MIN = 3
/** The most clarity lift that is held back because of static, dB. */
const STATIC_HOLD_MAX = 3
/** The most static noise reduction is asked to remove, dB (more starts to sound watery on long notes). */
const NR_MAX = 9
/** A compressor gentler than this does nothing worth having: it is switched off instead. */
const COMP_MIN_RATIO = 1.15
/** A recording whose quietest moments are within this of the target's has as much room as the target, dB. */
const ROOM_CLOSE = 1.5
/** Levelling may bring peaks this close to the ceiling before the target loudness is lowered so the limiter stays idle, dB. */
const PEAK_MARGIN = 0.3

/** How this recording's tone differs from the target's, smoothed over about an octave (dB per band; + = the recording has
 *  less there). A broad difference is the recording (microphone, distance, mixer); a narrow one is the recitation itself. */
function toneGap(m: Measure, target: ReciterTarget): number[] {
  const use = MEASURE_BANDS.map((f) => f >= Math.max(FIT_LO, target.hp * 1.25) && f <= FIT_HI)
  const raw = MEASURE_BANDS.map((_, b) => target.tone[b]! - m.tone[b]!)
  const off = median(raw.filter((_, b) => use[b]))   // an overall offset is loudness, not tone
  const d = raw.map((v) => v - off)
  const kernel = [1, 2, 3, 2, 1]
  return d.map((_, b) => {
    if (!use[b]) return 0
    let sum = 0, w = 0
    for (let k = -2; k <= 2; k++) if (use[b + k]) { sum += d[b + k]! * kernel[k + 2]!; w += kernel[k + 2]! }
    return sum / w
  })
}

/** The change each band needs (dB, per MEASURE_BANDS entry) for this recording's tone to become the target's. */
export function steerTone(m: Measure, target: ReciterTarget): number[] {
  return toneGap(m, target).map((v, b) => {
    let c = clamp(v, -EQ_MAX, EQ_MAX)
    if (Math.abs(c) < TONE_DEADBAND) c = 0
    if (c > 0 && m.tone[b]! - m.quiet[b]! < BOOST_MIN_CLEARANCE) c = 0   // no lift where there is more background than voice
    return c
  })
}

/** How far a tone is from the target's, dB RMS over the compared range (same smoothing as the steering). */
export function toneDistance(m: Measure, target: ReciterTarget, held?: number[]): number {
  const g = toneGap(m, target)
  return Math.sqrt(idxFit.reduce((a, b) => a + (g[b]! - (held?.[b] ?? 0)) ** 2, 0) / idxFit.length)
}

/** Static: how much less the voice stands clear of the quiet moments in the top bands than it does in the best
 *  recordings, dB. Once the tone is matched, that is how much louder the static is than theirs. ≤ 0 = as clean or cleaner. */
export function staticOver(m: Measure, target: ReciterTarget): number {
  return STATIC_BANDS.reduce((a, b) => a + (target.tone[b]! - target.quiet[b]!) - (m.tone[b]! - m.quiet[b]!), 0) / STATIC_BANDS.length
}

/** What a check of the result fed back: corrections on top of the first estimate. */
export interface Feedback {
  /** Extra change per band on top of the first EQ target, dB. */
  tone: number[]
  /** Multiplies the compressor ratio the first estimate gave. */
  comp: number
  /** Extra static to remove, dB. */
  nr: number
  /** Added to the spring tamer's threshold, dB (negative = deeper). */
  tamer: number
  /** Added to the reverb amount the rule has, dB. */
  reverb: number
}
export const noFeedback = (): Feedback => ({ tone: MEASURE_BANDS.map(() => 0), comp: 1, nr: 0, tamer: 0, reverb: 0 })

export interface Steered extends Suggestion {
  /** Clarity lift held back per band because of static, dB: the result is meant to be this far under the target there. */
  held: number[]
}

/**
 * Auto-set: settings that bring one recording to the reciter's target sound, each module decided from a measurement of
 * this recording against the target, and switched off where the recording already matches. `feedback` carries the
 * corrections from checking an earlier result (see `refine`).
 */
export function steer(current: Modules, m: Measure, target: ReciterTarget, ring?: RingMeasure | null, feedback: Feedback = noFeedback()): Steered {
  const d = defaultModules()
  const out: Modules = JSON.parse(JSON.stringify(current)) as Modules
  const notes: SuggestNote[] = []
  const note = (module: ModuleKey, text: string) => notes.push({ module, text })

  out.gain = { on: false, db: 0 }
  note('gain', 'Off: a gain here raises the voice and any static together, so it cannot make a recording cleaner. Levelling at the end sets the loudness.')

  // ── static: noise reduction and how much of the clarity lift to hold back ──
  const stat = staticOver(m, target)
  const snr = -m.floorDb
  let hold = 0
  if (snr >= NOISE_MEASURABLE) {
    // a recording with real pauses: the background can be measured directly
    if (snr >= NOISE_CLEAN) { out.nr.on = false; note('nr', `Off: in the pauses the background is ${f1(snr)} dB under the voice, which is clean.`) }
    else {
      out.nr = { ...d.nr, on: true, reduction: round(clamp(NOISE_CLEAN - snr + feedback.nr, 3, 12), 0.5), floor: Math.round(clamp(m.voiceDb + m.floorDb + NOISE_FLOOR_OVER, -80, -20)), track: false }
      note('nr', `On, ${f1(out.nr.reduction)} dB: in the pauses the background sits ${f1(snr)} dB under the voice; this brings it towards ${NOISE_CLEAN} dB under.`)
    }
  } else if (stat + feedback.nr <= STATIC_MIN) {
    out.nr.on = false
    note('nr', stat <= 0
      ? `Off: no more static than the rule’s recordings (the voice stands ${f1(-stat)} dB clearer of the quiet moments above 5 kHz than theirs does).`
      : `Off: only ${f1(stat)} dB more static above 5 kHz than the rule’s recordings, too little to act on.`)
  } else {
    // balance: hold back some of the clarity lift, remove the rest with noise reduction
    hold = Math.min(stat / 2, STATIC_HOLD_MAX)
    let remove = Math.min(stat - hold + feedback.nr, NR_MAX)
    if (remove < 2) { remove = 0; hold = Math.min(stat, STATIC_HOLD_MAX) }
    if (remove > 0) {
      // the static's level as broadband noise, from its level in the 6–10 kHz bands
      const white = median([6300, 8000, 10000].map((f) => m.voiceDb + m.quiet[MEASURE_BANDS.indexOf(f)]! - 10 * Math.log10((0.2316 * f) / 24000)))
      out.nr = { ...d.nr, on: true, reduction: round(clamp(remove, 2, 12), 0.5), floor: Math.round(clamp(white + NOISE_FLOOR_OVER + (feedback.nr > 0 ? 3 : 0), -80, -20)), track: false }
      note('nr', `On, ${f1(out.nr.reduction)} dB: above 5 kHz this recording has ${f1(stat)} dB more static than the rule’s recordings. ${f1(hold)} dB of that is avoided by lifting the top end a little less, the rest is removed here (noise floor ${out.nr.floor} dB).`)
    } else {
      out.nr.on = false
      note('nr', `Off: ${f1(stat)} dB more static above 5 kHz than the rule’s recordings; that little is avoided by lifting the top end ${f1(hold)} dB less.`)
    }
  }

  out.gate.on = false
  note('gate', snr >= NOISE_MEASURABLE ? 'Off: even with real pauses, a gate cuts breaths and the tails of long notes.' : `Off: between phrases the level only falls ${f1(snr)} dB, so there is no silence for a gate to close on; it would cut into the recitation.`)

  // ── spring tamer: from the ring found ──
  const tamer = tamerFor(ring)
  out.spring = tamer.spring.on ? { ...tamer.spring, threshold: round(clamp(tamer.spring.threshold + feedback.tamer, -70, 0), 0.5) } : tamer.spring
  note('spring', tamer.text + (tamer.spring.on && feedback.tamer ? ` After checking the result the threshold was moved ${signed(feedback.tamer)} dB.` : ''))

  // ── EQ: whatever takes this recording's tone to the target's, less what is held back for static ──
  const first = steerTone(m, target)
  const held = MEASURE_BANDS.map((f, b) => (hold > 0 && f >= 2000 && first[b]! > 0 ? Math.min(hold, first[b]!) : 0))
  const want = first.map((v, b) => clamp(v + feedback.tone[b]! - held[b]!, -EQ_MAX, EQ_MAX))
  const fit = fitEq({ ...d.eq, on: true }, want)
  out.eq = { ...fit.eq, on: true, hp: { on: true, freq: target.hp, q: 0.707 }, lp: { ...d.eq.lp, on: false } }
  const moves = [
    ...(out.eq.ls.on ? [`low shelf ${signed(out.eq.ls.gain)} dB at ${hz(out.eq.ls.freq)}`] : []),
    ...out.eq.bands.filter((b) => b.on).map((b) => `${signed(b.gain)} dB at ${hz(b.freq)}`),
    ...(out.eq.hs.on ? [`high shelf ${signed(out.eq.hs.gain)} dB at ${hz(out.eq.hs.freq)}`] : []),
  ]
  const apart = toneDistance(m, target)
  const gap = toneGap(m, target)
  const most = idxFit.reduce((a, b) => (Math.abs(gap[b]!) > Math.abs(gap[a]!) ? b : a), idxFit[0]!)
  if (target.hp > 0) note('eq', `High-pass ${hz(target.hp)} (rumble under the voice).`)
  else { out.eq.hp = { ...d.eq.hp, on: false }; note('eq', 'No high-pass: the rule has none.') }
  note('eq', !moves.length
    ? `Tone: already ${f1(apart)} dB from the target on average, close enough to leave alone.`
    : `Tone: ${f1(apart)} dB from the target on average, most at ${hz(MEASURE_BANDS[most]!)} (${f1(Math.abs(gap[most]!))} dB too ${gap[most]! > 0 ? 'little' : 'much'}). EQ: ${moves.join(', ')}.`)

  // ── compressor: only when this recording's level jumps more than the rule’s recordings' does ──
  const over = m.levels.p99 - m.levels.p50
  const ratio = (over / Math.max(1, target.over - 0.3)) * feedback.comp
  if (ratio < COMP_MIN_RATIO) {
    out.comp = { ...d.comp, on: false }
    note('comp', `Off: the level is already as even as the rule’s recordings’ (loudest moments ${f1(over)} dB above the typical level; theirs are ${f1(target.over)} dB after processing).`)
  } else {
    out.comp = { ...d.comp, on: true, threshold: round(clamp(m.voiceDb + m.levels.p50, -60, 0), 0.5), ratio: round(clamp(ratio, COMP_MIN_RATIO, 3), 0.05), attack: 15, release: 250, makeup: 0 }
    note('comp', `On, ${out.comp.ratio.toFixed(2)}:1 above ${f1(out.comp.threshold)} dB (this recording’s typical level): its loudest moments are ${f1(over)} dB above that, the rule’s recordings’ ${f1(target.over)} dB.`)
  }

  out.deess.on = false
  note('deess', 'Off: measured on recitation, this de-esser either does nothing or dulls everything above 4 kHz; sharpness is handled by the EQ.')
  out.echo.on = false
  note('echo', 'Off: nothing in the rule’s recordings is a repeating echo.')
  // reverb: only for a recording that is truly dry, which the rule’s recordings are not
  if (snr >= DRY_PAUSES) {
    out.reverb = { on: true, decay: 1.6, predelay: 25, brightness: 5000, amount: -18 }
    note('reverb', `On, subtle: the pauses fall ${f1(snr)} dB under the voice, so this recording has almost no room in it, unlike the rule’s recordings.`)
  } else {
    out.reverb.on = false
    note('reverb', `Off: the recording already carries its room (between phrases the level only falls ${f1(snr)} dB).`)
  }
  out.limiter.on = false
  note('limiter', 'Off: levelling ends in its own true-peak limiter.')
  // loudness: the rule’s recordings' (the caller lowers it when this recording's peaks would need the limiter)
  out.level = { on: true, lufs: round(target.lufs, 0.1), ceiling: target.base?.level.on ? target.base.level.ceiling : -1 }

  // a rule of the user's own: what is taste and cannot be measured comes from the rule's settings as they are
  const base = target.base
  if (base) {
    const dVoice = m.voiceDb - (target.baseVoiceDb ?? m.voiceDb)
    out.gain = { ...base.gain }
    out.gate = { ...base.gate, threshold: round(clamp(base.gate.threshold + dVoice, -90, 0), 0.5) }
    out.deess = { ...base.deess }
    out.echo = { ...base.echo }
    out.limiter = { ...base.limiter }
    // reverb: the rule's reverb, as much of it as it takes for this recording to have the room the references have
    const steerRoom = base.reverb.on && target.floorDb !== undefined
    let reverbNote = ''
    if (!steerRoom) out.reverb = { ...base.reverb }
    else {
      const amount = base.reverb.amount + feedback.reverb
      if (m.floorDb >= target.floorDb! - ROOM_CLOSE || amount < -30) {
        out.reverb = { ...base.reverb, on: false }
        reverbNote = `Off: this recording already has as much room as the rule’s recordings have after their reverb (its quietest moments are ${f1(-m.floorDb)} dB under the voice, theirs ${f1(-target.floorDb!)} dB).`
      } else {
        out.reverb = { ...base.reverb, on: true, amount: round(clamp(amount, -30, -3), 0.5) }
        reverbNote = `On, the rule’s reverb at ${f1(out.reverb.amount)} dB: this recording is drier than the rule’s recordings are after their reverb (its quietest moments are ${f1(-m.floorDb)} dB under the voice, theirs ${f1(-target.floorDb!)} dB), so the amount is set to reach the same.${feedback.reverb ? ` Moved ${signed(feedback.reverb)} dB from the rule’s own amount after checking the result.` : ''}`
      }
    }
    const taste: ModuleKey[] = steerRoom ? ['gain', 'gate', 'deess', 'echo', 'limiter'] : ['gain', 'gate', 'deess', 'echo', 'reverb', 'limiter']
    const kept = notes.filter((n) => !taste.includes(n.module))
    notes.length = 0
    notes.push(...kept.filter((n) => !(steerRoom && n.module === 'reverb')))
    if (steerRoom) note('reverb', reverbNote)
    for (const k of taste) note(k, `${(out[k] as { on: boolean }).on ? 'On' : 'Off'}, as in the rule: this is taste, not something a measurement can decide, so it is taken from the rule’s settings${k === 'gate' && out.gate.on ? ' (threshold moved to this recording’s level)' : ''}.`)
  }
  return { modules: out, notes, held }
}

/** Sets the loudness target once the rack's own loudness and true peak are known: the rule’s recordings' loudness, or as
 *  close under it as this recording's peaks allow without the limiter working. Returns the note. */
export function setLoudness(modules: Modules, target: ReciterTarget, own: number | undefined, rack?: { lufs: number; peak: number }): string {
  const ceiling = target.base?.level.on ? target.base.level.ceiling : -1
  let lufs = round(target.lufs, 0.1), why = `the loudness of the rule’s recordings`
  if (rack && Number.isFinite(rack.lufs) && Number.isFinite(rack.peak)) {
    const most = Math.floor((rack.lufs + (ceiling - PEAK_MARGIN - rack.peak)) * 10) / 10   // loudest target at which the peaks stay under the ceiling
    if (most < lufs) { lufs = most; why = `as close to the rule’s recordings’ ${f1(target.lufs)} LUFS as this recording’s peaks allow without the limiter working` }
  }
  modules.level = { on: true, lufs, ceiling }
  return `On at ${f1(lufs)} LUFS: ${why}${own !== undefined && Number.isFinite(own) ? ` (it was recorded at ${f1(own)} LUFS, so ${Math.abs(lufs - own) < 0.05 ? 'no change' : `${signed(lufs - own)} dB`})` : ''}. True-peak ceiling ${ceiling} dBTP.`
}

/** One line of the result table. */
export interface ReportRow { what: string; before: string; after: string; target: string; ok: boolean }

/** How a result measures against the target, next to how the recording measured before. */
export function report(before: Measure, after: Measure, target: ReciterTarget, s: Steered, ringBefore?: RingMeasure | null, ringAfter?: RingMeasure | null): ReportRow[] {
  const ringOf = (r?: RingMeasure | null) => (r && r.burstMs ? ((r.excessDb[r.offsets.indexOf(100)] ?? 0) + (r.excessDb[r.offsets.indexOf(150)] ?? 0)) / 2 : null)
  const rows: ReportRow[] = []
  const toneAfter = toneDistance(after, target, s.held)
  rows.push({ what: 'Tone: distance from the target', before: `${f1(toneDistance(before, target))} dB`, after: `${f1(toneAfter)} dB`, target: 'under 1 dB', ok: toneAfter < 1.2 })
  const overAfter = after.levels.p99 - after.levels.p50
  rows.push({ what: 'Evenness: loudest moments over the typical level', before: `${f1(before.levels.p99 - before.levels.p50)} dB`, after: `${f1(overAfter)} dB`, target: `${f1(target.over)} dB`, ok: overAfter <= target.over + 0.7 })
  const sa = staticOver(after, target)
  rows.push({ what: 'Static above 5 kHz, compared with the rule’s recordings', before: `${signed(staticOver(before, target))} dB`, after: `${signed(sa)} dB`, target: `under ${signed(STATIC_MIN)} dB`, ok: sa <= STATIC_MIN + 0.5 })
  const rb = ringOf(ringBefore), ra = ringOf(ringAfter)
  if (target.base?.reverb.on && target.floorDb !== undefined) rows.push({ what: 'Room: quietest moments under the voice', before: `${f1(-before.floorDb)} dB`, after: `${f1(-after.floorDb)} dB`, target: `${f1(-target.floorDb)} dB`, ok: Math.abs(after.floorDb - target.floorDb) <= 3 })
  if (rb !== null) rows.push({ what: 'Ring after an “s”, over the room’s level', before: `${f1(rb)} dB`, after: ra === null ? '—' : `${f1(ra)} dB`, target: `${f1(target.ring)} dB`, ok: ra === null || ra <= target.ring + 1.2 })
  return rows
}

/** Corrections after checking a result: what is still off against the target is fed back into the next `steer`. Returns
 *  null when nothing is off by enough to act on. */
export function refine(prev: Feedback, s: Steered, before: Measure, after: Measure, target: ReciterTarget, ringAfter?: RingMeasure | null): Feedback | null {
  const next: Feedback = { tone: [...prev.tone], comp: prev.comp, nr: prev.nr, tamer: prev.tamer, reverb: prev.reverb }
  let changed = false
  // tone: what is left, apart from the lift held back on purpose
  const gap = toneGap(after, target).map((v, b) => v - s.held[b]!)
  if (Math.sqrt(idxFit.reduce((a, b) => a + gap[b]! ** 2, 0) / idxFit.length) > 0.6) { for (const b of idxFit) next.tone[b] = clamp(prev.tone[b]! + gap[b]!, -EQ_MAX, EQ_MAX); changed = true }
  // evenness
  const overAfter = after.levels.p99 - after.levels.p50
  const overBefore = before.levels.p99 - before.levels.p50
  if (Math.abs(overAfter - target.over) > 0.4 && (s.modules.comp.on || overAfter > target.over)) {
    const base = overBefore / Math.max(1, target.over - 0.3)
    const now = s.modules.comp.on ? s.modules.comp.ratio : 1
    const wanted = clamp(now * (overAfter / target.over), 1, 3)
    const comp = wanted / base
    if (Math.abs(comp - prev.comp) > 0.03) { next.comp = comp; changed = true }
  }
  // static: only ever asks noise reduction for more, and only where it is already justified
  const left = staticOver(after, target)
  if (left > STATIC_MIN + 0.5 && prev.nr < 6) { next.nr = Math.min(6, prev.nr + left); changed = true }
  // ring: what is left after the tamer, against what the rule’s recordings have left
  if (s.modules.spring.on && ringAfter && ringAfter.burstMs) {
    const leftRing = ((ringAfter.excessDb[ringAfter.offsets.indexOf(100)] ?? 0) + (ringAfter.excessDb[ringAfter.offsets.indexOf(150)] ?? 0)) / 2
    const off = leftRing - target.ring
    if (Math.abs(off) > 1) { next.tamer = clamp(prev.tamer - off / TAMER_SLOPE, -6, 6); changed = Math.abs(next.tamer - prev.tamer) > 0.2 || changed }
  }
  // room: more or less of the rule's reverb until the quietest moments sit where the references' do
  if (s.modules.reverb.on && target.base?.reverb.on && target.floorDb !== undefined) {
    const off = target.floorDb - after.floorDb   // + = still drier than the target
    if (Math.abs(off) > ROOM_CLOSE) { next.reverb = clamp(prev.reverb + off, -18, 18); changed = Math.abs(next.reverb - prev.reverb) > 0.4 || changed }
  }
  return changed ? next : null
}

// ── the sound being tuned by ear ──────────────────────────────────────────────

/**
 * The settings Umo approved by ear on the five best AbdullahAlMousa recordings (2026-11-14), fitted to one recording: its
 * own loudness, its own typical level for the compressor, and a spring tamer set from the ring found in it. The EQ is fixed.
 * Not what Auto-set applies: scripts/reciter-target.ts runs the best recordings through this to make the target `steer` aims at.
 */
export function approvedSettings(current: Modules, m: Measure, lufs?: number, ring?: RingMeasure | null): Suggestion {
  const d = defaultModules()
  const out: Modules = JSON.parse(JSON.stringify(current)) as Modules
  const notes: SuggestNote[] = []
  const note = (module: ModuleKey, text: string) => notes.push({ module, text })

  out.gain = { on: false, db: 0 }
  note('gain', 'Off: levelling at the end sets the level.')
  out.nr.on = false
  note('nr', 'Off: the scan found no static to remove, and these recordings have no pauses to measure noise from.')
  out.gate.on = false
  note('gate', 'Off: a gate cuts breaths and the tails of long notes.')

  const tamer = tamerFor(ring)
  out.spring = tamer.spring
  note('spring', tamer.text)

  out.eq = {
    on: true,
    hp: { on: true, freq: 80, q: 0.707 },
    ls: { ...d.eq.ls, on: false },
    bands: [{ on: true, freq: 300, gain: -2.5, q: 0.8 }, { on: true, freq: 3000, gain: 4.5, q: 0.8 }, { ...d.eq.bands[2]!, on: false }, { ...d.eq.bands[3]!, on: false }],
    hs: { on: true, freq: 6000, gain: 2, q: 0.7 },
    lp: { ...d.eq.lp, on: false },
  }
  note('eq', 'High-pass 80 Hz (rumble). −2.5 dB around 300 Hz (the boxy, muddy region). +4.5 dB around 3 kHz (where the letters are). High shelf +2 dB from 6 kHz (crispness of the consonants).')

  out.comp = { ...d.comp, on: true, threshold: round(clamp(m.voiceDb + m.levels.p50, -60, 0), 0.5), ratio: 1.5, attack: 15, release: 250, makeup: 0 }
  note('comp', `On, 1.5:1 above ${f1(out.comp.threshold)} dB (this recording’s typical level).`)
  out.deess.on = false
  note('deess', 'Off: on recitation it dulls the whole top end instead of only the “s”.')
  out.echo.on = false
  note('echo', 'Off.')
  out.reverb.on = false
  note('reverb', 'Off: the recordings already carry their room.')
  out.limiter.on = false
  note('limiter', 'Off: levelling ends in its own true-peak limiter.')
  setLevel(out, note, lufs)
  return { modules: out, notes }
}
