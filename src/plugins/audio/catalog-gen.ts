/**
 * Builds catalog.json by asking the bundled ffmpeg about every audio filter it has (`-filters`, then
 * `-h filter=<name>` for each). Run it whenever ffmpeg changes:  npm run audio -- catalog
 * Node only (spawns ffmpeg); the renderer reads the generated JSON through catalog.ts.
 */
import { execFileSync } from 'node:child_process'
import type { Catalog, CatalogFilter, CatalogOption, FilterRole, OptionType, Pad } from './catalog'

/**
 * Filters whose extra outputs are video, switched on by an option (dropped from the catalog as video-only).
 * Without it they are plain audio effects; `pinned` is written into every graph when ffmpeg's default is on.
 */
const VIDEO_SWITCHED: Record<string, Record<string, boolean>> = { aphasemeter: { video: false }, ebur128: {}, anequalizer: {}, aiir: {} }

/** Graph plumbing and file readers that make no sense (or are unsafe) inside an edit chain. */
const EXCLUDED = new Set(['abuffer', 'abuffersink', 'anullsink', 'amovie', 'movie', 'streamselect', 'concat'])

const CATEGORY: Record<string, string[]> = {
  'EQ & filters': ['allpass', 'bandpass', 'bandreject', 'bass', 'biquad', 'equalizer', 'highpass', 'highshelf', 'lowpass', 'lowshelf', 'treble', 'tiltshelf', 'firequalizer', 'superequalizer', 'anequalizer', 'asubcut', 'asupercut', 'asuperpass', 'asuperstop', 'aemphasis', 'atilt', 'aiir', 'afir'],
  'Dynamics': ['acompressor', 'sidechaincompress', 'agate', 'sidechaingate', 'alimiter', 'compand', 'mcompand', 'adrc', 'adynamicequalizer', 'adynamicsmooth', 'dynaudnorm', 'loudnorm', 'speechnorm', 'deesser', 'acontrast', 'apsyclip', 'asoftclip'],
  'Noise & repair': ['afftdn', 'anlmdn', 'arnndn', 'afwtdn', 'adeclick', 'adeclip', 'anlms', 'anlmf', 'adenorm', 'hdcd', 'dcshift'],
  'Reverb, delay & space': ['aecho', 'adelay', 'haas', 'stereotools', 'stereowiden', 'extrastereo', 'crossfeed', 'earwax', 'surround', 'headphone', 'adecorrelate', 'compensationdelay'],
  'Modulation': ['chorus', 'flanger', 'aphaser', 'apulsator', 'tremolo', 'vibrato', 'afreqshift', 'aphaseshift'],
  'Tone & character': ['volume', 'acrusher', 'aexciter', 'crystalizer', 'asubboost', 'dialoguenhance', 'virtualbass', 'replaygain'],
  'Time & pitch': ['atempo', 'asetrate', 'apad', 'atrim', 'areverse', 'aloop', 'silenceremove', 'afade', 'acrossfade', 'asetpts', 'arealtime', 'acue'],
  'Channels & mixing': ['pan', 'channelmap', 'channelsplit', 'amerge', 'amix', 'join', 'ainterleave', 'asplit', 'acrossover', 'amultiply', 'astreamselect', 'aselect', 'asegment'],
  'Analysis': ['astats', 'ebur128', 'volumedetect', 'silencedetect', 'aspectralstats', 'drmeter', 'asdr', 'axcorrelate', 'abench', 'alatency', 'ashowinfo', 'aphasemeter'],
  'Math & custom': ['aeval', 'afftfilt', 'aderivative', 'aintegral'],
  'Format & plumbing': ['aformat', 'aresample', 'anull', 'acopy', 'afifo', 'asettb', 'aperms', 'asidedata', 'ametadata', 'asendcmd', 'asetnsamples'],
  'Sources': ['aevalsrc', 'afdelaysrc', 'afirsrc', 'anoisesrc', 'anullsrc', 'hilbert', 'sinc', 'sine'],
}
const categoryOf = (name: string) => Object.entries(CATEGORY).find(([, l]) => l.includes(name))?.[0] ?? 'Other'

