/**
 * Standalone runner — the audio plugin without the app (plain Node, no Electron).
 *
 *   npm run build
 *   npm run audio -- catalog [--out src/plugins/audio/catalog.json]   regenerate the filter catalog from ffmpeg
 *   npm run audio -- filters [category|filter]           browse filters, or every option of one filter
 *   npm run audio -- process <file> [--look look.json | --preset name] [--preview start:seconds] [--bypass]
 *                                   [--level lufs[:ceiling] | --no-level] [--out dir]
 *   npm run audio -- explain [--look … | --preset …]      the exact ffmpeg graph
 *   npm run audio -- check [--look … | --preset …] [--file f]   ffmpeg's verdict, errors per step
 *   npm run audio -- analyse <file|folder>…             measurements + hints as a table
 *   npm run audio -- batch <folder> [--look … | --preset …] [--out dir]   every recording; exit 1 on any failure
 *   npm run audio -- sweep [--filter name] [--report out.json]   every filter, every option at its limits
 *
 * Presets: none, cleanup, springTamer, reverbRoom, reverbHall. Default output dir: /tmp/audio-out.
 */
import { promises as fs } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { generateCatalog } from './catalog-gen'
import { analyse, CATALOG, checkLook, LIMITS, explain, filterInfo, filtersByCategory, LOOK_PRESETS, padCount, processAudio, type AudioHost, type CatalogOption, type Look, type OptionValue, type Step } from './index'

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus', '.wma'])
const bin = (ffmpegStatic as unknown as string | null) ?? 'ffmpeg'

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const BOOL_FLAGS = new Set(['--bypass', '--no-level'])

async function lookFrom(args: string[]): Promise<unknown> {
  const file = flag(args, 'look')
  if (file) return JSON.parse(await fs.readFile(file, 'utf8')) as unknown
  const preset = flag(args, 'preset')
  if (preset) { const p = LOOK_PRESETS[preset]; if (!p) throw new Error(`Unknown preset ${preset} (${Object.keys(LOOK_PRESETS).join(', ')})`); return p.look }
  return { chain: [] }
}

const host = (outputDir: string): AudioHost => ({ outputDir, ffmpegPath: bin, log: (level, m) => { if (level !== 'info') console.error(`[${level}] ${m}`) } })

async function audioFiles(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    const abs = resolve(p)
    const st = await fs.stat(abs)
    if (st.isDirectory()) for (const e of (await fs.readdir(abs)).sort()) { if (AUDIO_EXTS.has(extname(e).toLowerCase())) out.push(join(abs, e)) }
    else out.push(abs)
  }
  return out
}

const pad = (s: string | number, w: number) => String(s).padEnd(w)
const short = (p: string) => p.split(/[\\/]/).pop()!.slice(0, 50)
const optLine = (o: CatalogOption) => {
  const range = o.min !== undefined ? ` ${o.min} … ${o.max}` : ''
  const choices = o.constants?.length ? ` {${o.constants.map((c) => c.name).join('|')}}` : ''
  return `  ${pad(o.name + (o.aliases.length ? ` (${o.aliases.join(', ')})` : ''), 30)}${pad(o.type, 15)}${pad(`default ${o.default ?? '—'}`, 22)}${range}${choices}${o.live ? '  live' : ''}${o.deprecated ? '  DEPRECATED' : ''}\n      ${o.desc}`
}

/** Working settings for filters that need some before they run (FILTER_NEEDS), so their other options get swept too. */
const SWEEP_BASE: Record<string, Record<string, OptionValue>> = {
  aeval: { exprs: 'val(0)*0.5' }, pan: { args: 'mono|c0=c0' }, chorus: { delays: '40', decays: '0.4', speeds: '0.25', depths: '2' },
  channelmap: { map: '0', channel_layout: 'mono' }, asegment: { timestamps: '0.2' }, asendcmd: { commands: '0.1 volume volume 0.5' },
  asidedata: { type: 'REPLAYGAIN' }, astreamselect: { map: '0' },
}

/** A minimal valid step for a filter, for the sweep: extra inputs copied from the signal, every output kept. */
function sweepStep(filter: string, extra: Record<string, OptionValue>): Step | null {
  const options = { ...(SWEEP_BASE[filter] ?? {}), ...extra }
  const f = filterInfo(filter)!
  if (f.role === 'source') return null
  // capped one past the plugin's branch limit, so validation (not this helper) reports a too-large count
  const nIn = Math.min(padCount(filter, options, 'in') ?? 2, LIMITS.branches + 2), nOut = Math.min(padCount(filter, options, 'out') ?? 2, LIMITS.branches + 1)
  const s: Step = { filter, ...(Object.keys(options).length ? { options } : {}) }
  if (nIn > 1) s.inputs = Array.from({ length: nIn - 1 }, () => ({ kind: 'signal' as const }))
  if (nOut > 1 || f.outputs === 'dynamic') {
    s.outputs = Array.from({ length: nOut }, () => [])
    if (nOut > 1) s.merge = { filter: 'amix', options: { inputs: nOut } }
  }
  return s
}

