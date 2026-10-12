import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmp } }))
const tmp = mkdtempSync(join(tmpdir(), 'yj-ff-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('ffmpeg (bundled binary, real encode)', () => {
  it('encodes a still image + 2s of audio into a 1280x720 mp4 with progress', async () => {
    const { ffmpegPath, encodeVideo, ffmpegAvailable } = await import('./ffmpeg')
    expect(await ffmpegAvailable()).toBe(true)
    const bin = ffmpegPath()!
    const audio = join(tmp, 'tone.m4a')
    execFileSync(bin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', audio], { stdio: 'ignore' })
    const out = join(tmp, 'out.mp4')
    const seen: number[] = []
    await encodeVideo({ audio, image: resolve('resources/icon.png'), output: out, onProgress: (p) => seen.push(p) })
    expect(existsSync(out)).toBe(true)
    expect(statSync(out).size).toBeGreaterThan(10_000)
    expect(seen.at(-1)).toBe(100)
    const probe = spawnSync(bin, ['-i', out, '-f', 'null', '-'], { encoding: 'utf8' }).stderr
    expect(probe).toMatch(/1280x720/)
  }, 60_000)
})