/** ffmpeg prints extreme limits by name (libavutil/opt.c log_value). */
const NAMED: Record<string, number> = {
  INT_MAX: 2147483647, INT_MIN: -2147483648, UINT32_MAX: 4294967295,
  I64_MAX: 9223372036854775807, I64_MIN: -9223372036854775808,
  FLT_MAX: 3.4028234663852886e38, FLT_MIN: 1.1754943508222875e-38, DBL_MAX: Number.MAX_VALUE, DBL_MIN: 2.2250738585072014e-308,
}
function num(tok: string): number {
  const neg = tok.startsWith('-') && NAMED[tok.slice(1)] !== undefined
  const n = NAMED[neg ? tok.slice(1) : tok]
  return n !== undefined ? (neg ? -n : n) : Number(tok)
}

const TYPES: Record<string, OptionType> = {
  int: 'int', int64: 'int', uint64: 'int', 'unsigned': 'int', double: 'double', float: 'float', boolean: 'boolean', bool: 'boolean',
  string: 'string', duration: 'duration', flags: 'flags', channel_layout: 'channel_layout', sample_fmt: 'sample_fmt',
  rational: 'rational', video_rate: 'rational', image_size: 'string', color: 'string', pix_fmt: 'string', dictionary: 'string', binary: 'string',
}

function parsePads(lines: string[], from: number): { pads: Pad[] | 'dynamic'; next: number } {
  const pads: Pad[] = []
  let i = from
  for (; i < lines.length; i++) {
    const l = lines[i]!
    if (/dynamic \(depending on the options\)/.test(l)) return { pads: 'dynamic', next: i + 1 }
    if (/none \(source filter\)|none \(sink filter\)/.test(l)) return { pads: [], next: i + 1 }
    const m = /^\s+#(\d+): (\S+) \((\w+)\)/.exec(l)
    if (!m) break
    pads.push({ name: m[2]!, type: m[3] === 'audio' ? 'audio' : 'video' })
  }
  return { pads, next: i }
}

export function parseFilterHelp(name: string, text: string): Omit<CatalogFilter, 'role' | 'category' | 'flags' | 'signature'> {
  const lines = text.split('\n')
  const description = (lines[1] ?? '').trim()
  let inputs: Pad[] | 'dynamic' = [], outputs: Pad[] | 'dynamic' = []
  const options: CatalogOption[] = []
  let section = '', current: CatalogOption | null = null
  let i = 0
  while (i < lines.length) {
    const l = lines[i]!
    if (/^\s+Inputs:\s*$/.test(l)) { const r = parsePads(lines, i + 1); inputs = r.pads; i = r.next; continue }
    if (/^\s+Outputs:\s*$/.test(l)) { const r = parsePads(lines, i + 1); outputs = r.pads; i = r.next; continue }
    const sec = /^(\S.*) AVOptions:\s*$/.exec(l)
    if (sec) { section = sec[1]!; current = null; i++; continue }
    const opt = /^ {2,3}-?(\S+)\s+<(\w+)>\s+([.A-Z]{11})\s?(.*)$/.exec(l)
    if (opt && section) {
      const [, oname, rawType, flags, restRaw] = opt as unknown as [string, string, string, string, string]
      let rest = restRaw.trim()
      let def: string | undefined
      const di = rest.lastIndexOf('(default ')
      if (di >= 0 && rest.endsWith(')')) { def = rest.slice(di + 9, -1); rest = rest.slice(0, di).trim() }
      let min: number | undefined, max: number | undefined
      const rm = /\(from (\S+) to (\S+)\)$/.exec(rest)
      if (rm) { min = num(rm[1]!); max = num(rm[2]!); rest = rest.slice(0, rm.index).trim() }
      const type = TYPES[rawType] ?? 'string'
      const o: CatalogOption = {
        name: oname, aliases: [], type, ffmpegType: rawType, desc: rest,
        ...(min !== undefined ? { min, max } : {}),
        ...(def !== undefined ? { default: def.replace(/^"(.*)"$/s, '$1') } : {}),
        live: flags[9] === 'T', deprecated: flags[10] === 'P' || /deprecated/i.test(rest),
        // options a filter inherits from a library (aresample ← SWResampler); filter-own sections are named after filters
        ...(/^[A-Z]/.test(section) ? { group: section } : {}),
      }
      // ffmpeg lists aliases as consecutive options with identical type, flags, text, range and default
      const prev = options.at(-1)
      if (prev && prev.ffmpegType === rawType && prev.desc === o.desc && prev.min === o.min && prev.max === o.max && prev.default === o.default && prev.live === o.live && o.desc !== '') {
        prev.aliases.push(oname); current = prev
      } else if (flags[3] === 'V' && flags[4] !== 'A') {
        current = null   // video-only option (e.g. afir's frequency-response picture): not an audio setting
      } else {
        options.push(o); current = o
      }
      i++; continue
    }
    const cst = /^ {4,5}(\S+)\s+(-?\d+)?\s+([.A-Z]{11})\s?(.*)$/.exec(l)
    if (cst && current && !/<\w+>/.test(l)) {
      const c = { name: cst[1]!, ...(cst[2] !== undefined ? { value: Number(cst[2]) } : {}), desc: (cst[4] ?? '').trim() }
      const list = (current.constants ??= [])
      // short spellings share a value with the long name (afftdn: white = w = 0): keep one choice, remember the alias
      const same = c.value !== undefined ? list.find((x) => x.value === c.value) : undefined
      if (same) { if (same.name !== c.name && !same.aliases?.includes(c.name)) (same.aliases ??= []).push(c.name) }
      else if (!list.some((x) => x.name === c.name)) list.push(c)
      i++; continue
    }
    i++
  }
  // options whose ffmpeg type is a plain int but that list named values are choices
  for (const o of options) if (o.type === 'int' && o.constants?.length) o.choices = true
  return { name, description, inputs, outputs, timeline: /support for timeline/.test(text), options }
}

