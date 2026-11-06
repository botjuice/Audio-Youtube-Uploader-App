import { describe, expect, it } from 'vitest'
import coreSurahs from '../../core/surahs.json'
import { PRAYER_AR as CORE_PRAYERS } from '../../core/prayers'
import { checkJob, hijriDate, normaliseArabic, parseIsoDate, PRAYER_AR, surahNumber } from './job'
import { SURAHS_AR } from './surahs'
import type { ThumbnailJob } from './types'

const job = (over: Partial<ThumbnailJob> = {}): ThumbnailJob => ({
  reciterNameAr: 'عبدالله الموسى', photoPath: '/x/photo.jpg', surahsAr: ['يوسف'], prayer: 'Fajr', date: '2025-02-05',
  options: { sheikhPrefix: true, template: 'default' }, ...over,
})

describe('surah table', () => {
  it('has 114 names in order, matching the app dictionary', () => {
    expect(SURAHS_AR).toHaveLength(114)
    expect([...new Set(Object.values(coreSurahs as Record<string, string>))]).toEqual([...SURAHS_AR])
  })
  it('stays unambiguous after normalisation', () => {
    expect(new Set(SURAHS_AR.map(normaliseArabic)).size).toBe(114)
  })
  it('resolves every Arabic value in the app dictionary', () => {
    for (const ar of Object.values(coreSurahs as Record<string, string>)) expect(surahNumber(ar), ar).not.toBeNull()
  })
  it('knows the numbers', () => {
    expect(surahNumber('الفاتحة')).toBe(1)
    expect(surahNumber('يوسف')).toBe(12)
    expect(surahNumber('الأحزاب')).toBe(33)
    expect(surahNumber('المنافقون')).toBe(63)
    expect(surahNumber('الناس')).toBe(114)
  })
  it('tolerates diacritics, alef forms and a «سورة» prefix', () => {
    expect(surahNumber('سورة يُوسُف')).toBe(12)
    expect(surahNumber('الاحزاب')).toBe(33)
    expect(surahNumber('  الكهف ')).toBe(18)
    expect(surahNumber('Kahf')).toBeNull()
  })
})

describe('prayers', () => {
  it('matches the app table exactly', () => { expect(PRAYER_AR).toEqual(CORE_PRAYERS) })
})

describe('hijri date', () => {
  it('converts real recording dates (Umm al-Qura, Arabic-Indic digits)', () => {
    expect(hijriDate('2025-03-01')).toBe('١ رمضان ١٤٤٦ هـ')
    expect(hijriDate('2025-02-05')).toBe('٦ شعبان ١٤٤٦ هـ')
    expect(hijriDate('2024-12-28')).toBe('٢٧ جمادى الآخرة ١٤٤٦ هـ')
  })
  it('rejects malformed or impossible dates', () => {
    expect(parseIsoDate('05.02.2025')).toBeNull()
    expect(parseIsoDate('2025-02-30')).toBeNull()
    expect(parseIsoDate('2025-13-01')).toBeNull()
    expect(hijriDate('nope')).toBeNull()
  })
})

describe('checkJob', () => {
  it('builds template data for a good job', () => {
    const r = checkJob(job({ surahsAr: ['الأحزاب', 'المنافقون'], prayer: 'Isha', date: '2025-03-01' }))
    expect(r).toEqual({ ok: true, data: { surahs: [33, 63], reciter_name: 'الشيخ عبدالله الموسى', prayer: 'صلاة العشاء', date: '١ رمضان ١٤٤٦ هـ' } })
  })
  it('honours the prefix option', () => {
    const r = checkJob(job({ options: { sheikhPrefix: false, template: 'default' } }))
    expect(r.ok && r.data.reciter_name).toBe('عبدالله الموسى')
  })
  it('names the reason for each bad input', () => {
    expect(checkJob(job({ reciterNameAr: ' ' }))).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(checkJob(job({ surahsAr: [] }))).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(checkJob(job({ surahsAr: ['يوسف', 'سورة غير موجودة'] }))).toMatchObject({ ok: false, reason: 'UNKNOWN_SURAH' })
    expect(checkJob(job({ prayer: 'Dhuhr' }))).toMatchObject({ ok: false, reason: 'UNKNOWN_PRAYER' })
    expect(checkJob(job({ date: '2025-02-31' }))).toMatchObject({ ok: false, reason: 'BAD_DATE' })
    expect(checkJob(job({ options: { sheikhPrefix: true, template: 'fancy' as 'default' } }))).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
  })
})
