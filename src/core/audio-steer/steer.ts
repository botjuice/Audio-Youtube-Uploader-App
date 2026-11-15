/**
 * Auto-set's decisions: settings that bring one recording to a rule's target sound. Every module is decided from a
 * measurement of the recording against the target, and switched off where the recording already matches. What cannot be
 * measured (gain, gate, de-esser, delay, limiter) is taken from the rule's own settings.
 */
import { MEASURE_BANDS, type Measure, type RingMeasure } from '../../plugins/audio/types'
import { defaultModules, type ModuleKey, type Modules } from '../audio-modules'
import { fitEq } from './eq-fit'
import { tamerFor } from './tamer'
import type { AudioTarget, SuggestNote } from './types'
import { BOOST_MIN_CLEARANCE, EQ_MAX, FIT_HI, FIT_LO, TONE_DEADBAND, clamp, f1, hz, idxFit, median, round, signed } from './util'

/** Quiet moments must drop this far below the voice before they count as background noise rather than quiet voice, dB. */
const NOISE_MEASURABLE = 30
/** Background this far under the voice is clean enough to leave alone, dB. */
const NOISE_CLEAN = 55
/** afftdn removes the asked amount when its noise floor is set this far above the measured quiet level, dB (measured: at +0 it
 *  removes about two thirds, at +6 and above all of it, with the voice's tone unchanged). */
const NOISE_FLOOR_OVER = 6
/** Bands in which static is heard: above the voice's body, where a lift brings it up. */
const STATIC_BANDS = MEASURE_BANDS.map((f, b) => (f >= 5000 && f <= 10000 ? b : -1)).filter((b) => b >= 0)
/** Static under this (dB more than the rule’s recordings have) is left alone: the rule’s recordings are the cleanest ones, a
 *  typical recording has about 2 dB more, and that is not heard as static. */
export const STATIC_MIN = 3
/** The most clarity lift that is held back because of static, dB. */
const STATIC_HOLD_MAX = 3
/** The most static noise reduction is asked to remove, dB (more starts to sound watery on long notes). */
const NR_MAX = 9
/** A compressor gentler than this does nothing worth having: it is switched off instead. */
const COMP_MIN_RATIO = 1.15
/** A recording whose quietest moments are within this of the target's has as much room as the target, dB. */
export const ROOM_CLOSE = 1.5
/** Levelling may bring peaks this close to the ceiling before the target loudness is lowered so the limiter stays idle, dB. */
const PEAK_MARGIN = 0.8   // the peak it is given is the highest sample; between samples the signal can go a little higher

/** How this recording's tone differs from the target's, smoothed over about an octave (dB per band; + = the recording has
 *  less there). A broad difference is the recording (microphone, distance, mixer); a narrow one is the recitation itself. */