function roleOf(sig: string, inputs: Pad[] | 'dynamic', outputs: Pad[] | 'dynamic'): FilterRole {
  const [i, o] = sig.split('->') as [string, string]
  if (i === '|') return 'source'
  const oneIn = i === 'A' && inputs !== 'dynamic', oneOut = o === 'A' && outputs !== 'dynamic'
  if (oneIn && oneOut) return 'effect'
  if (oneIn && !oneOut) return 'split'
  return 'multi-input'
}

export function generateCatalog(ffmpeg: string): Catalog {
  // ffmpeg ends its lines with \r\n on Windows: read as text with plain line ends, so the same build gives the same catalog everywhere
  const ask = (...args: string[]) => execFileSync(ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' }).replace(/\r\n/g, '\n')
  const version = ask('-version').split('\n')[0]!.trim()
  const list = ask('-filters').split('\n')
  const filters: Record<string, CatalogFilter> = {}
  for (const line of list) {
    const m = /^ ([.T])([.S])([.C]) (\S+)\s+(\S+->\S+)\s/.exec(line)
    if (!m) continue
    const [, t, s, c, name, sig] = m as unknown as [string, string, string, string, string, string]
    if (!/^[A|N]+->[A|N]+$/.test(sig) || EXCLUDED.has(name)) continue   // audio-only filters
    const help = ask('-h', `filter=${name}`)
    const f = parseFilterHelp(name, help)
    if (f.inputs !== 'dynamic' && f.inputs.some((p) => p.type !== 'audio')) continue
    if (f.outputs !== 'dynamic' && f.outputs.some((p) => p.type !== 'audio')) continue
    const switched = VIDEO_SWITCHED[name]
    if (switched) f.outputs = [{ name: 'default', type: 'audio' }]
    filters[name] = {
      ...f, role: switched ? 'effect' : roleOf(sig, f.inputs, f.outputs), category: categoryOf(name), flags: { timeline: t === 'T', threads: s === 'S', commands: c === 'C' }, signature: sig,
      ...(switched && Object.keys(switched).length ? { pinned: switched } : {}),
    }
  }
  return { ffmpeg: version, filters }
}
