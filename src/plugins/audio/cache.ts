import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface FileStat { size: number; mtimeMs: number }

/** Stable key: the recording's identity, everything that shapes the output (graph text, extra files), and the plugin's render version. */
export function cacheKey(audioPath: string, stat: FileStat, chainVersion: number, shape: Record<string, unknown>): string {
  return createHash('sha1')
    .update(JSON.stringify({ v: chainVersion, audio: [audioPath, stat.size, Math.round(stat.mtimeMs)], ...shape }))
    .digest('hex').slice(0, 20)
}

export const audioFile = (dir: string, key: string) => join(dir, `${key}.flac`)
export const metaFile = (dir: string, key: string) => join(dir, `${key}.json`)

export async function nonEmpty(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile() && s.size > 0, () => false)
}

/** Unique temp name per call, so two jobs with the same key never write the same part file. */
export const partFile = (final: string) => `${final}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part.flac`

export async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}-${Math.random().toString(36).slice(2, 8)}.part`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, path)
}
