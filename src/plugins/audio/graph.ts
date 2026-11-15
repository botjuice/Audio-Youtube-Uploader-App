/**
 * Look → one ffmpeg -filter_complex graph. Pure: no ffmpeg, no files.
 *
 * Every option value is escaped twice, because ffmpeg parses it twice: once when it splits the graph
 * into filters (`, ; [ ]` separate) and once when it splits a filter's arguments (`:` separates).
 * Quotes and backslashes are escaped at both levels.
 *
 * `filterPaths` lists, in graph order, which look step each ffmpeg filter came from. ffmpeg names
 * filters "Parsed_<name>_<index>" in its messages; index → path turns its errors into step errors.
 */
import { filterInfo } from './catalog'
import type { Look, OptionValue, Source, Step } from './look'

/** A number as ffmpeg should read it in our own filters (no exponent, ≤ 6 decimals). */
export function n(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`not a finite number: ${x}`)
  return Number.isInteger(x) ? String(x) : String(Number(x.toFixed(6)))
}

/** A user value as text ffmpeg parses back to exactly that value. */
function valueText(v: OptionValue): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)   // ffmpeg's av_strtod reads exponents (1e-7, 1.79e+308)
  return v
}

/** Escaping for one value inside a filter's argument list, then for the graph around it. */
export function escapeValue(raw: string): string {
  // both levels also trim unescaped whitespace at the ends, so leading/trailing spaces are escaped too
  const level = (s: string, special: RegExp) => {
    const body = s.replace(special, (c) => `\\${c}`)
    const lead = /^\s*/.exec(body)![0].length, trail = /\s*$/.exec(body)![0].length
    if (!lead && !trail) return body
    const esc = (w: string) => w.replace(/\s/g, (c) => `\\${c}`)
    return lead === body.length ? esc(body) : esc(body.slice(0, lead)) + body.slice(lead, body.length - trail) + esc(body.slice(body.length - trail))
  }
  return level(level(raw, /[\\':]/g), /[\\'[\],;]/g)
}

export function filterText(name: string, options?: Record<string, OptionValue>, enable?: string): string {
  // options that would add a video output the plugin can't carry are written off first (aphasemeter video=false)
  const all = { ...(filterInfo(name)?.pinned ?? {}), ...(options ?? {}) }
  const args = Object.entries(all).map(([k, v]) => `${k}=${escapeValue(valueText(v))}`)
  if (enable) args.push(`enable=${escapeValue(enable)}`)
  return args.length ? `${name}=${args.join(':')}` : name
}

export interface BuildOptions {
  /** measure: ebur128 at the end (pass 1 of levelling). render: gain + limiter at the end. chain: the rack alone. */
  mode: 'measure' | 'render' | 'chain'
  /** render: fixed gain from the measure pass */
  gainDb?: number
  /** render: true-peak ceiling in dBTP; needs `rate` (the rack's output sample rate) to oversample 4× */
  ceiling?: number
  rate?: number
  /** preview excerpts: the excerpt's start in the recording, so the rack sees recording time (t) — fades,
   *  `enable` ranges and atrim then act at the same moment in a 5 s chunk as in the whole file */
  offset?: number
}

export interface BuiltGraph {
  graph: string
  /** extra files to open with -i, in order: input index 1, 2, … */
  files: string[]
  /** look path of each file source, parallel to `files` */
  filePaths: string[]
  /** look path of each ffmpeg filter in graph order ('' = added by the plugin) */
  filterPaths: string[]
}

export const dbToLinear = (db: number) => Math.pow(10, db / 20)

export function buildGraph(look: Look, o: BuildOptions): BuiltGraph {
  const segments: string[] = []
  const filterPaths: string[] = []
  const files: string[] = []
  const filePaths: string[] = []
  let label = 0
  const fresh = () => `a${++label}`
  const seg = (ins: string[], filters: [string, string][], outs: string[]) => {
    for (const [, p] of filters) filterPaths.push(p)
    segments.push(`${ins.map((l) => `[${l}]`).join('')}${filters.map(([t]) => t).join(',')}${outs.map((l) => `[${l}]`).join('')}`)
  }

  const chain = (steps: Step[], input: string, path: string): string => {
    let cur = input
    steps.forEach((s, i) => { if (!s.bypass) cur = step(s, cur, `${path}[${i}]`) })
    return cur
  }

  const source = (src: Source, copy: string | undefined, path: string): string => {
    let start: string
    if (src.kind === 'signal') start = copy!
    else if (src.kind === 'file') { files.push(src.path); filePaths.push(path); start = `${files.length}:a` }
    else { start = fresh(); seg([], [[filterText(src.filter, src.options), path]], [start]) }
    return chain(src.chain ?? [], start, `${path}.chain`)
  }

  const step = (s: Step, input: string, path: string): string => {
    let main = input
    const extra: string[] = []
    if (s.inputs?.length) {
      const copies = s.inputs.filter((x) => x.kind === 'signal').length
      const copyLabels: string[] = []
      if (copies) {
        main = fresh()
        for (let k = 0; k < copies; k++) copyLabels.push(fresh())
        seg([input], [[`asplit=outputs=${copies + 1}`, '']], [main, ...copyLabels])
      }
      s.inputs.forEach((src, j) => extra.push(source(src, src.kind === 'signal' ? copyLabels.shift() : undefined, `${path}.inputs[${j}]`)))
    }
    const outs = (s.outputs?.length ?? 1)
    const outLabels = Array.from({ length: outs }, fresh)
    seg([main, ...extra], [[filterText(s.filter, s.options, s.enable), path]], outLabels)
    const results = outLabels.map((l, j) => chain(s.outputs?.[j] ?? [], l, `${path}.outputs[${j}]`))
    if (results.length === 1) return results[0]!
    const joined = fresh()
    seg(results, [[filterText(s.merge!.filter, s.merge!.options, s.merge!.enable), `${path}.merge`]], [joined])
    return joined
  }

  let input = '0:a'
  if (o.offset) { input = fresh(); seg(['0:a'], [[`asetpts=PTS+${n(o.offset)}/TB`, '']], [input]) }
  const end = chain(look.chain, input, 'chain')
  const tail: [string, string][] = []
  if (o.offset) tail.push(['asetpts=PTS-STARTPTS', ''])
  // sample peak only: true peak (4× oversampling) triples the cost of this pass, and what it is used for (one gain, and a
  // caller's estimate of headroom) does not need it. The rendered file is verified with true peak afterwards.
  if (o.mode === 'measure') tail.push(['ebur128=peak=sample:framelog=verbose', ''])
  if (o.mode === 'render') {
    if (o.gainDb !== undefined && o.gainDb !== 0) tail.push([`volume=${n(o.gainDb)}dB`, ''])
    if (o.ceiling !== undefined && o.rate) {
      // alimiter only sees samples; at 4× the rate it also catches the peaks between them (true peak)
      tail.push([`aresample=${o.rate * 4}`, ''], [`alimiter=limit=${n(dbToLinear(o.ceiling))}:level=false:attack=5:release=50:latency=true`, ''], [`aresample=${o.rate}`, ''])
    }
  }
  if (!tail.length) tail.push(['anull', ''])
  seg([end], tail, ['out'])
  return { graph: segments.join(';'), files, filePaths, filterPaths }
}

/** Turns ffmpeg's "[Parsed_<name>_<i> @ 0x…] message" lines into look paths. */
export function errorsByStep(stderr: string, filterPaths: string[]): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = []
  const add = (name: string, index: string, message: string) => {
    const path = filterPaths[Number(index)] ?? ''
    const text = `${name}: ${message.trim()}`
    if (!out.some((x) => x.path === path && x.message === text)) out.push({ path, message: text })
  }
  for (const line of stderr.split('\n')) {
    const own = /\[Parsed_(\w+?)_(\d+) @ 0x[0-9a-f]+\] (.+)/.exec(line)          // a filter's own message
    if (own) { add(own[1]!, own[2]!, own[3]!); continue }
    const about = /'Parsed_(\w+?)_(\d+)'/.exec(line)                              // ffmpeg talking about a filter
    if (about) add(about[1]!, about[2]!, line.replace(/'Parsed_(\w+?)_\d+'/g, "'$1'"))
  }
  return out
}
