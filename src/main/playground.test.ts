import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: class {}, nativeImage: {} }))
import { buildPlaygroundJob, surahOptions } from './thumbnails'

const rec = { nameAr: 'عبدالله الموسى', imagePath: '/p/photo.jpg' }
describe('thumbnail playground', () => {
  it('builds the same job shape as the pipeline, 1–3 surahs', () => {
    const r = buildPlaygroundJob({ folder: 'A', surahsAr: ['البقرة', 'آل عمران', 'النساء'], prayer: 'Taraweeh', date: '2025-03-01', sheikhPrefix: false }, rec)
    expect(r.ok).toBe(true); if (r.ok) expect(r.job.surahsAr).toHaveLength(3)
    expect(buildPlaygroundJob({ folder: 'A', surahsAr: [], prayer: 'Isha', date: '2025-03-01', sheikhPrefix: true }, rec)).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(buildPlaygroundJob({ folder: 'A', surahsAr: ['a', 'b', 'c', 'd'], prayer: 'Isha', date: '2025-03-01', sheikhPrefix: true }, rec)).toMatchObject({ ok: false })
    expect(buildPlaygroundJob({ folder: 'A', surahsAr: ['البقرة'], prayer: 'Dhuhr', date: '2025-03-01', sheikhPrefix: true }, rec)).toMatchObject({ ok: false, reason: 'UNKNOWN_PRAYER' })
    expect(buildPlaygroundJob({ folder: 'A', surahsAr: ['البقرة'], prayer: 'Isha', date: '01.03.2025', sheikhPrefix: true }, rec)).toMatchObject({ ok: false, reason: 'BAD_DATE' })
    expect(buildPlaygroundJob({ folder: 'A', surahsAr: ['البقرة'], prayer: 'Isha', date: '2025-03-01', sheikhPrefix: true }, undefined)).toMatchObject({ ok: false })
  })
  it('lists all 114 surahs in order with Latin labels', () => {
    const o = surahOptions()
    expect(o).toHaveLength(114); expect(o[0]!.n).toBe(1); expect(o[1]!.ar).toBe('البقرة'); expect(o[1]!.label.toLowerCase()).toContain('baqara')
    expect(o.every((x) => x.label.length > 0)).toBe(true)
  })
})
