import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmp }, safeStorage: { isEncryptionAvailable: () => false } }))

const tmp = mkdtempSync(join(tmpdir(), 'yj-'))
const lib = join(tmp, 'Recordings')
const R = 'Abdullah Al Mousa', P = 'AbdullahAlMousa'
const old = new Date(Date.now() - 60_000)
const put = (rel: string, content = 'audio') => { const p = join(lib, rel); writeFileSync(p, content); utimesSync(p, old, old); return p }

beforeAll(() => {
  mkdirSync(join(lib, R), { recursive: true }); mkdirSync(join(lib, 'Mishary'), { recursive: true })
  writeFileSync(join(lib, R, 'photo.png'), Buffer.from([137, 80, 78, 71]))
  put(`${R}/${P}IshaMulk-01.03.2025.m4a`)
  put(`${R}/${P}IshaFINALmuminoon-02.03.2025.m4a`)
  put(`${R}/${P}QAF-5.11.2024.m4a`)
  put(`${R}/${P}FajrYaseen-03.03.2025.mp3`)
  writeFileSync(join(lib, R, `${P}FajrYaseen-03.03.2025.mp3.uploaded`), JSON.stringify({ video_id: 'abc12345678', title: 'x', uploaded_at: '2025-03-03T00:00:00Z' }))
  put(`${R}/${P}IshaEmpty-04.03.2025.m4a`, '')
  // root-level files
  put(`MisharyFajrMulk-05.03.2025.m4a`)                      // → auto-filed into Mishary/
  writeFileSync(join(lib, `MisharyFajrMulk-05.03.2025.m4a.uploaded`), '{"video_id":"zzz"}')
  put(`IshaBaqarah-06.03.2025.m4a`)                           // no reciter anywhere → NO_RECITER
  put(`${R}/MisharyIshaKahf-07.03.2025.m4a`)                   // wrong folder → moves to Mishary/
  put(`Mishary/${P}IshaNas-08.03.2025.m4a`)                    // wrong folder, but conflict at destination
  put(`${R}/${P}IshaNas-08.03.2025.m4a`)
  writeFileSync(join(lib, 'MisharyIshaFil-09.03.2025.m4a'), 'fresh')   // recent mtime → must NOT move yet
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('scanLibrary (vocabulary model + auto-filing)', () => {
  it('files recordings by reciter, keeps sidecars and state, respects conflicts and fresh files', async () => {
    const { openLibraryStore } = await import('./store')
    const { scanLibrary } = await import('./library')
    const store = await openLibraryStore(lib)
    await store.reciters.update((d) => { d[R] = { nameAr: 'عبدالله الموسى' }; d['Mishary'] = { nameAr: 'مشاري' } })
    await store.records.update((d) => { d[`/MisharyFajrMulk-05.03.2025.m4a`] = { titleOverride: 'kept' } })

    const snap = await scanLibrary(lib, store)
    const by = (n: string) => snap.records.find((r) => r.fileName.startsWith(n))!

    // moves
    expect(snap.moves.map((m) => m.newId).sort()).toEqual(['Mishary/MisharyFajrMulk-05.03.2025.m4a', 'Mishary/MisharyIshaKahf-07.03.2025.m4a'])
    expect(existsSync(join(lib, 'Mishary', 'MisharyFajrMulk-05.03.2025.m4a.uploaded'))).toBe(true)   // sidecar followed
    expect(store.records.get()['Mishary/MisharyFajrMulk-05.03.2025.m4a']?.titleOverride).toBe('kept')  // state followed
    expect(by('MisharyFajrMulk').status).toBe('uploaded')
    expect(by('MisharyIshaKahf').reciterFolder).toBe('Mishary')
    expect(by('MisharyIshaKahf').status).toBe('error'); expect(by('MisharyIshaKahf').reason).toBe('NO_IMAGE')  // Mishary has no photo yet

    // not moved
    expect(by('IshaBaqarah').reason).toBe('NO_RECITER')
    const conflict = snap.records.find((r) => r.id === `Mishary/${P}IshaNas-08.03.2025.m4a`)!
    expect(conflict.reason).toBe('FILE_CONFLICT')
    expect(by('MisharyIshaFil').reciterFolder).toBe('')      // too fresh — left at root this scan
    expect(by('MisharyIshaFil').reason).toBe('WRONG_FOLDER')

    // classification
    expect(by(`${P}IshaMulk`).status).toBe('ready')
    expect(by(`${P}IshaMulk`).title).toBe('عبدالله الموسى | سورة الملك - صلاة العشاء 01.03.2025')
    expect(by(`${P}IshaFINAL`).fixable).toBe(true)
    expect(by(`${P}IshaFINAL`).suggestion).toBe(`${P}IshaMuminoon-02.03.2025.m4a`)
    expect(by(`${P}QAF`).reason).toBe('NO_PRAYER')
    expect(by(`${P}FajrYaseen`).videoId).toBe('abc12345678')
    expect(by(`${P}IshaEmpty`).reason).toBe('ZERO_BYTES')

    // a registered keyword turns the leftover into a tag with its playlists
    await store.rules.update((d) => { d.keywords = [{ name: 'final', playlistIds: ['PL_F', 'PL_G'] }] })
    const snap2 = await scanLibrary(lib, store)
    const fin = snap2.records.find((r) => r.fileName.startsWith(`${P}IshaFINAL`))!
    expect(fin.status).toBe('ready'); expect(fin.tokens.keywords).toEqual(['final']); expect(fin.playlists.final).toEqual(['PL_F', 'PL_G'])
  })
})
