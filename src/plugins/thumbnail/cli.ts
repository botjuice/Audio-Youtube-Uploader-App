/**
 * Standalone runner — renders jobs without the app, for template work and checks.
 *
 *   npm run build && npm run thumb -- <jobs.json> [outDir]
 *
 * jobs.json is one ThumbnailJob or an array of them. Relative photo paths resolve against the
 * JSON file's folder. Each result is printed as one JSON line; exit code 1 if any job failed.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { dispose, render } from './index'
import type { ThumbnailJob } from './types'

async function main(): Promise<number> {
  const [jobsFile, outArg] = process.argv.slice(app.isPackaged ? 1 : 2)
  if (!jobsFile) { console.error('usage: thumbnail-cli <jobs.json> [outDir]'); return 2 }
  const file = resolve(jobsFile)
  const outputDir = resolve(outArg ?? 'thumbnail-out')
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as ThumbnailJob | ThumbnailJob[]
  const jobs = Array.isArray(raw) ? raw : [raw]
  const base = dirname(file)

  let failed = 0
  for (const job of jobs) {
    const photoPath = isAbsolute(job.photoPath) ? job.photoPath : resolve(base, job.photoPath)
    const result = await render({ ...job, photoPath }, { outputDir, log: (level, m) => console.error(`[${level}] ${m}`) })
    if (!result.ok) failed++
    console.log(JSON.stringify({ surahs: job.surahsAr, ...result }))
  }
  dispose()
  console.error(`${jobs.length - failed}/${jobs.length} rendered → ${outputDir}`)
  return failed ? 1 : 0
}

app.whenReady().then(main).then((code) => { app.exit(code) }, (e) => { console.error(e); app.exit(1) })
