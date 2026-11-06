import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: class {}, nativeImage: {} }))
import { DEFAULT_SURAHS } from '@core/surahs'
import { buildThumbnailJob, isoDate, sampleJobForReciter } from './thumbnails'

const opts = { enabled: true, sheikhPrefix: true }
describe('thumbnail job builder', () => {
  it('converts the filename date and translates surah spellings', () => {
    expect(isoDate('5.2.2025')).toBe('2025-02-05')
    const r = buildThumbnailJob({ fileName: 'x', parsed: { date: '23.12.2024', prayer: 'Isha', reciter: null, surahs: ['Dukhan', 'Thariat'], keywords: [] } },
      { nameAr: 'عبدالله الموسى', imagePath: '/p/photo.jpg' }, DEFAULT_SURAHS, opts)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.job).toEqual({ reciterNameAr: 'عبدالله الموسى', photoPath: '/p/photo.jpg', surahsAr: ['الدخان', 'الذاريات'], prayer: 'Isha', date: '2024-12-23', options: { sheikhPrefix: true, template: 'default' } })
  })
  it('explains missing name / photo / parse', () => {
    expect(buildThumbnailJob({ fileName: 'x', parsed: null }, { nameAr: 'a', imagePath: '/p' }, DEFAULT_SURAHS, opts)).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(buildThumbnailJob({ fileName: 'x', parsed: { date: '1.1.2025', prayer: 'Fajr', reciter: null, surahs: ['Mulk'], keywords: [] } }, { nameAr: null, imagePath: '/p' }, DEFAULT_SURAHS, opts)).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(buildThumbnailJob({ fileName: 'x', parsed: { date: '1.1.2025', prayer: 'Fajr', reciter: null, surahs: ['Mulk'], keywords: [] } }, { nameAr: 'a', imagePath: null }, DEFAULT_SURAHS, opts)).toMatchObject({ ok: false, reason: 'PHOTO_UNREADABLE' })
  })
  it('reciter sample job respects the prefix option', () => {
    expect(sampleJobForReciter({ nameAr: 'x', imagePath: '/p' }, { enabled: true, sheikhPrefix: false })?.options.sheikhPrefix).toBe(false)
    expect(sampleJobForReciter({ nameAr: null, imagePath: '/p' }, opts)).toBeNull()
  })
})
