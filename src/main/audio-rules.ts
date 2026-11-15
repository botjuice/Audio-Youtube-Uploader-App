/**
 * Audio rules, host side: measuring a rule's reference recordings to capture its target, working out what a
 * reference that follows the first one gets, choosing the target for a recording, and rule files.
 * The rule model and the maths are in src/core/audio-rules.ts; this file does the ffmpeg work around them.
 */
import { defaultModules, toLook, type Modules } from '../core/audio-modules'
import { meanTarget, resolveRule, type AudioRule, type AudioRulesState, type CapturedRef, type RuleTarget } from '../core/audio-rules'
import { builtInTarget, type ReciterTarget } from '../core/audio-suggest'
import { measure, ring, type Measure, type RingMeasure } from '../plugins/audio/index'
import { analyseRecording, rackLevel, ringOf } from './audio'
import { autoSet, type AutoSetResult } from './audio-autoset'
import { measureOne } from './audio-profile'
import { ffmpegPath } from './ffmpeg'

/** The target that ships with the app: the default rule until the user makes their own. */
export const BUILT_IN_DEFAULT_KEY = 'abdullahalmousa'

export interface RuleFileRef { /** path relative to the library */ rel: string; path: string }

/** The target a recording of this reciter is steered to, and where it comes from. */
export function targetFor(state: AudioRulesState, reciterKey: string | null | undefined): { target: ReciterTarget; via: 'reciter' | 'default' | 'built-in'; rule: AudioRule | null } | null {
  const r = resolveRule(state, reciterKey)
  if (r.rule?.target) return { target: r.rule.target, via: r.via, rule: r.rule }
  const shipped = builtInTarget(BUILT_IN_DEFAULT_KEY)
  return shipped ? { target: shipped, via: 'built-in', rule: null } : null
}

/** The default rule's target (the user's own default, else the shipped one): what Auto-set starts a new rule from. */
export function defaultTarget(state: AudioRulesState): { target: ReciterTarget; via: 'default' | 'built-in' } | null {
  const def = state.rules.find((r) => r.reciterKey === null && r.target)
  if (def?.target) return { target: def.target, via: 'default' }
  const shipped = builtInTarget(BUILT_IN_DEFAULT_KEY)
  return shipped ? { target: shipped, via: 'built-in' } : null
}

const ringLeft = (r: RingMeasure | null) => (r && r.burstMs ? ((r.excessDb[r.offsets.indexOf(100)] ?? 0) + (r.excessDb[r.offsets.indexOf(150)] ?? 0)) / 2 : null)

async function inputs(library: string, f: RuleFileRef): Promise<{ m: Measure; ring: RingMeasure | null; lufs: number }> {
  const [m, a] = await Promise.all([measureOne(library, f), analyseRecording(f.path)])
  return { m, ring: await ringOf(f.path, a.durationSec), lufs: a.lufs }
}

const singles = new Map<string, Promise<RuleTarget>>()
const follows = new Map<string, Promise<AutoSetResult>>()

/** The first reference on its own as a target: how it sounds after its settings. */
function firstAlone(library: string, base: Modules, baseFile: RuleFileRef): Promise<RuleTarget> {
  const key = JSON.stringify([library, baseFile.rel, base])
  let p = singles.get(key)
  if (!p) {
    if (singles.size > 40) singles.clear()
    p = captureRule(library, { id: 'first', reciterKey: null, refs: [{ recordId: baseFile.rel, modules: base }], target: null }, (id) => (id === baseFile.rel ? baseFile : null))
    singles.set(key, p)
    p.catch(() => singles.delete(key))
  }
  return p
}

/**
 * What a reference that follows the first one gets: it is auto-set to SOUND like the first reference after its
 * settings (the same loop an upload goes through, aimed at the first reference alone), not given a copy of its knobs.
 * Kept per (first reference's settings, recording) for the session: it takes 10 to 30 seconds.
 */
export function followerSettings(library: string, base: Modules, baseFile: RuleFileRef, file: RuleFileRef, onStage?: (text: string) => void): Promise<AutoSetResult> {
  const key = JSON.stringify([library, baseFile.rel, file.rel, base])
  let p = follows.get(key)
  if (!p) {
    if (follows.size > 80) follows.clear()
    p = (async () => {
      const bin = ffmpegPath()
      if (!bin) throw new Error('ffmpeg is not available on this computer')
      onStage?.('Measuring how reference 1 sounds after its settings…')
      const target = await firstAlone(library, base, baseFile)
      const [x, analysis] = await Promise.all([inputs(library, file), analyseRecording(file.path)])
      return autoSet(bin, file.path, defaultModules(), { measure: x.m, ring: x.ring, analysis, target }, onStage, undefined, { rackLevel: (look) => rackLevel(file.path, look) })
    })()
    follows.set(key, p)
    p.catch(() => follows.delete(key))
  }
  return p
}

/**
 * Capture a rule's target: every reference is run through its settings (its own, or what following the first one
 * gives it) and measured; the target is the mean. `fileOf` gives a reference's file, or null when the recording is gone.
 */
export async function captureRule(library: string, rule: AudioRule, fileOf: (recordId: string) => RuleFileRef | null, onStage?: (text: string) => void): Promise<RuleTarget> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg is not available on this computer')
  const first = rule.refs[0]
  if (!first) throw new Error('Add at least one reference recording to the rule.')
  if (!first.modules) throw new Error('The first reference recording has no settings yet.')
  const firstFile = fileOf(first.recordId)
  if (!firstFile) throw new Error('The first reference recording is no longer in the library.')
  const baseM = await measureOne(library, firstFile)
  const host = { ffmpegPath: bin }
  const parts: CapturedRef[] = []
  for (const [i, ref] of rule.refs.entries()) {
    const file = fileOf(ref.recordId)
    if (!file) throw new Error(`Reference ${i + 1} (${ref.recordId}) is no longer in the library. Remove it from the rule or put the file back.`)
    onStage?.(`Measuring reference ${i + 1} of ${rule.refs.length}…`)
    const x = await inputs(library, file)
    const modules = ref.modules ?? (await followerSettings(library, first.modules, firstFile, file, (t) => onStage?.(`Reference ${i + 1} of ${rule.refs.length}: ${t.charAt(0).toLowerCase()}${t.slice(1)}`))).modules
    const look = toLook(modules)
    const split = x.ring?.splitHz ?? 4500
    const [after, ringAfter, rack] = await Promise.all([measure(file.path, host, look), ring(file.path, host, split, look), rackLevel(file.path, look)])
    if (!after) throw new Error(`Reference ${i + 1} is silent after its settings: they remove the signal.`)
    parts.push({ after, ringLeft: ringLeft(ringAfter), lufs: modules.level.on ? modules.level.lufs : rack.lufs })
  }
  return meanTarget(parts, first.modules, baseM)
}