/** The values the sweep tries for one option: its limits (capped at ±1e6 so a test can't eat the machine's memory) and every choice. */
function sweepValues(o: CatalogOption): { value: OptionValue; note?: string }[] {
  const out: { value: OptionValue; note?: string }[] = []
  if (o.type === 'boolean') return [{ value: true }, { value: false }]
  if (o.constants?.length && (o.type === 'int' || o.type === 'flags')) for (const c of o.constants) out.push({ value: c.name })
  if ((o.type === 'int' || o.type === 'double' || o.type === 'float') && o.min !== undefined && o.max !== undefined) {
    for (const lim of [o.min, o.max]) {
      const capped = Math.max(-1e6, Math.min(1e6, lim))
      out.push({ value: o.type === 'int' ? Math.round(capped) : capped, ...(capped !== lim ? { note: `limit ${lim} tested as ${capped}` } : {}) })
    }
  }
  return out
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2)
  const outDir = resolve(flag(args, 'out') ?? '/tmp/audio-out')
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--') && !BOOL_FLAGS.has(args[i - 1]!)))

  if (cmd === 'catalog') {
    const out = resolve(flag(args, 'out') ?? 'src/plugins/audio/catalog.json')
    const c = generateCatalog(bin)
    await fs.writeFile(out, JSON.stringify(c, null, 1) + '\n')
    const fs_ = Object.values(c.filters)
    console.log(`${c.ffmpeg}\n${fs_.length} filters, ${fs_.reduce((s, f) => s + f.options.length, 0)} options → ${out}`)
    return 0
  }

  if (cmd === 'filters') {
    const what = positional[0]
    const f = what ? filterInfo(what) : undefined
    if (f) {
      console.log(`${f.name} — ${f.description}\n${f.category} · ${f.role} · ${f.signature}${f.timeline ? ' · timeline (enable)' : ''}${f.flags.commands ? ' · live commands' : ''}\n`)
      for (const o of f.options) console.log(optLine(o))
      if (!f.options.length) console.log('  (no options)')
      return 0
    }
    for (const [cat, names] of Object.entries(filtersByCategory())) {
      if (what && cat.toLowerCase() !== what.toLowerCase()) continue
      console.log(`\n${cat}`)
      for (const name of names) { const x = CATALOG.filters[name]!; console.log(`  ${pad(name, 20)}${pad(x.role, 12)}${pad(x.options.length + ' opts', 9)}${x.description}`) }
    }
    return 0
  }

  if (cmd === 'process') {
    const preview = flag(args, 'preview')?.split(':').map(Number)
    const lv = flag(args, 'level')?.split(':').map(Number)
    const r = await processAudio({
      audioPath: resolve(positional[0]!), look: await lookFrom(args), bypass: args.includes('--bypass'),
      ...(preview ? { preview: { start: preview[0]!, seconds: preview[1]! } } : {}),
      ...(lv ? { level: { lufs: lv[0]!, ceiling: lv[1] ?? -1.5 } } : args.includes('--no-level') ? { level: null } : {}),
    }, { ...host(outDir), onProgress: (p) => process.stderr.write(`\r${p}%  `) })
    process.stderr.write('\n')
    console.log(JSON.stringify(r, null, 2))
    return r.ok ? 0 : 1
  }

  if (cmd === 'explain') {
    const e = explain(await lookFrom(args))
    if (!e.ok) { for (const x of e.errors) console.error(`${x.path}: ${x.message}`); return 1 }
    console.log(e.graph.split(';').join(';\n'))
    if (e.files.length) console.log(`\nextra inputs: ${e.files.join(', ')}`)
    return 0
  }

  if (cmd === 'check') {
    const file = flag(args, 'file')
    const c = await checkLook(await lookFrom(args), { ffmpegPath: bin }, file ? { audioPath: resolve(file) } : {})
    if (c.ok) { console.log(`ok — output ${c.sampleRate} Hz, ${c.channels} channel(s)`); return 0 }
    for (const x of c.errors) console.error(`${x.path || '(look)'}: ${x.message}`)
    return 1
  }

  if (cmd === 'analyse') {
    console.log(`${pad('file', 52)}${pad('dur', 8)}${pad('LUFS', 8)}${pad('LRA', 6)}${pad('peak', 7)}${pad('hot%', 9)}${pad('hiss', 7)}${pad('rumble', 8)}hints`)
    for (const f of await audioFiles(positional)) {
      const a = await analyse(f, { ffmpegPath: bin })
      console.log(`${pad(short(f), 52)}${pad(a.durationSec.toFixed(0) + 's', 8)}${pad(a.lufs, 8)}${pad(a.lra, 6)}${pad(a.truePeak, 7)}${pad(a.hotSamplesPct, 9)}${pad(a.hissDb, 7)}${pad(a.rumbleDb, 8)}${a.hints.join(' | ')}`)
    }
    return 0
  }

  if (cmd === 'batch') {
    const look = await lookFrom(args)
    let failed = 0
    console.log(`${pad('file', 52)}${pad('result', 20)}${pad('gain', 8)}${pad('LUFS', 8)}${pad('peak', 7)}${pad('len Δ', 8)}${pad('secs', 6)}warnings`)
    for (const f of await audioFiles(positional)) {
      const t0 = Date.now()
      const r = await processAudio({ audioPath: f, look }, host(outDir))
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      if (r.ok) console.log(`${pad(short(f), 52)}${pad(r.cached ? 'ok (cached)' : 'ok', 20)}${pad(r.gainDb, 8)}${pad(r.after.lufs, 8)}${pad(r.after.truePeak, 7)}${pad((r.after.durationSec - r.inputSec).toFixed(3), 8)}${pad(secs, 6)}${r.warnings.join(' | ')}`)
      else { failed++; console.log(`${pad(short(f), 52)}${pad(r.reason, 20)}${r.message}`) }
    }
    console.log(failed ? `\n${failed} failed` : '\nall ok')
    return failed ? 1 : 0
  }

  if (cmd === 'sweep') {
    // every filter at its defaults, then every option at each limit and choice, each run through ffmpeg on 0.5 s
    // of tone (mono; stereo when mono fails at the defaults). Reports what ffmpeg refuses and anything that crashes.
    const only = flag(args, 'filter')
    const names = Object.keys(CATALOG.filters).filter((nm) => !only || nm === only)
    interface Row { filter: string; option?: string; value?: OptionValue; note?: string; ok: boolean; crash: boolean; message?: string }
    const rows: Row[] = []
    const stereoOnly: string[] = [], skipped: string[] = []
    const queue: (() => Promise<void>)[] = []
    for (const name of names) {
      const base = sweepStep(name, {})
      if (!base) { skipped.push(`${name} (source: tested as a generate input below)`); continue }
      queue.push(async () => {
        let channels: 1 | 2 = 1
        let c = await checkLook({ chain: [base] }, { ffmpegPath: bin }, { seconds: 0.5, channels })
        if (!c.ok) { const s = await checkLook({ chain: [base] }, { ffmpegPath: bin }, { seconds: 0.5, channels: 2 }); if (s.ok) { channels = 2; c = s; stereoOnly.push(name) } }
        const msg = (x: typeof c) => (x.ok ? undefined : x.errors.map((e) => e.message).join(' · '))
        rows.push({ filter: name, ok: c.ok, crash: /crashed/.test(msg(c) ?? ''), ...(c.ok ? {} : { message: msg(c) }) })
        if (!c.ok) return   // a filter that needs a setting to work at all (a model file, a curve) is reported once
        for (const o of CATALOG.filters[name]!.options) {
          if (o.deprecated || o.group) continue
          for (const { value, note } of sweepValues(o)) {
            const step = sweepStep(name, { [o.name]: value })
            if (!step) continue
            const r = await checkLook({ chain: [step] }, { ffmpegPath: bin }, { seconds: 0.5, channels })
            const m = msg(r)
            rows.push({ filter: name, option: o.name, value, ...(note ? { note } : {}), ok: r.ok, crash: /crashed|SIG/.test(m ?? ''), ...(m ? { message: m } : {}) })
          }
        }
      })
    }
    for (const name of names.filter((nm) => CATALOG.filters[nm]!.role === 'source')) {
      queue.push(async () => {
        const look: Look = { chain: [{ filter: 'amix', options: { inputs: 2, duration: 'first' }, inputs: [{ kind: 'generate', filter: name, options: name === 'aevalsrc' ? { exprs: '0.1*sin(2*PI*220*t)' } : {} }] }] }
        const r = await checkLook(look, { ffmpegPath: bin }, { seconds: 0.5 })
        rows.push({ filter: name, ok: r.ok, crash: false, ...(r.ok ? {} : { message: r.errors.map((e) => e.message).join(' · ') }) })
      })
    }
    let done = 0
    const workers = Array.from({ length: 6 }, async () => { for (let job = queue.shift(); job; job = queue.shift()) { await job(); done++; process.stderr.write(`\r${done} filters`) } })
    await Promise.all(workers)
    process.stderr.write('\n')
    const bad = rows.filter((r) => !r.ok)
    const crashes = rows.filter((r) => r.crash)
    for (const r of bad) console.log(`${r.crash ? 'CRASH' : 'refused'}  ${r.filter}${r.option ? ` ${r.option}=${r.value}` : ' (defaults)'}${r.note ? ` [${r.note}]` : ''}: ${r.message?.slice(0, 160)}`)
    console.log(`\n${rows.length} runs over ${names.length} filters: ${rows.length - bad.length} ok, ${bad.length} refused by ffmpeg, ${crashes.length} crashes.`)
    if (stereoOnly.length) console.log(`stereo input needed: ${stereoOnly.sort().join(', ')}`)
    const report = flag(args, 'report')
    if (report) await fs.writeFile(report, JSON.stringify({ ffmpeg: CATALOG.ffmpeg, rows, stereoOnly, skipped }, null, 1))
    return crashes.length ? 1 : 0
  }

  console.error('usage: audio catalog|filters|process|explain|check|analyse|batch|sweep … (see the header of src/plugins/audio/cli.ts)')
  return 2
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1) })