export function toneGap(m: Measure, target: AudioTarget): number[] {
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
export function steerTone(m: Measure, target: AudioTarget): number[] {
  return toneGap(m, target).map((v, b) => {
    let c = clamp(v, -EQ_MAX, EQ_MAX)
    if (Math.abs(c) < TONE_DEADBAND) c = 0
    if (c > 0 && m.tone[b]! - m.quiet[b]! < BOOST_MIN_CLEARANCE) c = 0   // no lift where there is more background than voice
    return c
  })
}

/** How far a tone is from the target's, dB RMS over the compared range (same smoothing as the steering). */
export function toneDistance(m: Measure, target: AudioTarget, held?: number[]): number {
  const g = toneGap(m, target)
  return Math.sqrt(idxFit.reduce((a, b) => a + (g[b]! - (held?.[b] ?? 0)) ** 2, 0) / idxFit.length)
}

/** Static: how much less the voice stands clear of the quiet moments in the top bands than it does in the best
 *  recordings, dB. Once the tone is matched, that is how much louder the static is than theirs. ≤ 0 = as clean or cleaner. */
export function staticOver(m: Measure, target: AudioTarget): number {
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

export interface Steered {
  modules: Modules
  notes: SuggestNote[]
  /** Clarity lift held back per band because of static, dB: the result is meant to be this far under the target there. */
  held: number[]
}

/**
 * Auto-set: settings that bring one recording to the reciter's target sound, each module decided from a measurement of
 * this recording against the target, and switched off where the recording already matches. `feedback` carries the
 * corrections from checking an earlier result (see `refine`).
 */
export function steer(current: Modules, m: Measure, target: AudioTarget, ring?: RingMeasure | null, feedback: Feedback = noFeedback()): Steered {
  const d = defaultModules()
  const out: Modules = JSON.parse(JSON.stringify(current)) as Modules
  const notes: SuggestNote[] = []
  const note = (module: ModuleKey, text: string) => notes.push({ module, text })

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

  // loudness: the rule's (the caller lowers it when this recording's peaks would need the limiter)
  out.level = { on: true, lufs: round(target.lufs, 0.1), ceiling: target.base.level.on ? target.base.level.ceiling : -1 }

  // what is taste and cannot be measured comes from the rule's settings as they are
  const base = target.base
  out.gain = { ...base.gain }
  out.gate = { ...base.gate, threshold: round(clamp(base.gate.threshold + (m.voiceDb - target.baseVoiceDb), -90, 0), 0.5) }
  out.deess = { ...base.deess }
  out.echo = { ...base.echo }
  out.limiter = { ...base.limiter }
  for (const k of ['gain', 'gate', 'deess', 'echo', 'limiter'] as const) note(k, `${out[k].on ? 'On' : 'Off'}, as in the rule: this is taste, not something a measurement can decide, so it is taken from the rule’s settings${k === 'gate' && out.gate.on ? ' (threshold moved to this recording’s level)' : ''}.`)

  // reverb: the rule's reverb, as much of it as it takes for this recording to have the room the references have
  if (!base.reverb.on) { out.reverb = { ...base.reverb }; note('reverb', 'Off, as in the rule.') }
  else if (target.floorDb === undefined) { out.reverb = { ...base.reverb }; note('reverb', 'On, as in the rule.') }
  else {
    const amount = base.reverb.amount + feedback.reverb
    if (m.floorDb >= target.floorDb - ROOM_CLOSE || amount < -30) {
      out.reverb = { ...base.reverb, on: false }
      note('reverb', `Off: this recording already has as much room as the rule’s recordings have after their reverb (its quietest moments are ${f1(-m.floorDb)} dB under the voice, theirs ${f1(-target.floorDb)} dB).`)
    } else {
      out.reverb = { ...base.reverb, on: true, amount: round(clamp(amount, -30, -3), 0.5) }
      note('reverb', `On, the rule’s reverb at ${f1(out.reverb.amount)} dB: this recording is drier than the rule’s recordings are after their reverb (its quietest moments are ${f1(-m.floorDb)} dB under the voice, theirs ${f1(-target.floorDb)} dB), so the amount is set to reach the same.${feedback.reverb ? ` Moved ${signed(feedback.reverb)} dB from the rule’s own amount after checking the result.` : ''}`)
    }
  }
  return { modules: out, notes, held }
}

/** Sets the loudness target once the rack's own loudness and peak (highest sample) are known: the rule’s recordings' loudness, or as
 *  close under it as this recording's peaks allow without the limiter working. Returns the note. */
export function setLoudness(modules: Modules, target: AudioTarget, own: number | undefined, rack?: { lufs: number; peak: number }): string {
  const ceiling = target.base.level.on ? target.base.level.ceiling : -1
  let lufs = round(target.lufs, 0.1), why = `the loudness of the rule’s recordings`
  if (rack && Number.isFinite(rack.lufs) && Number.isFinite(rack.peak)) {
    const most = Math.floor((rack.lufs + (ceiling - PEAK_MARGIN - rack.peak)) * 10) / 10   // loudest target at which the peaks stay under the ceiling
    if (most < lufs) { lufs = most; why = `as close to the rule’s recordings’ ${f1(target.lufs)} LUFS as this recording’s peaks allow without the limiter working` }
  }
  modules.level = { on: true, lufs, ceiling }
  return `On at ${f1(lufs)} LUFS: ${why}${own !== undefined && Number.isFinite(own) ? ` (it was recorded at ${f1(own)} LUFS, so ${Math.abs(lufs - own) < 0.05 ? 'no change' : `${signed(lufs - own)} dB`})` : ''}. True-peak ceiling ${ceiling} dBTP.`
}
