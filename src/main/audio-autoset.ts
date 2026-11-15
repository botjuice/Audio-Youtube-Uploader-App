/**
 * Auto-set's loop: choose settings from the measurements, run the recording through them, measure what came out, feed
 * what is still off against the target back in, and repeat (at most twice). That is how the modules are weighed
 * together: an EQ lift raises static, compression shifts the tone, and only the measured result shows the sum.
 *
 * No Electron in here (the ffmpeg path comes in), so the same loop can be run over a library from a script.
 */
import { toLook, type Modules } from '../core/audio-modules'
import { noFeedback, refine, report, ringLeftover, setLoudness, steer, toneDistance, staticOver, type AudioTarget, type Feedback, type ReportRow, type Steered, type SuggestNote } from '../core/audio-steer'
import { levellingGain, measure, ring, type AudioAnalysis, type Measure, type RingMeasure } from '../plugins/audio/index'

export interface AutoSetInput { measure: Measure; ring: RingMeasure | null; analysis: AudioAnalysis; target: AudioTarget }
export interface AutoSetResult {
  modules: Modules
  notes: SuggestNote[]
  /** The result against the target, measured on the processed recording. */
  report: ReportRow[]
  /** Things found that no module here deals with. */
  findings: string[]
  /** How many times the result was processed and measured. */
  checks: number
  /** How far the result's tone is from the target's, dB (the upload stage holds a recording on a really bad one). */
  toneAfter: number
}

const MAX_CORRECTIONS = 2
/** Recordings longer than this are checked on a stretch from their middle: the settings' effect is measured there and
 *  added to what the whole recording measured, which is several times faster and tells the same. */
const CHECK_WHOLE_UP_TO_S = 480
const CHECK_SPAN_S = 360

/** What the whole recording would measure after processing: its own measurement moved by the change seen on the stretch. */
function moved(whole: Measure, before: Measure, after: Measure): Measure {
  const d = (a: number, b: number) => a - b
  return {
    ...whole,
    voiceDb: whole.voiceDb + d(after.voiceDb, before.voiceDb),
    tone: whole.tone.map((v, b) => v + d(after.tone[b]!, before.tone[b]!)),
    quiet: whole.quiet.map((v, b) => v + d(after.quiet[b]!, before.quiet[b]!)),
    floorDb: whole.floorDb + d(after.floorDb, before.floorDb),
    peakDb: whole.peakDb + d(after.peakDb, before.peakDb),
    sibilance: whole.sibilance + d(after.sibilance, before.sibilance),
    levels: { p10: whole.levels.p10 + d(after.levels.p10, before.levels.p10), p50: whole.levels.p50 + d(after.levels.p50, before.levels.p50), p90: whole.levels.p90 + d(after.levels.p90, before.levels.p90), p95: whole.levels.p95 + d(after.levels.p95, before.levels.p95), p99: whole.levels.p99 + d(after.levels.p99, before.levels.p99) },
  }
}

/** How far a measured result is from the target, all things in one number (dB-ish): used only to keep the best attempt. */
function badness(s: Steered, after: Measure, ringAfter: RingMeasure | null, target: AudioTarget): number {
  const over = after.levels.p99 - after.levels.p50, left = ringLeftover(ringAfter)
  return toneDistance(after, target, s.held) + 0.5 * Math.abs(over - target.over) + 0.5 * Math.max(0, staticOver(after, target)) + 0.5 * Math.max(0, (left ?? target.ring) - target.ring)
}

export interface AutoSetDeps {
  /** The rack's own loudness and peak (highest sample) over the whole recording (the host can share this pass with its preview). */
  rackLevel?: (look: ReturnType<typeof toLook>) => Promise<{ lufs: number; peak: number } | null>
}

export async function autoSet(bin: string, audioPath: string, current: Modules, input: AutoSetInput, onStage?: (text: string) => void, signal?: AbortSignal, deps: AutoSetDeps = {}): Promise<AutoSetResult> {
  const { measure: m, target } = input
  const host = { ffmpegPath: bin, ...(signal ? { signal } : {}) }
  const span = m.durationSec > CHECK_WHOLE_UP_TO_S ? { start: Math.floor((m.durationSec - CHECK_SPAN_S) / 2), seconds: CHECK_SPAN_S } : undefined
  const spanBefore = span ? await measure(audioPath, host, undefined, span) : null
  let fb: Feedback = noFeedback()
  let s = steer(current, m, target, input.ring, fb)
  let best: { s: Steered; after: Measure; ringAfter: RingMeasure | null; bad: number } | null = null
  let checks = 0
  for (let pass = 0; pass <= MAX_CORRECTIONS; pass++) {
    onStage?.(pass === 0 ? 'Checking the result…' : `Correcting and checking again (${pass}/${MAX_CORRECTIONS})…`)
    const look = toLook({ ...s.modules, level: { ...s.modules.level, on: false } })   // one gain at the end changes nothing that is measured
    const [got, ringAfter] = await Promise.all([measure(audioPath, host, look, span), ring(audioPath, host, input.ring?.splitHz ?? 4500, look, span)])
    checks++
    if (!got) break
    const after = span && spanBefore ? moved(m, spanBefore, got) : got
    const bad = badness(s, after, ringAfter, target)
    if (!best || bad < best.bad) best = { s, after, ringAfter, bad }
    if (pass === MAX_CORRECTIONS) break
    const next = refine(fb, s, m, after, target, ringAfter)
    if (!next) break
    fb = next
    s = steer(current, m, target, input.ring, fb)
  }
  const final = best?.s ?? s
  const modules = final.modules
  const notes = [...final.notes]

  // loudness last: the rack is settled, so its own loudness and peak say whether the target needs the limiter
  onStage?.('Setting the loudness…')
  const rackLevel = deps.rackLevel ?? (async (look) => { const g = await levellingGain(audioPath, look, host); return g.ok && g.rackLufs !== undefined && g.rackPeak !== undefined ? { lufs: g.rackLufs, peak: g.rackPeak } : null })
  const rack = await rackLevel(toLook(modules)).catch(() => null)
  const own = input.analysis.lufs
  notes.push({ module: 'level', text: setLoudness(modules, target, own, rack ?? undefined) })

  const rows = best ? report(m, best.after, target, final, input.ring, best.ringAfter) : []
  rows.push({ what: 'Loudness', before: Number.isFinite(own) ? `${own.toFixed(1)} LUFS` : '—', after: `${modules.level.lufs.toFixed(1)} LUFS`, target: `${target.lufs.toFixed(1)} LUFS`, ok: Math.abs(modules.level.lufs - target.lufs) <= 1 })   // a little short because of peaks is not a miss
  const findings: string[] = []
  if (input.analysis.clipped) findings.push(`Clipped in places (${input.analysis.hotSamplesPct.toFixed(2)} % of samples at full scale). No module here repairs clipping.`)
  if (best && toneDistance(best.after, target, final.held) > 1.5) findings.push('The tone could not be brought closer than this with the EQ’s limits (9 dB per band, four bells and two shelves).')
  return { modules, notes, report: rows, findings, checks, toneAfter: best ? toneDistance(best.after, target, final.held) : toneDistance(m, target) }
}
