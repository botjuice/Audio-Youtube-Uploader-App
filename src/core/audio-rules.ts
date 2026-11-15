/**
 * Audio rules: "make every recording of this reciter sound like these ones".
 *
 * A rule holds up to five reference recordings and the settings the user dialled in on them. What the rule really
 * stores is the SOUND that results: each reference is processed with its settings and measured, and the mean of those
 * measurements is the rule's target. At upload, every recording is measured and steered to that target (see
 * audio-suggest `steer`), so a dull recording gets more lift than the references did and a clean one less.
 *
 * Only the first reference must have settings. The others follow it until the user edits one of them, which then keeps
 * its own. Following means being auto-set to SOUND like the first reference after its settings (tone, evenness, static,
 * ring, room, loudness), not copying its knobs: the host steers the follower to a target captured from the first alone.
 *
 * Rules match by reciter. A reciter without a rule gets the default rule; without a default rule of the user's own,
 * the target that ships with the app.
 *
 * Pure: no files, no ffmpeg. The host measures (src/main/audio-rules.ts).
 */
import { MEASURE_BANDS, MEASURE_VERSION, type Measure, type RingMeasure } from '../plugins/audio/types'
import { defaultModules, type Modules } from './audio-modules'
import { tamerFor, type ReciterTarget } from './audio-suggest'

export const MAX_REFERENCES = 5
export const AUDIO_RULE_FORMAT = 'yoosy-joosy.audio-rule'
export const AUDIO_RULE_VERSION = 1
/** A result further than this from the target's tone is not an edit worth uploading: the upload is held. dB. */
export const TERRIBLE_TONE_DB = 3

export interface AudioRuleRef {
  recordId: string
  /** This reference's own settings. null = it follows the first reference. The first always has its own. */
  modules: Modules | null
}

/** What a rule aims every recording at, with the settings it came from (for the modules that are taste, not measured). */
export interface RuleTarget extends ReciterTarget {
  /** The first reference's settings: delay, reverb, gate, de-esser, limiter and gain are carried over from here. */
  base: Modules
  /** Voice level and typical level of the recording `base` was dialled in on, dBFS: level-dependent settings move with them. */
  baseVoiceDb: number
  baseTypicalDb: number
  measureVersion: number
  capturedAt: string
}

export interface AudioRule {
  id: string
  /** Reciter key this rule is for; null = the default rule (every reciter without a rule of their own). */
  reciterKey: string | null
  label?: string
  refs: AudioRuleRef[]
  /** null until captured (Save), and again after the references or their settings change. */
  target: RuleTarget | null
}

