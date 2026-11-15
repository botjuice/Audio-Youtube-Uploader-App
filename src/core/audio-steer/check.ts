/** Checking a result: how it measures against the target (the table shown to the user), and what to correct next. */
import type { Measure, RingMeasure } from '../../plugins/audio/types'
import { ROOM_CLOSE, STATIC_MIN, staticOver, toneDistance, toneGap, type Feedback, type Steered } from './steer'
import { TAMER_SLOPE, ringLeftover } from './tamer'
import type { AudioTarget } from './types'
import { EQ_MAX, clamp, f1, idxFit, signed } from './util'

/** One line of the result table. */
export interface ReportRow { what: string; before: string; after: string; target: string; ok: boolean }

/** How a result measures against the target, next to how the recording measured before. */
export function report(before: Measure, after: Measure, target: AudioTarget, s: Steered, ringBefore?: RingMeasure | null, ringAfter?: RingMeasure | null): ReportRow[] {
  const rows: ReportRow[] = []
  const toneAfter = toneDistance(after, target, s.held)
  rows.push({ what: 'Tone: distance from the target', before: `${f1(toneDistance(before, target))} dB`, after: `${f1(toneAfter)} dB`, target: 'under 1 dB', ok: toneAfter < 1.2 })
  const overAfter = after.levels.p99 - after.levels.p50
  rows.push({ what: 'Evenness: loudest moments over the typical level', before: `${f1(before.levels.p99 - before.levels.p50)} dB`, after: `${f1(overAfter)} dB`, target: `${f1(target.over)} dB`, ok: overAfter <= target.over + 0.7 })
  const sa = staticOver(after, target)
  rows.push({ what: 'Static above 5 kHz, compared with the rule’s recordings', before: `${signed(staticOver(before, target))} dB`, after: `${signed(sa)} dB`, target: `under ${signed(STATIC_MIN)} dB`, ok: sa <= STATIC_MIN + 0.5 })
  const rb = ringLeftover(ringBefore), ra = ringLeftover(ringAfter)
  if (target.base.reverb.on && target.floorDb !== undefined) rows.push({ what: 'Room: quietest moments under the voice', before: `${f1(-before.floorDb)} dB`, after: `${f1(-after.floorDb)} dB`, target: `${f1(-target.floorDb)} dB`, ok: Math.abs(after.floorDb - target.floorDb) <= 3 })
  if (rb !== null) rows.push({ what: 'Ring after an “s”, over the room’s level', before: `${f1(rb)} dB`, after: ra === null ? '—' : `${f1(ra)} dB`, target: `${f1(target.ring)} dB`, ok: ra === null || ra <= target.ring + 1.2 })
  return rows
}

/** Corrections after checking a result: what is still off against the target is fed back into the next `steer`. Returns
 *  null when nothing is off by enough to act on. */
export function refine(prev: Feedback, s: Steered, before: Measure, after: Measure, target: AudioTarget, ringAfter?: RingMeasure | null): Feedback | null {
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
  const leftRing = ringLeftover(ringAfter)
  if (s.modules.spring.on && leftRing !== null) {
    const off = leftRing - target.ring
    if (Math.abs(off) > 1) { next.tamer = clamp(prev.tamer - off / TAMER_SLOPE, -6, 6); changed = Math.abs(next.tamer - prev.tamer) > 0.2 || changed }
  }
  // room: more or less of the rule's reverb until the quietest moments sit where the references' do
  if (s.modules.reverb.on && target.base.reverb.on && target.floorDb !== undefined) {
    const off = target.floorDb - after.floorDb   // + = still drier than the target
    if (Math.abs(off) > ROOM_CLOSE) { next.reverb = clamp(prev.reverb + off, -18, 18); changed = Math.abs(next.reverb - prev.reverb) > 0.4 || changed }
  }
  return changed ? next : null
}
