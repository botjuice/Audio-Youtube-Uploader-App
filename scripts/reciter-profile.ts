/**
 * Builds a built-in Auto-set profile for one reciter from the measurements the app already made.
 *
 *   npx vite-node scripts/reciter-profile.ts "<library folder>" <ReciterFolder> [file name to leave out]…
 *
 * Open the library in the app and press Auto-set once on any recording of the reciter first: that writes
 * <library>/.yoosyjoosy/audio-measures.json, which this reads. The result is merged into
 * src/core/reciter-profiles.json under the reciter's key.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildProfile } from '../src/core/audio-suggest'
import { reciterKey } from '../src/core/index'
import { MEASURE_VERSION, type Measure } from '../src/plugins/audio/types'

const [library, folder, ...leaveOut] = process.argv.slice(2)
if (!library || !folder) { console.error('usage: reciter-profile.ts "<library>" <ReciterFolder> [file to leave out]…'); process.exit(1) }
const cache = JSON.parse(readFileSync(join(library, '.yoosyjoosy', 'audio-measures.json'), 'utf8')) as { v: number; files: Record<string, { m: Measure | null }> }
if (cache.v !== MEASURE_VERSION) { console.error(`The measurements are version ${cache.v}, the app is at ${MEASURE_VERSION}: press Auto-set again first.`); process.exit(1) }
const used = Object.entries(cache.files).filter(([rel, e]) => rel.startsWith(`${folder}/`) && e.m && !leaveOut.includes(rel.slice(folder.length + 1)))
const profile = buildProfile(used.map(([, e]) => e.m!))
if (!profile) { console.error(`Not enough measured recordings of ${folder} (${used.length}).`); process.exit(1) }
const r1 = (x: number) => Math.round(x * 10) / 10
const q = (x: { p25: number; p50: number; p75: number }) => ({ p25: r1(x.p25), p50: r1(x.p50), p75: r1(x.p75) })
const out = resolve('src/core/reciter-profiles.json')
const all = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>
all[reciterKey(folder)] = { reciter: folder, measureVersion: MEASURE_VERSION, built: new Date().toISOString().slice(0, 10), leftOut: leaveOut, profile: { count: profile.count, tone: profile.tone.map(q), sibilance: q(profile.sibilance) } }
writeFileSync(out, JSON.stringify(all, null, 2) + '\n')
console.log(`${folder}: profile from ${profile.count} recordings written to ${out} (key "${reciterKey(folder)}")`)
