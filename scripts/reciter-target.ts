/**
 * Makes a reciter's target sound: runs their best recordings through the settings approved by ear, measures the results,
 * and stores the median in src/core/reciter-profiles.json (next to the reciter's profile; make that first).
 *
 *   npx vite-node scripts/reciter-target.ts "<library folder>" <ReciterFolder> <best file name>…
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { defaultModules, toLook } from '../src/core/audio-modules'
import { approvedSettings } from '../src/core/audio-suggest'
import { reciterKey } from '../src/core/index'
import { analyse, measure, processAudio, ring } from '../src/plugins/audio/index'
import { MEASURE_VERSION, type Measure } from '../src/plugins/audio/types'

const [library, folder, ...best] = process.argv.slice(2)
if (!library || !folder || best.length < 3) { console.error('usage: reciter-target.ts "<library>" <ReciterFolder> <best file>… (at least 3)'); process.exit(1) }
const out = resolve('src/core/reciter-profiles.json')
const all = JSON.parse(readFileSync(out, 'utf8')) as Record<string, { measureVersion: number; target?: unknown }>
const entry = all[reciterKey(folder)]
if (!entry) { console.error(`No profile for ${folder} yet: run scripts/reciter-profile.ts first.`); process.exit(1) }
if (entry.measureVersion !== MEASURE_VERSION) { console.error('The stored profile was made with another measure version: rebuild it first.'); process.exit(1) }
const tmp = mkdtempSync(join(tmpdir(), 'yj-target-'))
const host = { outputDir: tmp, ffmpegPath: ffmpegStatic as unknown as string, log: (l: string, m: string) => { if (l !== 'info') console.error(`[${l}] ${m}`) } }
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 }
const r1 = (x: number) => Math.round(x * 10) / 10
const done: Measure[] = []
const rings: number[] = [], louds: number[] = []
let hp = 80
try {
  for (const name of best) {
    const file = join(library, folder, name)
    const [m, a, rg] = await Promise.all([measure(file, host), analyse(file, host), ring(file, host)])
    if (!m) throw new Error(`${name}: silent or too short to measure`)
    const s = approvedSettings(defaultModules(), m, a.lufs, rg)
    hp = s.modules.eq.hp.freq
    const r = await processAudio({ audioPath: file, look: toLook(s.modules) }, host)
    if (!r.ok) throw new Error(`${name}: ${r.message}`)
    const after = await measure(r.file, host)
    const ringAfter = await ring(r.file, host)
    if (ringAfter?.burstMs) rings.push(((ringAfter.excessDb[ringAfter.offsets.indexOf(100)] ?? 0) + (ringAfter.excessDb[ringAfter.offsets.indexOf(150)] ?? 0)) / 2)
    louds.push(a.lufs)
    if (!after) throw new Error(`${name}: the processed file could not be measured`)
    done.push(after)
    console.log(`${name}: ${a.lufs} → ${r.after.lufs} LUFS, loudest over typical ${r1(m.levels.p99 - m.levels.p50)} → ${r1(after.levels.p99 - after.levels.p50)} dB`)
  }
} finally { rmSync(tmp, { recursive: true, force: true }) }
entry.target = { built: new Date().toISOString().slice(0, 10), from: best, count: done.length, hp, tone: done[0]!.tone.map((_, b) => r1(median(done.map((m) => m.tone[b]!)))), over: r1(median(done.map((m) => m.levels.p99 - m.levels.p50))), quiet: done[0]!.quiet.map((_, b) => r1(median(done.map((m) => m.quiet[b]!)))), ring: r1(rings.length ? median(rings) : 0), lufs: r1(median(louds)) }
writeFileSync(out, JSON.stringify(all, null, 2) + '\n')
console.log(`${folder}: target from ${done.length} recordings written to ${out}`)
