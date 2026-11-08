/**
 * Standalone runner — processes audio without the app (plain Node, no Electron).
 *
 *   npm run build
 *   npm run audio -- process <file> [--look look.json] [--preset strong|original] [--reverb room|hall|masjid]
 *                                   [--preview start:seconds] [--bypass] [--match <lufs>] [--out dir]
 *   npm run audio -- analyse <file|folder>…           measurements + hints as a table
 *   npm run audio -- explain [--look look.json] [--reverb hall]   print the exact filter graphs
 *   npm run audio -- batch <folder> [--look …] [--out dir]        process every recording; exit 1 on any failure
 *   npm run audio -- sweep <file> [--out dir]          every knob at min and max on a 15 s preview; exit 1 on any failure
 *
 * Results print as JSON lines (process) or tables; the default output dir is /tmp/audio-out.
 */
import { promises as fs } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { analyse, explain, LOOK_FIELDS, LOOK_PRESETS, processAudio, REVERB_PRESETS, type AudioHost, type LookPatch } from './index'

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus', '.wma'])
const bin = (ffmpegStatic as unknown as string | null) ?? 'ffmpeg'

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

/** Merge patches (later wins), knob by knob. */
function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge((out[k] as Record<string, unknown>) ?? {}, v as Record<string, unknown>) : v
  return out
}

async function lookFrom(args: string[]): Promise<LookPatch> {
  let look: Record<string, unknown> = {}
  const preset = flag(args, 'preset')
  if (preset) { const p = (LOOK_PRESETS as Record<string, { patch: LookPatch }>)[preset]; if (!p) throw new Error(`Unknown preset ${preset}`); look = merge(look, p.patch as Record<string, unknown>) }
  const reverb = flag(args, 'reverb')
  if (reverb) { const p = (REVERB_PRESETS as Record<string, { patch: LookPatch }>)[reverb]; if (!p) throw new Error(`Unknown reverb ${reverb}`); look = merge(look, p.patch as Record<string, unknown>) }
  const file = flag(args, 'look')
  if (file) look = merge(look, JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>)
  return look as LookPatch
}

const host = (outputDir: string): AudioHost => ({ outputDir, ffmpegPath: bin, log: (level, m) => console.error(`[${level}] ${m}`) })

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

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2)
  const outDir = resolve(flag(args, 'out') ?? '/tmp/audio-out')
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--') && args[i - 1] !== '--bypass'))

  if (cmd === 'process') {
    const preview = flag(args, 'preview')?.split(':').map(Number)
    const match = flag(args, 'match')
    const r = await processAudio({
      audioPath: resolve(positional[0]!), look: await lookFrom(args), bypass: args.includes('--bypass'),
      ...(preview ? { preview: { start: preview[0]!, seconds: preview[1]! } } : {}), ...(match ? { matchLufs: Number(match) } : {}),
    }, { ...host(outDir), onProgress: (p) => process.stderr.write(`\r${p}%  `) })
    process.stderr.write('\n')
    console.log(JSON.stringify(r, null, 2))
    return r.ok ? 0 : 1
  }

  if (cmd === 'analyse') {
    console.log(`${pad('file', 52)}${pad('dur', 8)}${pad('LUFS', 8)}${pad('LRA', 6)}${pad('peak', 7)}${pad('hot%', 9)}${pad('hiss', 7)}${pad('rumble', 8)}hints`)
    for (const f of await audioFiles(positional)) {
      const a = await analyse(f, { ffmpegPath: bin })
      console.log(`${pad(short(f), 52)}${pad(a.durationSec.toFixed(0) + 's', 8)}${pad(a.lufs, 8)}${pad(a.lra, 6)}${pad(a.truePeak, 7)}${pad(a.hotSamplesPct, 9)}${pad(a.hissDb, 7)}${pad(a.rumbleDb, 8)}${a.hints.join(' | ')}`)
    }
    return 0
  }

  if (cmd === 'explain') {
    const e = explain(await lookFrom(args))
    if (!e.ok) { console.error(e.message); return 1 }
    console.log(`measure:\n  ${e.measure.split(';').join(';\n  ')}\n\nrender:\n  ${e.render.split(';').join(';\n  ')}`)
    return 0
  }

  if (cmd === 'batch') {
    const look = await lookFrom(args)
    let failed = 0
    console.log(`${pad('file', 52)}${pad('result', 20)}${pad('gain', 8)}${pad('LUFS', 8)}${pad('peak', 7)}${pad('secs', 6)}warnings`)
    for (const f of await audioFiles(positional)) {
      const t0 = Date.now()
      const r = await processAudio({ audioPath: f, look }, host(outDir))
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      if (r.ok) console.log(`${pad(short(f), 52)}${pad(r.cached ? 'ok (cached)' : 'ok', 20)}${pad(r.gainDb, 8)}${pad(r.after.lufs, 8)}${pad(r.after.truePeak, 7)}${pad(secs, 6)}${r.warnings.join(' | ')}`)
      else { failed++; console.log(`${pad(short(f), 52)}${pad(r.reason, 20)}${r.message}`) }
    }
    console.log(failed ? `\n${failed} failed` : '\nall ok')
    return failed ? 1 : 0
  }

  if (cmd === 'sweep') {
    const file = resolve(positional[0]!)
    // every knob at its min and max, with its own section switched on; plus every reverb preset
    const cases: { name: string; look: LookPatch }[] = []
    const set = (path: string, value: unknown): Record<string, unknown> => path.split('.').reduceRight<unknown>((acc, k) => ({ [k]: acc }), value) as Record<string, unknown>
    const allOn = { cleanup: { declip: { enabled: true } }, tone: { enabled: true }, dynamics: { enabled: true }, reverb: { enabled: true } }
    for (const { path, field } of LOOK_FIELDS) {
      if (field.kind === 'toggle') { cases.push({ name: `${path}=${!field.default}`, look: set(path, !field.default) as LookPatch }); continue }
      for (const value of [field.min, field.max]) cases.push({ name: `${path}=${value}`, look: merge(allOn, set(path, value)) as LookPatch })
    }
    for (const [name, p] of Object.entries(REVERB_PRESETS)) cases.push({ name: `reverb preset ${name}`, look: p.patch })
    cases.push({ name: 'everything off', look: { cleanup: { clicks: { enabled: false }, rumble: { enabled: false }, hiss: { enabled: false } }, loudness: { enabled: false }, fades: { in: 0, out: 0 } } })
    let failed = 0
    for (const c of cases) {
      const r = await processAudio({ audioPath: file, look: c.look, preview: { start: 0, seconds: 15 } }, host(outDir))
      if (!r.ok) failed++
      console.log(`${pad(c.name, 34)}${r.ok ? `ok   ${pad(r.after.lufs + ' LUFS', 12)}peak ${pad(r.after.truePeak, 6)} ch ${r.after.channels}${r.warnings.length ? '  ⚠ ' + r.warnings.join(' | ') : ''}` : `FAIL ${r.reason}: ${r.message}`}`)
    }
    console.log(`\n${cases.length} cases, ${failed} failed`)
    return failed ? 1 : 0
  }

  console.error('usage: audio process|analyse|explain|batch|sweep … (see the header of src/plugins/audio/cli.ts)')
  return 2
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1) })
