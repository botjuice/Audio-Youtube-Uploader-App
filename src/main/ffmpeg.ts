import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import ffmpegStatic from 'ffmpeg-static'

/** ffmpeg-static ships the binary inside node_modules; in a packaged app it lives in app.asar.unpacked. */
export function ffmpegPath(): string | null {
  const p = ffmpegStatic as unknown as string | null
  return p ? p.replace('app.asar', 'app.asar.unpacked') : null
}

export async function ffmpegAvailable(): Promise<boolean> {
  const p = ffmpegPath()
  if (!p) return false
  return fs.access(p).then(() => true, () => false)
}

const DURATION_RE = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
const OUT_TIME_RE = /out_time_ms=(\d+)/g

export interface EncodeOptions {
  audio: string
  image: string
  output: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

/**
 * Still image + audio → 1280×720 H.264/AAC MP4. Writes to `<output>.part` and renames on success,
 * so an interrupted encode never leaves a plausible-looking .mp4 behind.
 */
export function encodeVideo(o: EncodeOptions): Promise<void> {
  const bin = ffmpegPath()
  if (!bin) return Promise.reject(new Error('FFmpeg binary not found in this build'))
  const part = `${o.output}.part.mp4`
  const args = [
    '-y', '-hide_banner', '-nostats', '-progress', 'pipe:1',
    '-loop', '1', '-framerate', '2', '-i', o.image,
    '-i', o.audio,
    '-c:v', 'libx264', '-tune', 'stillimage', '-preset', 'medium', '-r', '2',
    '-vf', "scale='min(1280,iw*720/ih)':'min(720,ih*1280/iw)':force_original_aspect_ratio=decrease,pad=1280:720:(1280-iw)/2:(720-ih)/2:color=black,format=yuv420p",
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-shortest',
    '-f', 'mp4', part,
  ]
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let durationMs = 0
    let stderr = ''
    const onAbort = () => child.kill()
    o.signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
      if (stderr.length > 20_000) stderr = stderr.slice(-10_000)
      if (!durationMs) {
        const m = DURATION_RE.exec(stderr)
        if (m) durationMs = (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
      }
    })
    child.stdout.on('data', (b: Buffer) => {
      if (!durationMs || !o.onProgress) return
      for (const m of b.toString().matchAll(OUT_TIME_RE)) {
        const ms = Number(m[1]) / 1000
        o.onProgress(Math.max(0, Math.min(99, Math.round((ms / durationMs) * 100))))
      }
    })
    child.on('error', reject)
    child.on('close', async (code) => {
      o.signal?.removeEventListener('abort', onAbort)
      if (o.signal?.aborted) { await fs.rm(part, { force: true }); return reject(new Error('Cancelled')) }
      if (code !== 0) {
        await fs.rm(part, { force: true })
        const tail = stderr.trim().split('\n').slice(-4).join(' · ')
        return reject(new Error(`FFmpeg exited with code ${code}: ${tail}`))
      }
      try { await fs.rename(part, o.output); o.onProgress?.(100); resolve() } catch (e) { reject(e) }
    })
  })
}
