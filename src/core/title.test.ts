import { describe, expect, it } from 'vitest'
import { buildTitle } from './title'

describe('buildTitle', () => {
  it('matches the agreed format', () => {
    const t = buildTitle('عبدالله الموسى', { prayer: 'Isha', surahs: ['Ahzab', 'Munafiqoon'], date: '01.03.2025' })
    expect(t).toBe('عبدالله الموسى | سورة الأحزاب و المنافقون - صلاة العشاء 01.03.2025')
  })
  it('falls back to the raw name for unknown surahs', () => {
    expect(buildTitle('X', { prayer: 'Fajr', surahs: ['Xyzzy'], date: '01.01.2025' })).toContain('سورة Xyzzy')
  })
})
