import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: class {}, nativeImage: {} }))
import { DEFAULT_SURAHS } from '@core/surahs'
import { buildThumbnailJob, fontPathsInRules, isoDate, sampleJobForReciter, styleForRecord } from './thumbnails'
import { WORST_CASE_SAMPLE } from '@core/thumb-rules'
import { WORST_CASE } from '../plugins/thumbnail/index'

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
  it('attaches the style the rules resolve, and omits it when there is none', () => {
    const parsed = { date: '1.1.2025', prayer: 'Taraweeh', reciter: null, surahs: ['Mulk'], keywords: [] }
    const rules = [{ id: 't', enabled: true, conditions: [{ kind: 'prayer' as const, value: 'Taraweeh', negate: false }], style: { frame: { width: 4 } }, sample: { folder: '', surahsAr: ['الملك'], prayer: 'Isha', date: '2025-01-01' } }]
    const rec = { reciterKey: 'x', tokens: { prayer: 'Taraweeh', surahs: ['Mulk'], keywords: [], leftovers: [], date: null, dateDirty: false, reciter: null }, playlists: { auto: [], final: [] } }
    const { base: rule, style } = styleForRecord(rec, rules, DEFAULT_SURAHS)
    expect(rule?.id).toBe('t')
    const r = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: '/p' }, DEFAULT_SURAHS, opts, style)
    expect(r.ok && r.job.style).toEqual({ frame: { width: 4 } })
    const none = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: '/p' }, DEFAULT_SURAHS, opts, styleForRecord({ ...rec, tokens: { ...rec.tokens, prayer: 'Isha' } }, rules, DEFAULT_SURAHS).style)
    expect(none.ok && !('style' in none.job)).toBe(true)
  })
  it('a rule photo replaces the reciter photo in the job', () => {
    const parsed = { date: '1.1.2025', prayer: 'Fajr', reciter: null, surahs: ['Mulk'], keywords: [] }
    const r = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: '/p/reciter.jpg' }, DEFAULT_SURAHS, opts, undefined, '/lib/.yoosyjoosy/thumb-photos/rule-1.png')
    expect(r.ok && r.job.photoPath).toBe('/lib/.yoosyjoosy/thumb-photos/rule-1.png')
    const noPhotoReciter = buildThumbnailJob({ fileName: 'x', parsed }, { nameAr: 'a', imagePath: null }, DEFAULT_SURAHS, opts, undefined, '/lib/x.png')
    expect(noPhotoReciter.ok && noPhotoReciter.job.photoPath).toBe('/lib/x.png')
  })
  it('collects custom font paths from rules, ignoring bundled ids', () => {
    const mk = (style: object) => ({ id: 'x', enabled: true, conditions: [], style, sample: { folder: '', surahsAr: ['x'], prayer: 'Isha', date: '2025-01-01' } })
    const paths = fontPathsInRules([mk({ reciter: { font: '/lib/.yoosyjoosy/fonts/a.ttf' }, meta: { font: 'amiri' } }), mk({ meta: { font: '/lib/.yoosyjoosy/fonts/b.otf' } }), mk({})])
    expect([...paths].sort()).toEqual(['/lib/.yoosyjoosy/fonts/a.ttf', '/lib/.yoosyjoosy/fonts/b.otf'])
  })
  it("the editor's worst-case sample is the plugin's own worst case", () => {
    expect(WORST_CASE_SAMPLE).toEqual({ surahsAr: WORST_CASE.surahsAr, prayer: WORST_CASE.prayer, date: WORST_CASE.date })
  })
  it('reciter sample job respects the prefix option', () => {
    expect(sampleJobForReciter({ nameAr: 'x', imagePath: '/p' }, { enabled: true, sheikhPrefix: false })?.options.sheikhPrefix).toBe(false)
    expect(sampleJobForReciter({ nameAr: null, imagePath: '/p' }, opts)).toBeNull()
  })
})
