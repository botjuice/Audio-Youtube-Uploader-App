import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} }, BrowserWindow: class {}, nativeImage: {} }))
import { audioDir, bucketPeaks, isInside, previewFilePath, sweepAudioPreviews } from './audio'

describe('bucketPeaks', () => {
  it('returns one [min, max] pair per bucket in −1…1, and zeros for no samples', () => {
    const s = new Int16Array([0, 16384, -32768, 8192, 0, 0, 100, -100])
    expect(bucketPeaks(s, 2)).toEqual([-1, 0.5, -100 / 32768, 100 / 32768])
    expect(bucketPeaks(new Int16Array(0), 3)).toEqual([0, 0, 0, 0, 0, 0])
  })
  it('copes with more buckets than samples', () => {
    const out = bucketPeaks(new Int16Array([32767, -32768]), 4)
    expect(out).toHaveLength(8)
    expect(Math.max(...out)).toBeCloseTo(1, 3)
    expect(Math.min(...out)).toBe(-1)
  })
})

describe('the preview folder is a cache with a size limit', () => {
  const library = mkdtempSync(join(tmpdir(), 'yj-previews-'))
  afterAll(() => rmSync(library, { recursive: true, force: true }))
  const dir = audioDir(library)
  /** A file of `kb` kilobytes last written `minutesAgo` minutes ago. */
  const file = (name: string, kb: number, minutesAgo: number) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), Buffer.alloc(kb * 1024))
    const at = new Date(Date.now() - minutesAgo * 60_000)
    utimesSync(join(dir, name), at, at)
  }
  it('drops what is older than a week, then the oldest renders (with their .json) until it fits; fresh renders stay', async () => {
    const day = 24 * 60
    file('old.flac', 10, 8 * day); file('old.json', 1, 8 * day)
    file('a.flac', 100, 3 * day); file('a.json', 1, 3 * day)
    file('b.flac', 100, 2 * day); file('b.json', 1, 2 * day)
    file('c.flac', 100, 1 * day); file('c.json', 1, 1 * day)
    file('fresh.flac', 400, 5)                       // may be playing or on its way into a video
    file('x-overview.json', 50, 3 * day)             // not a render: only its age counts
    file('notes.txt', 1, 30 * day)                   // not the cache's file
    const r = await sweepAudioPreviews(library, 7 * day * 60_000, 350 * 1024)
    expect(readdirSync(dir).sort()).toEqual(['fresh.flac', 'notes.txt', 'x-overview.json'])
    expect(r.removed).toBe(8)
    expect(existsSync(join(dir, 'fresh.flac'))).toBe(true)
    // under the limit: nothing more goes
    expect((await sweepAudioPreviews(library, 7 * day * 60_000, 600 * 1024)).removed).toBe(0)
  })
  it('a folder that is not there is not an error', async () => {
    expect(await sweepAudioPreviews(join(library, 'nowhere'))).toEqual({ removed: 0, bytes: 0 })
  })
})

describe('only preview files may be streamed to the window', () => {
  it('accepts a preview file on Windows, where paths use backslashes', () => {
    const dir = 'G:\\My Drive\\Quran Recordings for YT\\.yoosyjoosy\\audio'
    expect(isInside(dir, `${dir}\\cc10a38c28b06af8e510.flac`, path.win32)).toBe(true)
    expect(isInside(dir, 'g:\\my drive\\Quran Recordings for YT\\.yoosyjoosy\\audio\\x.flac', path.win32)).toBe(true) // same folder, other case
    expect(isInside(dir, 'G:\\My Drive\\Quran Recordings for YT\\.yoosyjoosy\\audio-other\\x.flac', path.win32)).toBe(false)
    expect(isInside(dir, 'G:\\My Drive\\Quran Recordings for YT\\secret.txt', path.win32)).toBe(false)
    expect(isInside(dir, 'C:\\Windows\\win.ini', path.win32)).toBe(false) // another drive
    expect(isInside(dir, dir, path.win32)).toBe(false)
  })
  it('accepts a preview file on macOS and Linux', () => {
    const dir = '/Users/x/Library/.yoosyjoosy/audio'
    expect(isInside(dir, `${dir}/cc10a38c28b06af8e510.flac`, path.posix)).toBe(true)
    expect(isInside(dir, '/Users/x/Library/.yoosyjoosy/audio-other/x.flac', path.posix)).toBe(false)
    expect(isInside(dir, '/Users/x/Library/.yoosyjoosy/audio/../../a.m4a', path.posix)).toBe(false)
    expect(isInside(dir, '/etc/passwd', path.posix)).toBe(false)
  })
  it('on this machine: a file in the library\'s preview folder passes, anything else is refused', () => {
    const library = join(tmpdir(), 'yj-preview-check')
    const file = join(audioDir(library), 'cc10a38c28b06af8e510.flac')
    expect(previewFilePath(library, file)).toBe(file)
    expect(() => previewFilePath(library, join(library, 'recording.m4a'))).toThrow('Not a preview file')
    expect(() => previewFilePath(library, join(audioDir(library), '..', '..', 'recording.m4a'))).toThrow('Not a preview file')
  })
})
