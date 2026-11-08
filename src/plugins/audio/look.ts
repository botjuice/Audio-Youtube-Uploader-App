/**
 * The audio look: an ordered rack of ffmpeg filters, each with any of its options — nothing the
 * plugin decides for you. Every filter and option ffmpeg has is allowed, with ffmpeg's own limits
 * (see catalog.ts). The one plugin-owned stage is optional levelling (`level`), applied after the rack.
 *
 * Node-free: the editor UI imports this file to validate and describe looks as the user edits.
 *
 *   { chain: [
 *       { filter: 'highpass', options: { f: 75, poles: 2 } },
 *       { filter: 'afftdn', options: { nr: 12, tn: true } },
 *       { filter: 'acrossover', options: { split: '4500' },            // a split: one sub-chain per band …
 *         outputs: [[], [{ filter: 'acompressor', options: { ratio: 4 } }]],
 *         merge: { filter: 'amix', options: { inputs: 2, normalize: false } } },   // … joined back by a merge
 *       { filter: 'sidechaincompress',                                  // a filter with an extra input
 *         inputs: [{ kind: 'signal', chain: [{ filter: 'adelay', options: { delays: '120', all: true } }] }] },
 *     ],
 *     level: { lufs: -14, ceiling: -1.5 } }
 */
import { CATALOG, FILTER_NEEDS, filterInfo, padCount, type CatalogFilter, type CatalogOption } from './catalog'

export type OptionValue = string | number | boolean

export interface Step {
  /** the UI's stable key for this step (any string; ignored by processing and the cache) */
  id?: string
  /** the user's name for the step (ignored by processing and the cache) */
  label?: string
  /** any filter in the catalog whose role fits where the step is used */
  filter: string
  /** only the options you set; the rest stay at ffmpeg's defaults. Names or ffmpeg aliases. */
  options?: Record<string, OptionValue>
  /** true = the step is skipped, as if it were not there (the UI's on/off switch) */
  bypass?: boolean
  /** ffmpeg timeline expression: the filter only acts while it is non-zero, e.g. "between(t,10,20)" */
  enable?: string
  /** extra inputs, for filters that take more than the running signal (sidechain key, impulse response, …) */
  inputs?: Source[]
  /** for split filters: one sub-chain per output, in output order */
  outputs?: Step[][]
  /** for split filters with more than one output: the filter that joins the branches back into one */
  merge?: Step
}

export type Source =
  /** a copy of the running signal at this point, through its own chain */
  | { kind: 'signal'; chain?: Step[] }
  /** another audio file (an impulse response WAV, a backing track …), through its own chain */
  | { kind: 'file'; path: string; chain?: Step[] }
  /** audio made by a source filter (sine, anoisesrc, aevalsrc …), through its own chain */
  | { kind: 'generate'; filter: string; options?: Record<string, OptionValue>; chain?: Step[] }

/** Plugin-owned levelling after the rack: measure, apply one fixed gain, true-peak limit. */
export interface Level { lufs: number; ceiling: number }

export interface Look { chain: Step[]; level?: Level | null }

export interface LookError { path: string; message: string }
export type LookValidation = { ok: true; look: Look } | { ok: false; errors: LookError[] }

export const EMPTY_LOOK: Look = { chain: [] }

export interface NumberField { kind: 'number'; min: number; max: number; default: number; step: number; unit: string; label: string; desc: string }
/** The knobs of the levelling stage (plugin-owned, so they have units and bounds of our choosing). */
export const LEVEL_FIELDS: Record<keyof Level, NumberField> = {
  lufs: { kind: 'number', min: -70, max: 0, default: -14, step: 0.1, unit: 'LUFS', label: 'Target loudness', desc: 'Integrated loudness after the rack. YouTube plays at −14.' },
  ceiling: { kind: 'number', min: -20, max: 0, default: -1.5, step: 0.1, unit: 'dBTP', label: 'Peak ceiling', desc: 'True-peak limit applied after the gain (4× oversampled).' },
}

