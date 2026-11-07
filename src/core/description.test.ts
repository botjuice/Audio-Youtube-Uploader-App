import { describe, expect, it } from 'vitest'
import { buildDescription, hijriDate } from './description'

const parsed = { date: '05.02.2025', prayer: 'Isha', reciter: null, surahs: ['Dukhan', 'Thariat'], keywords: [] }
describe('video description', () => {
  it('converts the filename date to the same Hijri wording as the thumbnail', () => {
    expect(hijriDate('05.02.2025')).toBe('٦ شعبان ١٤٤٦ هـ')
    expect(hijriDate('01.03.2025')).toBe('١ رمضان ١٤٤٦ هـ')
    expect(hijriDate('junk')).toBe('junk')
  })
  it('is the title, then the thumbnail info, then the default text', () => {
    const d = buildDescription({ title: 'T', reciterAr: 'عبدالله الموسى', sheikhPrefix: true, parsed, extra: 'Subscribe!' })
    expect(d.split('\n')).toEqual(['T', '', 'الشيخ عبدالله الموسى', 'سورة الدخان و الذاريات', 'صلاة العشاء · ٦ شعبان ١٤٤٦ هـ', '', 'Subscribe!'])
  })
  it('respects the prefix setting and omits an empty default text', () => {
    const d = buildDescription({ title: 'T', reciterAr: 'عبدالله الموسى', sheikhPrefix: false, parsed: { ...parsed, surahs: ['Mulk'] }, extra: '  ' })
    expect(d).toBe('T\n\nعبدالله الموسى\nسورة الملك\nصلاة العشاء · ٦ شعبان ١٤٤٦ هـ')
    expect(buildDescription({ title: 'T', reciterAr: 'الشيخ فلان', sheikhPrefix: true, parsed })).toContain('\nالشيخ فلان\n')
  })
})