export interface AudioRulesState {
  v: 1
  /** Process audio at upload. Off until the user switches it on. */
  applyToUploads: boolean
  rules: AudioRule[]
}
export const EMPTY_AUDIO_RULES: AudioRulesState = { v: 1, applyToUploads: false, rules: [] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

/** A target as stored or imported is usable with this app's measurements. */
export function targetUsable(t: unknown): t is RuleTarget {
  return isObj(t) && t['measureVersion'] === MEASURE_VERSION && Array.isArray(t['tone']) && t['tone'].length === MEASURE_BANDS.length && t['tone'].every(num)
    && Array.isArray(t['quiet']) && t['quiet'].length === MEASURE_BANDS.length && num(t['over']) && num(t['ring']) && num(t['lufs']) && num(t['hp']) && isObj(t['base'])
}

/** Tidy a stored state: one rule per reciter (the first wins), at most one default, references capped, bad targets dropped. */
export function normaliseAudioRules(raw: unknown): AudioRulesState {
  if (!isObj(raw) || !Array.isArray(raw['rules'])) return { ...EMPTY_AUDIO_RULES }
  const seen = new Set<string>()
  const rules: AudioRule[] = []
  for (const r of raw['rules']) {
    if (!isObj(r) || typeof r['id'] !== 'string') continue
    const reciterKey = typeof r['reciterKey'] === 'string' && r['reciterKey'] ? r['reciterKey'] : null
    const k = reciterKey ?? '\0default'
    if (seen.has(k)) continue
    seen.add(k)
    const refs = (Array.isArray(r['refs']) ? r['refs'] : []).filter((x): x is Record<string, unknown> => isObj(x) && typeof x['recordId'] === 'string')
      .slice(0, MAX_REFERENCES).map((x) => ({ recordId: x['recordId'] as string, modules: isObj(x['modules']) ? withDefaults(x['modules']) : null }))
    rules.push({ id: r['id'], reciterKey, ...(typeof r['label'] === 'string' && r['label'].trim() ? { label: r['label'].trim() } : {}), refs, target: targetUsable(r['target']) ? { ...r['target'], base: withDefaults(r['target'].base) } : null })
  }
  return { v: 1, applyToUploads: raw['applyToUploads'] === true, rules }
}

/** Settings from a file may predate a module: missing ones are filled with their (off) defaults. */
export function withDefaults(m: unknown): Modules {
  const d = defaultModules() as unknown as Record<string, Record<string, unknown>>
  const src = (isObj(m) ? m : {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(d)) out[k] = isObj(src[k]) ? { ...d[k], ...(src[k] as object) } : d[k]
  const eq = out['eq'] as Modules['eq'], de = d['eq'] as unknown as Modules['eq']
  eq.bands = de.bands.map((b, i) => ({ ...b, ...(Array.isArray(eq.bands) && isObj(eq.bands[i]) ? eq.bands[i] : {}) }))
  for (const k of ['hp', 'lp', 'ls', 'hs'] as const) (eq as unknown as Record<string, unknown>)[k] = { ...de[k], ...(isObj(eq[k]) ? eq[k] : {}) }
  return out as unknown as Modules
}

/** Which rule applies to a reciter: their own, else the default rule. `rule: null` = neither exists (the shipped target applies). */
export function resolveRule(state: AudioRulesState, reciterKey: string | null | undefined): { rule: AudioRule | null; via: 'reciter' | 'default' | 'built-in' } {
  const own = reciterKey ? state.rules.find((r) => r.reciterKey === reciterKey && r.target) : undefined
  if (own) return { rule: own, via: 'reciter' }
  const def = state.rules.find((r) => r.reciterKey === null && r.target)
  return def ? { rule: def, via: 'default' } : { rule: null, via: 'built-in' }
}

/**
 * The first reference's settings on another recording: the same EQ and the same character, with everything that
 * depends on level moved to this recording's level, and the spring tamer set from this recording's own ring (when the
 * first reference uses one). This is what a reference "follows the first" with, and what the taste modules of every
 * uploaded recording are taken from.
 */
export function transferSettings(base: Modules, from: { voiceDb: number; typicalDb: number }, m: Measure, ring?: RingMeasure | null): Modules {
  const out: Modules = JSON.parse(JSON.stringify(base)) as Modules
  const dVoice = m.voiceDb - from.voiceDb
  const dTypical = m.voiceDb + m.levels.p50 - from.typicalDb
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  const half = (v: number) => Math.round(v * 2) / 2
  out.comp.threshold = half(clamp(base.comp.threshold + dTypical, -60, 0))
  out.gate.threshold = half(clamp(base.gate.threshold + dVoice, -90, 0))
  out.nr.floor = Math.round(clamp(base.nr.floor + dVoice, -80, -20))
  if (base.spring.on) {
    const t = tamerFor(ring)
    // no ring found in this recording: keep the first reference's tamer, moved to this level
    out.spring = t.spring.on ? t.spring : { ...base.spring, threshold: half(clamp(base.spring.threshold + dVoice, -70, 0)) }
  }
  return out
}

/** One processed reference, as measured. */
export interface CapturedRef { after: Measure; ringLeft: number | null; lufs: number }

/** The rule's target: the mean of how its references measure after processing. */
export function meanTarget(parts: CapturedRef[], base: Modules, baseMeasure: Measure, now = new Date()): RuleTarget {
  if (!parts.length) throw new Error('A rule needs at least one reference recording.')
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
  const r1 = (x: number) => Math.round(x * 10) / 10
  const rings = parts.map((p) => p.ringLeft).filter((x): x is number => x !== null)
  return {
    count: parts.length,
    hp: base.eq.on && base.eq.hp.on ? base.eq.hp.freq : 0,
    tone: MEASURE_BANDS.map((_, b) => r1(mean(parts.map((p) => p.after.tone[b]!)))),
    quiet: MEASURE_BANDS.map((_, b) => r1(mean(parts.map((p) => p.after.quiet[b]!)))),
    over: r1(mean(parts.map((p) => p.after.levels.p99 - p.after.levels.p50))),
    ring: r1(rings.length ? mean(rings) : 0),
    lufs: r1(mean(parts.map((p) => p.lufs))),
    floorDb: r1(mean(parts.map((p) => p.after.floorDb))),
    base: JSON.parse(JSON.stringify(base)) as Modules,
    baseVoiceDb: baseMeasure.voiceDb, baseTypicalDb: r1(baseMeasure.voiceDb + baseMeasure.levels.p50),
    measureVersion: MEASURE_VERSION, capturedAt: now.toISOString(),
  }
}

// ── rule files ────────────────────────────────────────────────────────────────

/** A rule as a file: self-contained (the target travels with it), so it works on a machine without the reference recordings. */
export interface AudioRuleFile {
  format: typeof AUDIO_RULE_FORMAT
  version: number
  app: string
  appVersion: string
  exportedAt: string
  rule: { label?: string; reciterKey: string | null; default: boolean }
  /** The references by name (for the record; they are not needed to use the rule) and their settings. */
  references: { name: string; modules: Modules | null }[]
  target: RuleTarget
}

export function buildRuleFile(rule: AudioRule, names: (recordId: string) => string, meta: { appVersion: string; now?: Date }): AudioRuleFile {
  if (!rule.target) throw new Error('Save the rule first: it has no target yet.')
  return {
    format: AUDIO_RULE_FORMAT, version: AUDIO_RULE_VERSION, app: 'YouTube Quran Uploader', appVersion: meta.appVersion, exportedAt: (meta.now ?? new Date()).toISOString(),
    rule: { ...(rule.label ? { label: rule.label } : {}), reciterKey: rule.reciterKey, default: rule.reciterKey === null },
    references: rule.refs.map((r) => ({ name: names(r.recordId), modules: r.modules })),
    target: rule.target,
  }
}

/** Parse a rule file; throws a plain-words error when it is not one or cannot be used here. */
export function parseRuleFile(text: string): { label?: string; reciterKey: string | null; target: RuleTarget; references: { name: string; modules: Modules | null }[] } {
  let j: unknown
  try { j = JSON.parse(text) } catch { throw new Error('That file is not valid JSON.') }
  if (!isObj(j) || j['format'] !== AUDIO_RULE_FORMAT) throw new Error('That file is not an audio rule exported from this app.')
  if (typeof j['version'] !== 'number' || j['version'] > AUDIO_RULE_VERSION) throw new Error(`That rule file is from a newer version of the app (file version ${String(j['version'])}). Update the app to import it.`)
  const t = j['target']
  if (isObj(t) && t['measureVersion'] !== MEASURE_VERSION) throw new Error('That rule was made with a different version of the app’s measurements and cannot be used as it is. Open its recordings and save the rule again in this version.')
  if (!targetUsable(t)) throw new Error('That rule file has no usable target in it.')
  const rule = isObj(j['rule']) ? j['rule'] : {}
  const references = (Array.isArray(j['references']) ? j['references'] : []).filter(isObj).slice(0, MAX_REFERENCES)
    .map((r) => ({ name: String(r['name'] ?? ''), modules: isObj(r['modules']) ? withDefaults(r['modules']) : null }))
  return {
    ...(typeof rule['label'] === 'string' && rule['label'].trim() ? { label: rule['label'].trim() } : {}),
    reciterKey: rule['default'] === true ? null : typeof rule['reciterKey'] === 'string' && rule['reciterKey'] ? rule['reciterKey'] : null,
    target: { ...t, base: withDefaults(t.base) }, references,
  }
}