/** steps in a look, nesting depth, characters in a text option, extra inputs / outputs per step */
export const LIMITS = { steps: 500, depth: 8, text: 10_000, branches: 64 }

const DURATION = /^-?(\d+:)?(\d+:)?\d+(\.\d+)?(s|ms|us)?$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

/** Checks one option value against ffmpeg's type and limits; returns it in the form the graph builder writes. */
export function coerceOption(o: CatalogOption, v: unknown): { ok: true; value: OptionValue } | { ok: false; message: string } {
  const range = o.min !== undefined && o.max !== undefined ? ` (ffmpeg allows ${o.min} to ${o.max})` : ''
  const choiceNames = (o.constants ?? []).flatMap((c) => [c.name, ...(c.aliases ?? [])])
  const asNumber = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN
  switch (o.type) {
    case 'boolean':
      if (v === true || v === 'true' || v === 1 || v === '1') return { ok: true, value: true }
      if (v === false || v === 'false' || v === 0 || v === '0') return { ok: true, value: false }
      return { ok: false, message: 'must be true or false' }
    case 'int': case 'double': case 'float': {
      if (typeof v === 'string' && choiceNames.includes(v)) return { ok: true, value: v }
      if (!Number.isFinite(asNumber)) return { ok: false, message: o.constants?.length ? `must be a number or one of ${choiceNames.join(', ')}` : 'must be a number' }
      if (o.type === 'int' && !Number.isInteger(asNumber)) return { ok: false, message: 'must be a whole number' }
      if (o.min !== undefined && asNumber < o.min) return { ok: false, message: `is below the minimum${range}` }
      if (o.max !== undefined && asNumber > o.max) return { ok: false, message: `is above the maximum${range}` }
      return { ok: true, value: asNumber }
    }
    case 'duration':
      if (typeof v === 'number') return Number.isFinite(v) && (o.min === undefined || v >= o.min) ? { ok: true, value: v } : { ok: false, message: `must be seconds${range}` }
      return typeof v === 'string' && DURATION.test(v.trim()) ? { ok: true, value: v.trim() } : { ok: false, message: 'must be seconds, "MM:SS.ms", or a number with ms / us' }
    case 'flags': {
      if (typeof v === 'number' && Number.isInteger(v)) return { ok: true, value: v }
      if (typeof v !== 'string') return { ok: false, message: 'must be flag names joined with +' }
      const bad = v.split(/[+-]/).filter(Boolean).filter((t) => !choiceNames.includes(t) && !/^\d+$/.test(t))
      return bad.length ? { ok: false, message: `has unknown flag ${bad.join(', ')} (known: ${choiceNames.join(', ')})` } : { ok: true, value: v }
    }
    default: {   // string, channel_layout, sample_fmt, rational: ffmpeg is the judge (checkLook runs it)
      const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : v
      if (typeof s !== 'string') return { ok: false, message: 'must be text' }
      if (s.length > LIMITS.text) return { ok: false, message: `is longer than ${LIMITS.text} characters` }
      if (CONTROL.test(s)) return { ok: false, message: 'contains control characters' }
      return { ok: true, value: s }
    }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const STEP_KEYS = new Set(['id', 'label', 'filter', 'options', 'bypass', 'enable', 'inputs', 'outputs', 'merge'])
const SOURCE_KEYS = new Set(['kind', 'path', 'filter', 'options', 'chain'])
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/**
 * Checks a look against the catalog and returns it normalised (option aliases → ffmpeg's main name,
 * numbers as numbers, booleans as booleans). Every problem is reported with its path, e.g.
 * "chain[2].options.f". Free-text options (expressions, lists, curves) can only be judged by ffmpeg:
 * `checkLook` runs it.
 */
export function validateLook(input: unknown): LookValidation {
  const errors: LookError[] = []
  let count = 0
  const err = (path: string, message: string) => { errors.push({ path, message }) }

  const options = (f: CatalogFilter, raw: unknown, path: string): Record<string, OptionValue> | undefined => {
    if (raw === undefined) return undefined
    if (!isObj(raw)) { err(path, 'must be an object of option: value'); return undefined }
    const out: Record<string, OptionValue> = {}
    for (const [k, v] of Object.entries(raw)) {
      const o = f.options.find((x) => x.name === k || x.aliases.includes(k))
      if (!o) { err(`${path}.${k}`, `${f.name} has no option "${k}"`); continue }
      if (o.name in out) { err(`${path}.${k}`, `"${k}" sets ${o.name} a second time`); continue }
      const c = coerceOption(o, v)
      if (c.ok) out[o.name] = c.value
      else err(`${path}.${k}`, `${o.name} ${c.message}`)
    }
    return out
  }

  const chain = (raw: unknown, path: string, depth: number): Step[] => {
    if (raw === undefined) return []
    if (!Array.isArray(raw)) { err(path, 'must be a list of steps'); return [] }
    return raw.map((s, i) => step(s, `${path}[${i}]`, depth, 'chain'))
  }

  const source = (raw: unknown, path: string, depth: number): Source => {
    if (!isObj(raw)) { err(path, 'must be a source object'); return { kind: 'signal' } }
    for (const k of Object.keys(raw)) if (!SOURCE_KEYS.has(k)) err(`${path}.${k}`, `unknown source field "${k}"`)
    const sub = chain(raw.chain, `${path}.chain`, depth + 1)
    const withChain = sub.length ? { chain: sub } : {}
    if (raw.kind === 'signal') return { kind: 'signal', ...withChain }
    if (raw.kind === 'file') {
      if (typeof raw.path !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(raw.path)) err(`${path}.path`, 'must be an absolute file path')
      return { kind: 'file', path: String(raw.path), ...withChain }
    }
    if (raw.kind === 'generate') {
      const f = typeof raw.filter === 'string' ? filterInfo(raw.filter) : undefined
      if (!f) { err(`${path}.filter`, `unknown source filter "${String(raw.filter)}"`); return { kind: 'generate', filter: String(raw.filter) } }
      if (f.role !== 'source') err(`${path}.filter`, `${f.name} is not a source (sources: ${Object.values(CATALOG.filters).filter((x) => x.role === 'source').map((x) => x.name).join(', ')})`)
      const o = options(f, raw.options, `${path}.options`)
      return { kind: 'generate', filter: f.name, ...(o && Object.keys(o).length ? { options: o } : {}), ...withChain }
    }
    err(`${path}.kind`, 'must be "signal", "file" or "generate"')
    return { kind: 'signal' }
  }

  const step = (raw: unknown, path: string, depth: number, as: 'chain' | 'merge'): Step => {
    count++
    if (count === LIMITS.steps + 1) err(path, `a look may have at most ${LIMITS.steps} steps`)
    if (depth > LIMITS.depth) { err(path, `nested deeper than ${LIMITS.depth} levels`); return { filter: 'anull' } }
    if (!isObj(raw)) { err(path, 'must be a step object'); return { filter: 'anull' } }
    for (const k of Object.keys(raw)) if (!STEP_KEYS.has(k)) err(`${path}.${k}`, `unknown step field "${k}"`)
    const f = typeof raw.filter === 'string' ? filterInfo(raw.filter) : undefined
    if (!f) { err(`${path}.filter`, `unknown filter "${String(raw.filter)}"`); return { filter: String(raw.filter) } }
    const out: Step = { filter: f.name }
    if (typeof raw.id === 'string') out.id = raw.id
    if (typeof raw.label === 'string') out.label = raw.label
    if (raw.bypass !== undefined) { if (typeof raw.bypass !== 'boolean') err(`${path}.bypass`, 'must be true or false'); else if (raw.bypass) out.bypass = true }
    const o = options(f, raw.options, `${path}.options`)
    if (o && Object.keys(o).length) out.options = o
    if (raw.enable !== undefined) {
      if (!f.timeline) err(`${path}.enable`, `${f.name} has no timeline support (enable)`)
      else if (typeof raw.enable !== 'string' || !raw.enable.trim() || CONTROL.test(raw.enable) || raw.enable.length > LIMITS.text) err(`${path}.enable`, 'must be an ffmpeg expression')
      else out.enable = raw.enable.trim()
    }
    if (f.role === 'source') { err(`${path}.filter`, `${f.name} makes audio from nothing — use it as a { kind: 'generate' } input instead`); return out }

    if (raw.inputs !== undefined) {
      if (as === 'merge') err(`${path}.inputs`, 'a merge takes its inputs from the branches')
      else if (!Array.isArray(raw.inputs)) err(`${path}.inputs`, 'must be a list of sources')
      else if (raw.inputs.length > LIMITS.branches) err(`${path}.inputs`, `at most ${LIMITS.branches} extra inputs per step`)
      else if (raw.inputs.length) out.inputs = raw.inputs.map((s, i) => source(s, `${path}.inputs[${i}]`, depth + 1))
    }
    if (raw.outputs !== undefined) {
      if (as === 'merge') err(`${path}.outputs`, 'a merge has one output')
      else if (!Array.isArray(raw.outputs) || !raw.outputs.length) err(`${path}.outputs`, 'must be a list of sub-chains (one per output)')
      else if (raw.outputs.length > LIMITS.branches) err(`${path}.outputs`, `at most ${LIMITS.branches} outputs per step`)
      else out.outputs = raw.outputs.map((c, i) => chain(c, `${path}.outputs[${i}]`, depth + 1))
    }
    if (raw.merge !== undefined) {
      if (as === 'merge') err(`${path}.merge`, 'a merge cannot have its own merge')
      else out.merge = step(raw.merge, `${path}.merge`, depth + 1, 'merge')
    }

    const set = out.options ?? {}
    for (const group of FILTER_NEEDS[f.name]?.oneOf ?? []) {
      if (!group.some((k) => k in set)) err(`${path}.options.${group[0]}`, `${f.name} ${FILTER_NEEDS[f.name]!.why}`)
    }
    // ffmpeg 6.0 crashes when afir selects an impulse response it wasn't given (found by the sweep)
    if (f.name === 'afir' && Number(set.ir ?? 0) > Number(set.nbirs ?? 1) - 1) err(`${path}.options.ir`, `ir must be below nbirs (${Number(set.nbirs ?? 1)})`)

    if (as === 'chain') {
      const opts = out.options ?? {}
      const nIn = padCount(f.name, opts, 'in'), nOut = padCount(f.name, opts, 'out')
      const extra = out.inputs?.length ?? 0
      if (nIn !== null && nIn - 1 > LIMITS.branches) err(`${path}.options`, `${f.name} would need ${nIn - 1} extra inputs; the plugin allows ${LIMITS.branches}`)
      else if (nIn !== null && extra !== nIn - 1) err(`${path}.inputs`, nIn === 1 ? `${f.name} takes no extra inputs` : `${f.name} needs ${plural(nIn - 1, 'extra input')} with these options, the step has ${extra}`)
      if (nIn === null && f.inputs === 'dynamic' && !extra) err(`${path}.inputs`, `${f.name} needs extra inputs`)
      const branches = out.outputs?.length ?? 1
      if (nOut !== null && nOut > LIMITS.branches) err(`${path}.options`, `${f.name} would have ${nOut} outputs; the plugin allows ${LIMITS.branches}`)
      else if (nOut !== null && branches !== nOut) err(`${path}.outputs`, `${f.name} has ${plural(nOut, 'output')} with these options, the step lists ${branches}`)
      if (nOut === null && f.outputs === 'dynamic' && !out.outputs) err(`${path}.outputs`, `${f.name} has several outputs: list one sub-chain per output`)
      if (branches > 1 && !out.merge) err(`${path}.merge`, `${branches} branches need a merge filter (amix, amerge, join …) to become one signal again`)
      if (branches === 1 && out.merge) err(`${path}.merge`, 'only a step with several outputs needs a merge')
      if (out.merge && branches > 1) {
        const mf = filterInfo(out.merge.filter)
        if (mf && mf.role !== 'multi-input') err(`${path}.merge.filter`, `${mf.name} cannot join branches (use amix, amerge, join, ainterleave …)`)
        const want = padCount(out.merge.filter, out.merge.options ?? {}, 'in')
        if (mf && want !== null && want !== branches) err(`${path}.merge`, `${mf.name} takes ${plural(want, 'input')} with these options, but there are ${branches} branches${mf.options.some((x) => x.name === 'inputs') ? ` (set inputs: ${branches})` : ''}`)
      }
    }
    return out
  }

  if (!isObj(input)) return { ok: false, errors: [{ path: '', message: 'a look must be an object { chain, level? }' }] }
  for (const k of Object.keys(input)) if (k !== 'chain' && k !== 'level') err(k, `unknown look field "${k}"`)
  const look: Look = { chain: chain(input.chain ?? [], 'chain', 0) }

  if (input.level !== undefined && input.level !== null) {
    if (!isObj(input.level)) err('level', 'must be { lufs, ceiling } or null')
    else {
      const lv: Partial<Level> = {}
      for (const k of Object.keys(input.level)) if (k !== 'lufs' && k !== 'ceiling') err(`level.${k}`, `unknown level field "${k}"`)
      for (const k of ['lufs', 'ceiling'] as const) {
        const fld = LEVEL_FIELDS[k], v = input.level[k] ?? fld.default
        if (typeof v !== 'number' || !Number.isFinite(v) || v < fld.min || v > fld.max) err(`level.${k}`, `must be a number from ${fld.min} to ${fld.max} ${fld.unit}`)
        else lv[k] = Math.round(v * 100) / 100
      }
      if (lv.lufs !== undefined && lv.ceiling !== undefined) look.level = lv as Level
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, look }
}

/** Visits every step (main chain, source chains, branches, merges) with its path. */
export function walkSteps(look: Look, visit: (s: Step, path: string) => void): void {
  const chain = (steps: Step[], path: string) => steps.forEach((s, i) => {
    const p = `${path}[${i}]`
    visit(s, p)
    s.inputs?.forEach((src, j) => src.chain && chain(src.chain, `${p}.inputs[${j}].chain`))
    s.outputs?.forEach((c, j) => chain(c, `${p}.outputs[${j}]`))
    if (s.merge) visit(s.merge, `${p}.merge`)
  })
  chain(look.chain, 'chain')
}

const fmtOpts = (o?: Record<string, OptionValue>) => (o && Object.keys(o).length ? ` ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}` : '')
/** One line for logs and the Activity page, e.g. "highpass f=75 → afftdn nr=12 · level −14 LUFS, ceiling −1.5 dBTP". */
export function describeLook(look: Look): string {
  const chain = (steps: Step[]): string => steps.filter((s) => !s.bypass).map((s) => {
    let t = `${s.filter}${fmtOpts(s.options)}`
    if (s.inputs?.length) t += ` [+ ${s.inputs.map((x) => (x.kind === 'file' ? `file ${x.path.split(/[\\/]/).pop()}` : x.kind === 'generate' ? x.filter : 'signal') + (x.chain?.length ? ` → ${chain(x.chain)}` : '')).join(', ')}]`
    if (s.outputs && s.outputs.length > 1) t += ` (${s.outputs.map((c) => chain(c) || 'unchanged').join(' | ')})${s.merge ? ` → ${s.merge.filter}${fmtOpts(s.merge.options)}` : ''}`
    else if (s.outputs?.[0]?.length) t += ` → ${chain(s.outputs[0])}`
    return t
  }).join(' → ')
  const parts = [chain(look.chain) || 'no effects']
  if (look.level) parts.push(`level ${look.level.lufs} LUFS, ceiling ${look.level.ceiling} dBTP`)
  return parts.join(' · ')
}
