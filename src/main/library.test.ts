import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmp },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const tmp = mkdtempSync(join(tmpdir(), 'yj-'))
const lib = join(tmp, 'Recordings')
const R = 'Abdullah Al Mousa'
const P = 'AbdullahAlMousa'

beforeAll(() => {
  mkdirSync(join(lib, R), { recursive: true })
  writeFileSync(join(lib, R, 'photo.png'), Buffer.from([137, 80, 78, 71]))
  for (const f of [`${P}IshaMulk-01.03.2025.m4a`, `${P}IshaFINALmuminoon-02.03.2025.m4a`, `${P}QAF-5.11.2024.m4a`, `${P}FajrYaseen-03.03.2025.mp3`])
    writeFileSync(join(lib, R, f), 'audio')
  writeFileSync(join(lib, R, `${P}FajrYaseen-03.03.2025.mp3.uploaded`), JSON.stringify({ video_id: 'abc12345678', title: 'x', uploaded_at: '2025-03-03T00:00:00Z' }))
  writeFileSync(join(lib, R, `${P}IshaEmpty-04.03.2025.m4a`), '')
  mkdirSync(join(lib, 'Not A Reciter'))  // no audio → ignored
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('scanLibrary (integration)', () => {
  it('classifies every file with a reason and builds titles once the reciter has a name', async () => {
    const { openLibraryStore } = await import('./store')
    const { scanLibrary, renameRecordFiles } = await import('./library')
    const store = await openLibraryStore(lib)

    let snap = await scanLibrary(lib, store)
    expect(snap.reciters.map((r) => r.folder)).toEqual([R])
    const by = (n: string) => snap.records.find((r) => r.fileName.startsWith(n))!
    expect(by(`${P}IshaMulk`).status).toBe('error')
    expect(by(`${P}IshaMulk`).reason).toBe('NO_RECITER_NAME')

    await store.reciters.update((d) => { d[R] = { nameAr: 'عبدالله الموسى' } })
    snap = await scanLibrary(lib, store)
    expect(by(`${P}IshaMulk`).status).toBe('ready')
    expect(by(`${P}IshaMulk`).title).toBe('عبدالله الموسى | سورة الملك - صلاة العشاء 01.03.2025')
    expect(by(`${P}IshaFINAL`).status).toBe('fix')
    expect(by(`${P}IshaFINAL`).suggestion).toBe(`${P}IshaMuminoon-02.03.2025.m4a`)
    expect(by(`${P}QAF`).reason).toBe('NO_PRAYER')
    expect(by(`${P}FajrYaseen`).status).toBe('uploaded')
    expect(by(`${P}FajrYaseen`).videoId).toBe('abc12345678')
    expect(by(`${P}IshaEmpty`).reason).toBe('ZERO_BYTES')
    expect(snap.reciters[0]!.uploaded).toBe(1)
    expect(snap.reciters[0]!.imagePath).toContain('photo.png')

    // rename moves sidecars too
    const audio = join(lib, R, `${P}FajrYaseen-03.03.2025.mp3`)
    writeFileSync(audio.replace(/\.mp3$/, '.mp4'), 'video')
    const target = await renameRecordFiles(audio, `${P}FajrYasin-03.03.2025.mp3`)
    expect(existsSync(target)).toBe(true)
    expect(existsSync(`${target}.uploaded`)).toBe(true)
    expect(existsSync(target.replace(/\.mp3$/, '.mp4'))).toBe(true)
    expect(existsSync(audio)).toBe(false)
  })
})
